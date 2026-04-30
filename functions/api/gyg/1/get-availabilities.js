import {
  authorizeGyGRequest,
  buildAvailabilityObject,
  cleanupExpiredGyGReservations,
  enumerateSlots,
  errorResponse,
  getAuthorizedGoogleTokenOrThrow,
  getBusyRanges,
  getGyGProduct,
  slotHasAvailability,
  successResponse
} from "../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authFailure = authorizeGyGRequest(request, env);

  if (authFailure) {
    return authFailure;
  }

  try {
    const url = new URL(request.url);
    const productId = url.searchParams.get("productId") || "";
    const fromDateTime = url.searchParams.get("fromDateTime") || "";
    const toDateTime = url.searchParams.get("toDateTime") || "";

    if (!productId || !fromDateTime || !toDateTime) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "productId, fromDateTime, and toDateTime are required."
      );
    }

    const product = getGyGProduct(productId);
    if (!product) {
      return errorResponse(
        "INVALID_PRODUCT",
        "This product does not exist or is not currently sellable."
      );
    }

    const fromDate = new Date(fromDateTime);
    const toDate = new Date(toDateTime);

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "fromDateTime and toDateTime must be valid ISO 8601 values."
      );
    }

    if (fromDate > toDate) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "fromDateTime must be before or equal to toDateTime."
      );
    }

    const accessToken = await getAuthorizedGoogleTokenOrThrow(env);

    await cleanupExpiredGyGReservations(
      env,
      accessToken,
      fromDate.toISOString(),
      toDate.toISOString()
    );

    const slots = enumerateSlots(productId, fromDate, toDate);
    const busyRanges = await getBusyRanges(
      env,
      accessToken,
      fromDate.toISOString(),
      toDate.toISOString()
    );

    const availabilities = slots.map((slot) =>
      buildAvailabilityObject(
        slot,
        slotHasAvailability(slot, busyRanges) ? product.participantMax : 0
      )
    );

    return successResponse({
      availabilities
    });
  } catch (error) {
    console.error("GYG get-availabilities failed", error);

    return errorResponse(
      "INTERNAL_SYSTEM_FAILURE",
      error?.message || "Failed to query availability."
    );
  }
}
