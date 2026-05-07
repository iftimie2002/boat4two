import {
  getGoogleAccessToken,
  getPrimaryGoogleCalendarId
} from "./_google.js";

function getDescriptionValue(description, key) {
  if (!description) return "";
  const regex = new RegExp(`^${key}:(.*)$`, "mi");
  const match = description.match(regex);
  return match ? match[1].trim() : "";
}

function isPaidEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const summary = event?.summary || "";

  return (
    privateProps.bookingType === "paid" ||
    privateProps.paymentStatus === "paid" ||
    summary.startsWith("PAID - ")
  );
}

function isHoldEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const summary = event?.summary || "";
  const description = event?.description || "";
  const bookingType = privateProps.bookingType || "";

  if (isPaidEvent(event) || (bookingType && bookingType !== "hold")) {
    return false;
  }

  return (
    bookingType === "hold" ||
    privateProps.isHold === "true" ||
    (!privateProps.paymentStatus && Boolean(privateProps.holdId)) ||
    summary.startsWith("[HOLD]") ||
    /HOLD_ID:/i.test(description)
  );
}

function isPendingPaymentEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};

  if (isPaidEvent(event)) {
    return false;
  }

  return (
    privateProps.bookingType === "pending_payment" ||
    privateProps.paymentStatus === "pending"
  );
}

function isStaleUnpaidArtifactEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const summary = event?.summary || "";
  const bookingType = privateProps.bookingType || "";

  if (isPaidEvent(event)) {
    return false;
  }

  return (
    bookingType === "released_hold" ||
    bookingType === "expired_hold" ||
    bookingType === "payment_expired" ||
    bookingType === "payment_cancelled" ||
    bookingType === "payment_rollback" ||
    summary.startsWith("RELEASED HOLD - ") ||
    summary.startsWith("EXPIRED HOLD - ") ||
    summary.startsWith("EXPIRED PAYMENT - ") ||
    summary.startsWith("PAYMENT CANCELLED - ") ||
    summary.startsWith("PAYMENT ROLLBACK - ")
  );
}

function isSlotLockEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const summary = event?.summary || "";

  return (
    privateProps.bookingType === "slot_lock" ||
    summary.startsWith("BOOKING LOCK - ") ||
    summary.startsWith("BOOKING LOCK RELEASED - ")
  );
}

function slotLockNeedsCleanup(event, nowMs) {
  const privateProps = event?.extendedProperties?.private || {};
  const expiresAt = privateProps.slotLockExpiresAt || "";

  if (!isSlotLockEvent(event)) {
    return false;
  }

  if (privateProps.slotLockState !== "active") {
    return true;
  }

  if (!expiresAt) {
    return true;
  }

  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isNaN(expiresAtMs) || nowMs >= expiresAtMs;
}

function getHoldId(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.holdId ||
    getDescriptionValue(description, "HOLD_ID") ||
    ""
  );
}

function getHoldExpiresAt(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.holdExpiresAt ||
    getDescriptionValue(description, "HOLD_EXPIRES_AT") ||
    ""
  );
}

function getPaymentPendingExpiresAt(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.paymentPendingExpiresAt ||
    getDescriptionValue(description, "Payment pending expires at") ||
    ""
  );
}

function getEventKey(event) {
  const privateProps = event?.extendedProperties?.private || {};
  return {
    eventId: event?.id || "",
    holdId: getHoldId(event),
    bookingType: privateProps.bookingType || "",
    tour: privateProps.tour || "",
    date: privateProps.date || "",
    time: privateProps.time || "",
    summary: event?.summary || ""
  };
}

async function listEvents(env, accessToken, extraParams = {}) {
  const primaryCalendarId = getPrimaryGoogleCalendarId(env);
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(primaryCalendarId)}/events`
  );

  url.searchParams.set("singleEvents", "false");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "2500");

  Object.entries(extraParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Failed to list calendar events");
  }

  return data.items || [];
}

async function deleteCalendarEvent(env, accessToken, eventId) {
  const primaryCalendarId = getPrimaryGoogleCalendarId(env);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(primaryCalendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 404 || response.status === 410 || response.status === 204) {
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Failed to delete stale booking event");
  }
}

async function getCandidateBookingEvents(env, accessToken) {
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const events = await listEvents(env, accessToken, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString()
  });

  return events.filter((event) =>
    isHoldEvent(event) ||
    isPendingPaymentEvent(event) ||
    isStaleUnpaidArtifactEvent(event) ||
    isSlotLockEvent(event)
  );
}

export async function cleanupStaleBookingArtifacts(env, options = {}) {
  const accessToken = options.accessToken || await getGoogleAccessToken(env);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const bookingEvents = await getCandidateBookingEvents(env, accessToken);

  const expiredBookingEvents = bookingEvents.filter((event) => {
    if (isStaleUnpaidArtifactEvent(event)) {
      return true;
    }

    if (slotLockNeedsCleanup(event, nowMs)) {
      return true;
    }

    const expiresAt = isPendingPaymentEvent(event)
      ? getPaymentPendingExpiresAt(event)
      : getHoldExpiresAt(event);

    if (!expiresAt) return false;

    const expiresAtMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expiresAtMs)) return false;

    return nowMs >= expiresAtMs;
  });

  const deletedEvents = [];

  for (const event of expiredBookingEvents) {
    await deleteCalendarEvent(env, accessToken, event.id);
    deletedEvents.push(getEventKey(event));
  }

  return {
    scanned: bookingEvents.length,
    expiredFound: expiredBookingEvents.length,
    deletedCount: deletedEvents.length,
    deletedEvents
  };
}

export async function bestEffortCleanupStaleBookingArtifacts(env, accessToken) {
  try {
    return await cleanupStaleBookingArtifacts(env, { accessToken });
  } catch (error) {
    console.warn("Stale booking cleanup skipped", error);
    return {
      scanned: 0,
      expiredFound: 0,
      deletedCount: 0,
      deletedEvents: [],
      skipped: true,
      error: error?.message || "Cleanup failed"
    };
  }
}
