import {
  createReferralToken,
  decideReferralClaim,
  getActivePartner,
  getReferralFromRequest,
  serializeReferralCookie
} from "./_referrals.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function requestIsSameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!requestIsSameOrigin(request)) {
    return json({ ok: false, claimed: false, reason: "cross_origin" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: true, claimed: false, reason: "invalid_request" });
  }

  const partner = getActivePartner(body?.slug);
  if (!partner) {
    return json({ ok: true, claimed: false, reason: "invalid_partner" });
  }

  if (!env?.REFERRAL_SIGNING_SECRET) {
    return json({ ok: true, claimed: false, reason: "unavailable" });
  }

  try {
    const existingReferral = await getReferralFromRequest(request, env);
    const decision = decideReferralClaim(existingReferral, partner);
    if (!decision.shouldCreate) {
      console.info(
        `[referral] first_touch_preserved existing=${existingReferral.partner.id} requested=${partner.id}`
      );
      return json({ ok: true, claimed: false, reason: decision.reason });
    }

    const now = new Date();
    const { token, referral } = await createReferralToken(
      partner,
      `/${partner.id}`,
      env.REFERRAL_SIGNING_SECRET,
      now
    );
    const requestUrl = new URL(request.url);
    const secure = requestUrl.protocol === "https:";
    const cookieDomain = ["boat4two.com", "www.boat4two.com"].includes(
      requestUrl.hostname.toLowerCase()
    )
      ? "boat4two.com"
      : "";
    const cookie = serializeReferralCookie(
      token,
      referral.expiresAt,
      now,
      secure,
      cookieDomain
    );

    console.info(`[referral] claim_created partner=${partner.id}`);
    return json(
      { ok: true, claimed: true },
      200,
      { "Set-Cookie": cookie }
    );
  } catch (_) {
    // Claim failures are deliberately invisible to the customer and booking flow.
    return json({ ok: true, claimed: false, reason: "unavailable" });
  }
}
