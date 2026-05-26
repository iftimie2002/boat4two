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

    if (!data?.reservationReference && !data?.gygBookingReference) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "reservationReference or gygBookingReference is required."
      );
    }

    const accessToken = await getAuthorizedGoogleTokenOrThrow(env);
    let event = data.reservationReference
      ? await getCalendarEventById(env, accessToken, data.reservationReference)
      : null;

    if (!event && data.gygBookingReference) {
      event = await findGyGEventByPrivateProperty(
        env,
        accessToken,
        "gygBookingReference",
        data.gygBookingReference,
        { bookingType: "gyg_reservation" }
      );
    }

    if (!event) {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation does not exist or has already expired."
      );
    }

    const privateProps = event?.extendedProperties?.private || {};

    if (
      privateProps.source !== "getyourguide" ||
      privateProps.bookingType !== "gyg_reservation"
    ) {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation does not exist or is not in a cancellable state."
      );
    }

    if (
      data.gygBookingReference &&
      privateProps.gygBookingReference !== String(data.gygBookingReference)
    ) {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation does not match the provided booking reference."
      );
    }

    await deleteCalendarEvent(env, accessToken, event.id);

    queueGyGAvailabilityNotify(context, env, accessToken, {
      tour: privateProps.tour,
      date: privateProps.date,
      reason: "GYG cancel reservation"
    });

    return successResponse({});
  } catch (error) {
    console.error("GYG cancel-reservation failed", error);

    return errorResponse(
      "INTERNAL_SYSTEM_FAILURE",
      error?.message || "Failed to cancel reservation."
    );
  }
}
