import {
  authorizeGyGRequest,
  deleteCalendarEvent,
  errorResponse,
  getAuthorizedGoogleTokenOrThrow,
  getCalendarEventById,
  parseJsonBody,
  successResponse
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

    if (!data?.reservationReference || !data?.gygBookingReference) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "reservationReference and gygBookingReference are required."
      );
    }

    const accessToken = await getAuthorizedGoogleTokenOrThrow(env);
    const event = await getCalendarEventById(env, accessToken, data.reservationReference);

    if (!event) {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation does not exist or has already expired."
      );
    }

    const privateProps = event?.extendedProperties?.private || {};

    if (
      privateProps.source !== "getyourguide" ||
      privateProps.bookingType !== "gyg_reservation" ||
      privateProps.gygBookingReference !== String(data.gygBookingReference || "")
    ) {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation does not exist or is not in a cancellable state."
      );
    }

    await deleteCalendarEvent(env, accessToken, event.id);

    return successResponse({});
  } catch (error) {
    console.error("GYG cancel-reservation failed", error);

    return errorResponse(
      "INTERNAL_SYSTEM_FAILURE",
      error?.message || "Failed to cancel reservation."
    );
  }
}
