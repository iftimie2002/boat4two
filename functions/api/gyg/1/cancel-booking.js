import {
  authorizeGyGRequest,
  deleteCalendarEvent,
  errorResponse,
  findGyGEventByPrivateProperty,
  getAuthorizedGoogleTokenOrThrow,
  getCalendarEventById,
  parseJsonBody,
  successResponse
} from "../_shared.js";
import { queueGyGAvailabilityNotify } from "../_post_change_notify.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authFailure = authorizeGyGRequest(request, env);

  if (authFailure) {
    return authFailure;
  }

  try {
    const body = await parseJsonBody(request);
    const data = body?.data || null;

    if (!data?.bookingReference && !data?.gygBookingReference) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "bookingReference or gygBookingReference is required."
      );
    }

    const accessToken = await getAuthorizedGoogleTokenOrThrow(env);
    let event = data.bookingReference
      ? await getCalendarEventById(env, accessToken, data.bookingReference)
      : null;

    if (!event && data.gygBookingReference) {
      event = await findGyGEventByPrivateProperty(
        env,
        accessToken,
        "gygBookingReference",
        data.gygBookingReference,
        { bookingType: "gyg_booking" }
      );
    }

    if (!event) {
      return errorResponse(
        "INVALID_BOOKING",
        "The booking does not exist."
      );
    }

    const privateProps = event?.extendedProperties?.private || {};

    if (
      privateProps.source !== "getyourguide" ||
      privateProps.bookingType !== "gyg_booking"
    ) {
      return errorResponse(
        "INVALID_BOOKING",
        "The booking does not exist or is not in a cancellable state."
      );
    }

    if (
      data.productId &&
      privateProps.gygProductId !== String(data.productId)
    ) {
      return errorResponse(
        "INVALID_BOOKING",
        "The booking does not match the provided product."
      );
    }

    if (
      data.gygBookingReference &&
      privateProps.gygBookingReference !== String(data.gygBookingReference)
    ) {
      return errorResponse(
        "INVALID_BOOKING",
        "The booking does not match the provided booking reference."
      );
    }

    await deleteCalendarEvent(env, accessToken, event.id);

    queueGyGAvailabilityNotify(context, env, accessToken, {
      tour: privateProps.tour,
      date: privateProps.date,
      reason: "GYG cancel booking"
    });

    return successResponse({});
  } catch (error) {
    console.error("GYG cancel-booking failed", error);

    return errorResponse(
      "INTERNAL_SYSTEM_FAILURE",
      error?.message || "Failed to cancel booking."
    );
  }
}
