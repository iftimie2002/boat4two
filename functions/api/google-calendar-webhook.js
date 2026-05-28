function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function getWebhookToken(env) {
  return cleanText(
    env.GOOGLE_CALENDAR_WEBHOOK_TOKEN ||
    env.GYG_SYNC_KEY ||
    env.DAILY_SYSTEM_CHECK_KEY,
    800
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function getSyncUrl(request) {
  const origin = new URL(request.url).origin;
  const url = new URL("/api/gyg-sync-availability", origin);

  url.searchParams.set("days", "365");
  url.searchParams.set("batchDays", "60");
  url.searchParams.set("sandbox", "0");

  return url.toString();
}

async function triggerGyGCalendarSync(request, env) {
  const token = cleanText(env.GYG_SYNC_KEY || env.DAILY_SYSTEM_CHECK_KEY, 800);

  if (!token) {
    throw new Error("Missing GYG_SYNC_KEY or DAILY_SYSTEM_CHECK_KEY.");
  }

  const response = await fetch(getSyncUrl(request), {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "boat4two-google-calendar-webhook"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GYG sync failed after Google Calendar webhook: HTTP ${response.status} ${body}`);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const expectedToken = getWebhookToken(env);
  const suppliedToken = cleanText(request.headers.get("x-goog-channel-token"), 800);

  if (!expectedToken) {
    return json(
      {
        ok: false,
        error: "Missing GOOGLE_CALENDAR_WEBHOOK_TOKEN, GYG_SYNC_KEY, or DAILY_SYSTEM_CHECK_KEY."
      },
      500
    );
  }

  if (!suppliedToken || suppliedToken !== expectedToken) {
    return json(
      {
        ok: false,
        error: "Unauthorized Google Calendar webhook request."
      },
      401
    );
  }

  const syncPromise = triggerGyGCalendarSync(request, env);

  if (typeof context.waitUntil === "function") {
    context.waitUntil(syncPromise);
  } else {
    await syncPromise;
  }

  return json({
    ok: true,
    accepted: true,
    resourceState: cleanText(request.headers.get("x-goog-resource-state"), 120),
    channelId: cleanText(request.headers.get("x-goog-channel-id"), 220),
    messageNumber: cleanText(request.headers.get("x-goog-message-number"), 120),
    syncTriggered: true
  }, 202);
}

export const onRequestGet = onRequestPost;
