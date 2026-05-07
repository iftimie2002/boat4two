import {
  GYG_RULES,
  authorizeGyGRequest,
  buildReservationEventBody,
  cleanupExpiredGyGReservations,
  createCalendarEvent,
  errorResponse,
  formatGyGDateTime,
  getAuthorizedGoogleTokenOrThrow,
  getBusyRanges,
  parseJsonBody,
  resolveSlotFromDateTime,
  slotHasAvailability,
  successResponse,
  validateIndividualBookingItems,
  createGyGReference
} from "../_shared.js";
import { bestEffortCleanupStaleBookingArtifacts } from "../../_stale-bookings.js";

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

    const { product, slot } = slotResult;
    const itemValidationFailure = validateIndividualBookingItems(data.bookingItems, product);

    if (itemValidationFailure) {
      return itemValidationFailure;
    }

    const accessToken = await getAuthorizedGoogleTokenOrThrow(env);
    await bestEffortCleanupStaleBookingArtifacts(env, accessToken);

    await cleanupExpiredGyGReservations(
      env,
      accessToken,
      slot.start.toISOString(),
      slot.end.toISOString()
    );

    const busyRanges = await getBusyRanges(
      env,
      accessToken,
      slot.start.toISOString(),
      slot.end.toISOString()
    );

    if (!slotHasAvailability(slot, busyRanges)) {
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
        slot,
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
