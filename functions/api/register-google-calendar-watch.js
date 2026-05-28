import {
  getGoogleAccessToken,
  getGoogleCalendarErrorPayload,
  getPrimaryGoogleCalendarId,
  hasGoogleCalendarCredentials
} from "./_google.js";

const WATCH_RENEWAL_HOURS = 25;

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function getWebhookToken(env) {
  return cleanText(
    env.GOOGLE_CALENDAR_WEBHOOK_TOKEN ||
    env.GYG_SYNC_KEY ||
    env.DAILY_SYSTEM_CHECK_KEY,
    800
  );
}

function isAuthorized(request, env) {
  const configuredKey = cleanText(env.GYG_SYNC_KEY || env.DAILY_SYSTEM_CHECK_KEY, 800);

  if (!configuredKey) {
    return {
      ok: false,
      reason: "Missing GYG_SYNC_KEY or DAILY_SYSTEM_CHECK_KEY in Cloudflare environment."
    };
  }

  const header = cleanText(request.headers.get("authorization"), 800);
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const queryKey = cleanText(new URL(request.url).searchParams.get("key"), 800);
  const supplied = bearer || queryKey;

  if (!supplied || supplied !== configuredKey) {
    return {
      ok: false,
      reason: "Unauthorized Google Calendar watch registration request."
    };
  }

  return { ok: true };
}

function getWebhookAddress(request, env) {
  const configuredUrl = cleanText(env.GOOGLE_CALENDAR_WEBHOOK_URL, 500);

  if (configuredUrl) {
    return configuredUrl;
  }

  return new URL("/api/google-calendar-webhook", new URL(request.url).origin).toString();
}

async function registerCalendarWatch(request, env) {
  const accessToken = await getGoogleAccessToken(env);
  const calendarId = getPrimaryGoogleCalendarId(env);
  const token = getWebhookToken(env);

  if (!calendarId) {
    throw new Error("Missing GOOGLE_CALENDAR_ID.");
  }

  if (!token) {
    throw new Error("Missing GOOGLE_CALENDAR_WEBHOOK_TOKEN, GYG_SYNC_KEY, or DAILY_SYSTEM_CHECK_KEY.");
  }

  const channelId = `boat4two-calendar-${crypto.randomUUID()}`;
  const expirationMs = Date.now() + WATCH_RENEWAL_HOURS * 60 * 60 * 1000;
  const watchUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`;
  const response = await fetch(watchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: channelId,
      type: "web_hook",
      address: getWebhookAddress(request, env),
      token,
      expiration: String(expirationMs)
    })
  });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error?.message || `Google Calendar watch registration failed with HTTP ${response.status}.`);
  }

  return {
    ok: true,
    calendarId,
    webhookAddress: getWebhookAddress(request, env),
    channelId: data?.id || channelId,
    resourceId: data?.resourceId || null,
    resourceUri: data?.resourceUri || null,
    expiration: data?.expiration || String(expirationMs),
    expirationIso: new Date(Number(data?.expiration || expirationMs)).toISOString()
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = isAuthorized(request, env);

  if (!auth.ok) {
    return json(
      {
        ok: false,
        error: auth.reason
      },
      401
    );
  }

  if (!hasGoogleCalendarCredentials(env)) {
    return json(
      {
        ok: false,
        error: "Missing required Google Calendar environment variables."
      },
      500
    );
  }

  try {
    return json(await registerCalendarWatch(request, env));
  } catch (error) {
    return json(
      {
        ok: false,
        ...(getGoogleCalendarErrorPayload(error) || {
          error: error?.message || "Failed to register Google Calendar watch."
        })
      },
      500
    );
  }
}

export const onRequestPost = onRequestGet;
