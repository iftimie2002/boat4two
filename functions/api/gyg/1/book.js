import {
  authorizeGyGRequest,
  buildBookingResponse,
  buildReservationEventBody,
  errorResponse,
  getAuthorizedGoogleTokenOrThrow,
  getCalendarEventById,
  parseJsonBody,
  resolveSlotFromDateTime,
  successResponse,
  updateCalendarEvent,
  validateIndividualBookingItems
} from "../_shared.js";
import { queueGyGAvailabilityNotify } from "../_post_change_notify.js";
import { maybeSendAdminBookingNotificationEmail } from "../../_booking-email.js";

async function sendAndPatchAdminNotification(env, accessToken, event) {
  const emailResult = await maybeSendAdminBookingNotificationEmail(env, event);

  if (!emailResult.shouldPatch || !emailResult.patchPrivateProps) {
    return emailResult;
  }

  const privateProps = event?.extendedProperties?.private || {};
  await updateCalendarEvent(env, accessToken, event.id, {
    extendedProperties: {
      private: {
        ...privateProps,
        ...emailResult.patchPrivateProps
      }
    }
  });

  return emailResult;
}

function queueAdminNotification(context, env, accessToken, event) {
  const promise = sendAndPatchAdminNotification(env, accessToken, event).catch((emailError) => {
    console.error("GYG booking admin notification failed", emailError);
  });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
  }

  return promise;
}

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

    if (!data.reservationReference) {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation reference is missing."
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
    const event = await getCalendarEventById(env, accessToken, data.reservationReference);

    if (!event) {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation does not exist or has expired."
      );
    }

    const privateProps = event?.extendedProperties?.private || {};

    if (privateProps.source !== "getyourguide") {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation does not belong to GetYourGuide."
      );
    }

    if (privateProps.bookingType === "gyg_booking") {
      queueAdminNotification(context, env, accessToken, event);

      return successResponse(
        buildBookingResponse(event.id, data.bookingItems)
      );
    }

    if (privateProps.bookingType !== "gyg_reservation") {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation is not in a bookable state."
      );
    }

    if (
      privateProps.reservationExpiresAt &&
      new Date(privateProps.reservationExpiresAt).getTime() < Date.now()
    ) {
      return errorResponse(
        "INVALID_RESERVATION",
        "The reservation has expired."
      );
    }

    const patchBody = buildReservationEventBody({
      product,
      slot,
      reservationReference: event.id,
      reservationExpiresAt: privateProps.reservationExpiresAt || "",
      gygBookingReference: data.gygBookingReference,
      gygActivityReference: data.gygActivityReference,
      bookingItems: data.bookingItems,
      travelers: data.travelers || [],
      status: "BOOKED"
    });

    delete patchBody.id;

    const bookedEvent = await updateCalendarEvent(
      env,
      accessToken,
      event.id,
      patchBody
    );

    queueGyGAvailabilityNotify(context, env, accessToken, {
      tour: product.tour,
      date: slot.date,
      reason: "GYG book"
    });

    queueAdminNotification(context, env, accessToken, bookedEvent);

    return successResponse(
      buildBookingResponse(event.id, data.bookingItems)
    );
  } catch (error) {
    console.error("GYG book failed", error);

    return errorResponse(
      "INTERNAL_SYSTEM_FAILURE",
      error?.message || "Failed to confirm booking."
    );
  }
}
