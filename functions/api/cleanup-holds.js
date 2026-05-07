import {
  getGoogleAccessToken,
  getGoogleCalendarErrorPayload,
  hasGoogleCalendarCredentials
} from "./_google.js";
import {
  cleanupStaleBookingArtifacts
} from "./_stale-bookings.js";
import {
  notifyGyGAvailabilityForEvents
} from "./gyg/_notify_outbound.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

async function runCleanup(env) {
  const accessToken = await getGoogleAccessToken(env);
  const cleanupResult = await cleanupStaleBookingArtifacts(env, { accessToken });
  const notifyResult = await notifyGyGAvailabilityForEvents(env, {
    accessToken,
    deletedEvents: cleanupResult.deletedEvents || []
  }).catch((error) => ({
    ok: false,
    error: error?.message || "Notify availability failed.",
    deliveries: []
  }));

  return {
    ...cleanupResult,
    expiredHoldIds: (cleanupResult.deletedEvents || []).map((event) => event.holdId || event.eventId),
    deletedHoldIds: (cleanupResult.deletedEvents || []).map((event) => event.holdId || event.eventId),
    gygNotify: notifyResult
  };
}

export async function onRequestGet(context) {
  const { env } = context;

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
    const result = await runCleanup(env);
    return json({ ok: true, ...result });
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

export const onRequestPost = onRequestGet;
