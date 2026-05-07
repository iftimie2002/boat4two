import {
  getGoogleAccessToken,
  getGoogleCalendarErrorPayload,
  hasGoogleCalendarCredentials
} from "./_google.js";
import { notifyGyGAvailabilityForEvents } from "./gyg/_notify_outbound.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function getDescriptionValue(description, key) {
  if (!description) return "";
  const regex = new RegExp(`^${key}:(.*)$`, "mi");
  const match = description.match(regex);
  return match ? match[1].trim() : "";
}

function isReleasableBookingEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const summary = event?.summary || "";
  const description = event?.description || "";
  const bookingType = privateProps.bookingType || "";

  if (bookingType === "paid" || privateProps.paymentStatus === "paid" || summary.startsWith("PAID - ")) {
    return false;
  }

  return (
    bookingType === "hold" ||
    bookingType === "pending_payment" ||
    bookingType === "released_hold" ||
    bookingType === "expired_hold" ||
    bookingType === "payment_expired" ||
    bookingType === "payment_cancelled" ||
    bookingType === "payment_rollback" ||
    privateProps.isHold === "true" ||
    Boolean(privateProps.holdId) ||
    Boolean(privateProps.paymentOrderId) ||
    summary.startsWith("[HOLD]") ||
    summary.startsWith("PAYMENT PENDING - ") ||
    summary.startsWith("RELEASED HOLD - ") ||
    summary.startsWith("EXPIRED HOLD - ") ||
    summary.startsWith("EXPIRED PAYMENT - ") ||
    summary.startsWith("PAYMENT CANCELLED - ") ||
    summary.startsWith("PAYMENT ROLLBACK - ") ||
    /HOLD_ID:/i.test(description)
  );
}

function eventMatchesHoldId(event, holdId) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.holdId === holdId ||
    getDescriptionValue(description, "HOLD_ID") === holdId
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

async function findHoldEventsById(env, accessToken, holdId) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  let events = [];

  try {
    events = await listEvents(env, accessToken, {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      privateExtendedProperty: `holdId=${holdId}`
    });
  } catch (_) {
    events = [];
  }

  let matching = events.filter((event) => isReleasableBookingEvent(event) && eventMatchesHoldId(event, holdId));

  if (matching.length) {
    return matching;
  }

  const fallbackEvents = await listEvents(env, accessToken, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString()
  });

  matching = fallbackEvents.filter((event) => isReleasableBookingEvent(event) && eventMatchesHoldId(event, holdId));

  return matching;
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
    throw new Error(text || "Failed to delete hold event");
  }
}

async function parseBody(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return await request.json();
  }

  const raw = await request.text();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (_) {
    return { holdId: raw.trim() };
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!hasGoogleCalendarCredentials(env)) {
    return json(
      {
        ok: false,
        error: "Missing required Google environment variables."
      },
      500
    );
  }

  try {
    const body = await parseBody(request);
    const holdId = (body?.holdId || "").trim();

    if (!holdId) {
      return json(
        {
          ok: false,
          error: "Missing holdId."
        },
        400
      );
    }

    const accessToken = await getGoogleAccessToken(env);
    const holdEvents = await findHoldEventsById(env, accessToken, holdId);

    if (!holdEvents.length) {
      return json({
        ok: true,
        released: false,
        reason: "already_missing",
        holdId
      });
    }

    let deletedCount = 0;
    const deletedEvents = [];

    for (const event of holdEvents) {
      deletedEvents.push({
        tour: event?.extendedProperties?.private?.tour || "",
        date: event?.extendedProperties?.private?.date || "",
        time: event?.extendedProperties?.private?.time || "",
        holdId
      });
      await deleteCalendarEvent(env, accessToken, event.id);
      deletedCount += 1;
    }

    const notifyResult = await notifyGyGAvailabilityForEvents(env, {
      accessToken,
      deletedEvents
    }).catch((error) => ({
      ok: false,
      error: error?.message || "Notify availability failed.",
      deliveries: []
    }));

    return json({
      ok: true,
      released: true,
      holdId,
      releasedCount: deletedCount,
      deletedCount,
      gygNotify: notifyResult
    });
  } catch (error) {
    return json(
      {
        ok: false,
        ...getGoogleCalendarErrorPayload(error)
      },
      500
    );
  }
}
