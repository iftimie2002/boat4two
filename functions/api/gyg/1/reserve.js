import {
  GYG_RULES,
  authorizeGyGRequest,
  buildGyGDaySlots,
  buildReservationEventBody,
  cleanupExpiredGyGReservations,
  createCalendarEvent,
  errorResponse,
  getAuthorizedGoogleTokenOrThrow,
  getBusyRanges,
  parseJsonBody,
  resolveSlotFromDateTime,
  slotHasAvailability,
  successResponse,
  validateIndividualBookingItems,
  createGyGReference
} from "../_shared.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authFailure = authorizeGyGRequest(request, env);

  if (authFailure) {
    return authFailure;
  }

  try {
    const body = await parseJsonBody(request);
    const data = body?.data || null;

    if (!data) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "The request body must contain a data object."
      );
    }

    const slotResult = resolveSlotFromDateTime(data.productId, data.dateTime);
    if (slotResult.error) {
      return slotResult.error;
    }

    const { product, slot, requestedTimeMatched } = slotResult;
    const itemValidationFailure = validateIndividualBookingItems(data.bookingItems, product);

    if (itemValidationFailure) {
      return itemValidationFailure;
    }

    const accessToken = await getAuthorizedGoogleTokenOrThrow(env);

    const candidateSlots = requestedTimeMatched ? [slot] : buildGyGDaySlots(data.productId, slot.date);
    const candidateRangeStart = candidateSlots[0]?.start || slot.start;
    const candidateRangeEnd = candidateSlots[candidateSlots.length - 1]?.end || slot.end;

    await cleanupExpiredGyGReservations(
      env,
      accessToken,
      candidateRangeStart.toISOString(),
      candidateRangeEnd.toISOString()
    );

    const busyRanges = await getBusyRanges(
      env,
      accessToken,
      candidateRangeStart.toISOString(),
      candidateRangeEnd.toISOString()
    );

    const slotToReserve = requestedTimeMatched
      ? slot
      : candidateSlots.find((candidateSlot) => slotHasAvailability(candidateSlot, busyRanges)) || null;

    if (!slotToReserve || !slotHasAvailability(slotToReserve, busyRanges)) {
      return errorResponse(
        "NO_AVAILABILITY",
        "This activity is sold out for the requested start time."
      );
    }

    const reservationReference = createGyGReference();
    const reservationExpiration = new Date(
      Date.now() + GYG_RULES.reservationHoldMinutes * 60 * 1000
    );

    await createCalendarEvent(
      env,
      accessToken,
      buildReservationEventBody({
        product,
        slot: slotToReserve,
        reservationReference,
        reservationExpiresAt: reservationExpiration.toISOString(),
        gygBookingReference: data.gygBookingReference,
        gygActivityReference: data.gygActivityReference,
        bookingItems: data.bookingItems,
        status: "RESERVE"
      })
    );

    return successResponse({
      reservationReference,
      reservationExpiration: formatGyGDateTime(reservationExpiration)
    });
  } catch (error) {
    if (error?.status === 409) {
      return errorResponse(
        "NO_AVAILABILITY",
        "This activity is sold out for the requested start time."
      );
    }

    console.error("GYG reserve failed", error);

    return errorResponse(
      "INTERNAL_SYSTEM_FAILURE",
      error?.message || "Failed to place reservation."
    );
  }
}
