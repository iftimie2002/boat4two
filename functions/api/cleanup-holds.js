function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

async function getAccessToken(env) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error("Failed to refresh Google access token");
  }

  return tokenData.access_token;
}

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

async function listEvents(env, accessToken, extraParams = {}) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`
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
    throw new Error("Failed to list calendar events");
  }

  return data.items || [];
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

async function deleteCalendarEvent(env, accessToken, eventId) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 404 || response.status === 410) {
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Failed to delete unpaid booking event");
  }
}

export async function onRequestGet(context) {
  const { env } = context;

  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN ||
    !env.GOOGLE_CALENDAR_ID
  ) {
    return json(
      {
        ok: false,
        error: "Missing required Google environment variables."
      },
      500
    );
  }

  try {
    const accessToken = await getAccessToken(env);
    const bookingEvents = await getCandidateBookingEvents(env, accessToken);
    const nowMs = Date.now();

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

    const expiredBookingIds = [];
    let expiredCount = 0;

    for (const event of expiredBookingEvents) {
      await deleteCalendarEvent(env, accessToken, event.id);
      expiredCount += 1;
      expiredBookingIds.push(getHoldId(event) || event.id);
    }

    return json({
      ok: true,
      scanned: bookingEvents.length,
      expiredFound: expiredBookingEvents.length,
      expiredCount,
      expiredHoldIds: expiredBookingIds,
      deletedCount: expiredCount,
      deletedHoldIds: expiredBookingIds
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error.message || "Unknown error"
      },
      500
    );
  }
}

export const onRequestPost = onRequestGet;
