import {
  CLIENT_EVENT_NAMES,
  getAnalyticsSessionId,
  getRequestAnalyticsContext,
  recordAnalyticsEvent
} from "./_analytics.js";
import { getReferralFromRequest } from "./_referrals.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!sameOrigin(request)) {
    return json({ ok: false, error: "Forbidden." }, 403);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 8192) {
    return json({ ok: false, error: "Payload too large." }, 413);
  }

  try {
    const body = await request.json();
    const eventName = String(body?.eventName || "").trim().toLowerCase();
    const sessionId = getAnalyticsSessionId(body?.sessionId);

    if (!CLIENT_EVENT_NAMES.has(eventName) || !sessionId) {
      return json({ ok: false, error: "Invalid analytics event." }, 400);
    }

    const referral = await getReferralFromRequest(request, env);
    const requestContext = getRequestAnalyticsContext(request);
    const result = await recordAnalyticsEvent(env, {
      ...requestContext,
      eventName,
      sessionId,
      pagePath: body?.pagePath || requestContext.pagePath,
      partnerId: referral?.partner?.id || "",
      referrer: body?.referrer,
      utmSource: body?.utmSource,
      utmMedium: body?.utmMedium,
      utmCampaign: body?.utmCampaign,
      tour: body?.tour,
      holdId: body?.holdId,
      amountCents: body?.amountCents,
      currency: body?.currency,
      isTest: body?.isTest === true,
      detail: body?.detail,
      dedupeKey: eventName === "session_started" ? `session_started:${sessionId}` : ""
    });

    return json({ ok: true, recorded: result.recorded, reason: result.reason || undefined }, 202);
  } catch (error) {
    console.warn("Browser analytics event was ignored", error);
    return json({ ok: true, recorded: false }, 202);
  }
}

export async function onRequestGet() {
  return json({ ok: false, error: "Use POST." }, 405);
}
