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

    if (!data?.bookingReference || !data?.gygBookingReference || !data?.productId) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "bookingReference, gygBookingReference, and productId are required."
      );
    }

    const accessToken = await getAuthorizedGoogleTokenOrThrow(env);
    const event = await getCalendarEventById(env, accessToken, data.bookingReference);

    if (!event) {
      return errorResponse(
        "INVALID_BOOKING",
        "The booking does not exist."
      );
    }

    const privateProps = event?.extendedProperties?.private || {};

    if (
      privateProps.source !== "getyourguide" ||
      privateProps.bookingType !== "gyg_booking" ||
      privateProps.gygProductId !== String(data.productId || "") ||
      privateProps.gygBookingReference !== String(data.gygBookingReference || "")
    ) {
      return errorResponse(
        "INVALID_BOOKING",
        "The booking does not exist or is not in a cancellable state."
      );
    }

    await deleteCalendarEvent(env, accessToken, event.id);

    return successResponse({});
  } catch (error) {
    console.error("GYG cancel-booking failed", error);

    return errorResponse(
      "INTERNAL_SYSTEM_FAILURE",
      error?.message || "Failed to cancel booking."
    );
  }
}
