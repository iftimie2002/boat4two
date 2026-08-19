import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PARTNER_REGISTRY,
  REFERRAL_ATTRIBUTION_DAYS,
  REFERRAL_COOKIE_NAME,
  buildReferralDescriptionLines,
  buildReferralPrivateProperties,
  createReferralToken,
  decideReferralClaim,
  getActivePartner,
  getReferralFromRequest,
  normalizePartnerSlug,
  parseCookies,
  resolveReferralForBooking,
  serializeReferralCookie,
  verifyReferralToken
} from "../functions/api/_referrals.js";
import { onRequestPost as claimReferral } from "../functions/api/referral-claim.js";
import { onRequestPost as createHold } from "../functions/api/create-hold.js";
import {
  buildAdminNotificationPayload,
  buildBookingEmailModel,
  buildPartnerReferralNotificationPayload,
  buildPaymentConfirmationPayload,
  buildTourDetailsPayload,
  calculatePartnerCommission,
  maybeSendBookingConfirmationEmail
} from "../functions/api/_booking-email.js";

const SECRET = "test-only-referral-secret-with-enough-entropy";
const CAPTURED_AT = new Date("2026-08-18T17:00:00.000Z");

function cookieRequest(token, url = "https://boat4two.com/api/create-hold") {
  return new Request(url, {
    headers: token ? { Cookie: `${REFERRAL_COOKIE_NAME}=${token}; theme=dark` } : {}
  });
}

async function signPayload(payload, secret = SECRET) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload)
  );
  return `${encodedPayload}.${Buffer.from(signature).toString("base64url")}`;
}

test("normalizes registered partner slugs and rejects unexpected paths", () => {
  for (const value of ["kalkbrenner", "/kalkbrenner", "/kalkbrenner/", "/KALKBRENNER", "/Kalkbrenner"]) {
    assert.equal(normalizePartnerSlug(value), "kalkbrenner");
    assert.equal(getActivePartner(value)?.id, "kalkbrenner");
  }

  for (const value of ["mssd9", "/mssd9", "/mssd9/", "/MSSD9"]) {
    assert.equal(normalizePartnerSlug(value), "mssd9");
    assert.equal(getActivePartner(value)?.id, "mssd9");
  }

  assert.equal(PARTNER_REGISTRY.mssd9.displayName, "Madalena Duque");
  assert.deepEqual(PARTNER_REGISTRY.mssd9.notificationEmails, [
    "madalenaduque9@gmail.com"
  ]);
  assert.equal(PARTNER_REGISTRY.mssd9.commissionRateBasisPoints, 1500);

  for (const value of ["", "/api/create-hold", "index.html", "../kalkbrenner", "a".repeat(65)]) {
    assert.equal(getActivePartner(value), null);
  }
});

test("Madalena Duque receives signed attribution and her own partner email", async () => {
  const partner = PARTNER_REGISTRY.mssd9;
  const { token } = await createReferralToken(partner, "/mssd9", SECRET, CAPTURED_AT);
  const verified = await verifyReferralToken(token, SECRET, {
    now: new Date("2026-08-20T00:00:00.000Z")
  });
  assert.equal(verified?.partner?.id, "mssd9");
  assert.equal(verified?.landingPath, "/mssd9");

  const event = {
    id: "madalena-partner-email-event",
    start: { dateTime: "2026-08-25T17:00:00.000Z", timeZone: "Europe/Lisbon" },
    end: { dateTime: "2026-08-25T20:30:00.000Z", timeZone: "Europe/Lisbon" },
    extendedProperties: {
      private: {
        tour: "sunset",
        date: "2026-08-25",
        time: "18:00",
        customerName: "Test Customer",
        paymentAmount: "218.00",
        paymentCurrency: "EUR",
        paymentOrderId: "B4T-MADALENA-TEST",
        salesChannel: "partner_referral",
        referralPartnerId: "mssd9",
        referralPartnerName: "Madalena Duque",
        referralPartnerType: "reseller"
      }
    }
  };
  const payload = buildPartnerReferralNotificationPayload(
    buildBookingEmailModel({}, event)
  );

  assert.deepEqual(payload?.to, ["madalenaduque9@gmail.com"]);
  assert.equal(payload?.commissionRateBasisPoints, "1500");
  assert.equal(payload?.commissionAmount, "32.70");
  assert.match(payload?.subject || "", /Madalena Duque referral/);
  assert.match(payload?.text || "", /Customer name: Test Customer/);
});

test("creates an HMAC token with one central 30-day window and complete metadata", async () => {
  const partner = PARTNER_REGISTRY.kalkbrenner;
  const { token, referral } = await createReferralToken(partner, "/kalkbrenner", SECRET, CAPTURED_AT);
  const verified = await verifyReferralToken(token, SECRET, {
    now: new Date("2026-08-20T00:00:00.000Z")
  });

  assert.equal(REFERRAL_ATTRIBUTION_DAYS, 30);
  assert.equal(verified.partner.id, "kalkbrenner");
  assert.equal(verified.capturedAt, "2026-08-18T17:00:00.000Z");
  assert.equal(verified.expiresAt, "2026-09-17T17:00:00.000Z");
  assert.equal(verified.landingPath, "/kalkbrenner");
  assert.deepEqual(buildReferralPrivateProperties(referral), {
    salesChannel: "partner_referral",
    referralPartnerId: "kalkbrenner",
    referralPartnerName: "Kalkbrenner",
    referralPartnerType: "reseller",
    referralCapturedAt: "2026-08-18T17:00:00.000Z",
    referralLandingPath: "/kalkbrenner",
    referralAttributionModel: "first_touch"
  });
  assert.match(buildReferralDescriptionLines(referral).join("\n"), /Referral partner: Kalkbrenner/);
});

test("rejects malformed, tampered, unsupported, expired, and inactive referral tokens", async () => {
  const { token } = await createReferralToken(
    PARTNER_REGISTRY.kalkbrenner,
    "/kalkbrenner",
    SECRET,
    CAPTURED_AT
  );
  const [payload, signature] = token.split(".");

  assert.equal(await verifyReferralToken("not-a-token", SECRET, { now: CAPTURED_AT }), null);
  assert.equal(await verifyReferralToken(`${payload}.${signature.slice(0, -1)}x`, SECRET, { now: CAPTURED_AT }), null);
  assert.equal(await verifyReferralToken(token, "wrong-secret", { now: CAPTURED_AT }), null);
  assert.equal(await verifyReferralToken(token, SECRET, { now: new Date("2026-09-17T17:00:00.000Z") }), null);

  const unsupported = await signPayload({
    v: 2,
    partnerId: "kalkbrenner",
    capturedAt: "2026-08-18T17:00:00.000Z",
    expiresAt: "2026-09-17T17:00:00.000Z",
    landingPath: "/kalkbrenner"
  });
  assert.equal(await verifyReferralToken(unsupported, SECRET, { now: CAPTURED_AT }), null);

  for (const invalidPayload of [
    {
      v: 1,
      capturedAt: "2026-08-18T17:00:00.000Z",
      expiresAt: "2026-09-17T17:00:00.000Z",
      landingPath: "/kalkbrenner"
    },
    {
      v: 1,
      partnerId: "kalkbrenner",
      capturedAt: "not-a-date",
      expiresAt: "2026-09-17T17:00:00.000Z",
      landingPath: "/kalkbrenner"
    },
    {
      v: 1,
      partnerId: "kalkbrenner",
      capturedAt: "2026-08-18T17:00:00.000Z",
      expiresAt: "2026-09-18T17:00:00.000Z",
      landingPath: "/kalkbrenner"
    },
    {
      v: 1,
      partnerId: "kalkbrenner",
      capturedAt: "2026-08-18T17:00:00.000Z",
      expiresAt: "2026-09-17T17:00:00.000Z",
      landingPath: "/tampered"
    }
  ]) {
    const invalidToken = await signPayload(invalidPayload);
    assert.equal(await verifyReferralToken(invalidToken, SECRET, { now: CAPTURED_AT }), null);
  }

  const inactiveRegistry = {
    kalkbrenner: { ...PARTNER_REGISTRY.kalkbrenner, active: false }
  };
  assert.equal(await verifyReferralToken(token, SECRET, { now: CAPTURED_AT, registry: inactiveRegistry }), null);
});

test("parses multi-cookie headers and fails open for missing secret or a bad cookie", async () => {
  assert.deepEqual(parseCookies("session=abc; b4t_referral_v1=one.two; theme=dark"), {
    session: "abc",
    b4t_referral_v1: "one.two",
    theme: "dark"
  });
  assert.equal(await getReferralFromRequest(cookieRequest("bad.token"), {}), null);
  assert.equal(
    await getReferralFromRequest(cookieRequest("bad.token"), { REFERRAL_SIGNING_SECRET: SECRET }),
    null
  );
});

test("serializes a persistent first-party cookie with aligned security attributes", async () => {
  const { token, referral } = await createReferralToken(
    PARTNER_REGISTRY.kalkbrenner,
    "/kalkbrenner",
    SECRET,
    CAPTURED_AT
  );
  const cookie = serializeReferralCookie(
    token,
    referral.expiresAt,
    CAPTURED_AT,
    true,
    "boat4two.com"
  );

  assert.match(cookie, /^b4t_referral_v1=/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Domain=boat4two\.com/);
  assert.match(cookie, /; Max-Age=2592000/);
  assert.match(cookie, /; Expires=Thu, 17 Sep 2026 17:00:00 GMT/);

  const previewCookie = serializeReferralCookie(token, referral.expiresAt, CAPTURED_AT, true);
  assert.doesNotMatch(previewCookie, /; Domain=/);
});

test("first-touch decision preserves a different valid partner without extending expiry", () => {
  const existing = {
    partner: PARTNER_REGISTRY.kalkbrenner,
    capturedAt: "2026-08-18T17:00:00.000Z",
    expiresAt: "2026-09-17T17:00:00.000Z"
  };
  const requestedDifferentPartner = {
    id: "temporary-test-partner",
    displayName: "Temporary Test Partner",
    type: "reseller",
    active: true
  };
  const decision = decideReferralClaim(existing, requestedDifferentPartner);

  assert.equal(decision.shouldCreate, false);
  assert.equal(decision.reason, "first_touch_preserved");
  assert.strictEqual(decision.referral, existing);
  assert.equal(decision.referral.expiresAt, "2026-09-17T17:00:00.000Z");
});

test("claim endpoint sets no-store cookie, preserves first touch, and ignores unknown partners", async () => {
  const crossOriginResponse = await claimReferral({
    request: new Request("https://boat4two.com/api/referral-claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ slug: "kalkbrenner" })
    }),
    env: { REFERRAL_SIGNING_SECRET: SECRET }
  });
  assert.equal(crossOriginResponse.status, 403);
  assert.equal(crossOriginResponse.headers.get("Set-Cookie"), null);

  const missingSecretResponse = await claimReferral({
    request: new Request("https://boat4two.com/api/referral-claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://boat4two.com" },
      body: JSON.stringify({ slug: "kalkbrenner" })
    }),
    env: {}
  });
  assert.deepEqual(await missingSecretResponse.json(), {
    ok: true,
    claimed: false,
    reason: "unavailable"
  });

  const firstRequest = new Request("https://boat4two.com/api/referral-claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://boat4two.com" },
    body: JSON.stringify({ slug: "KALKBRENNER" })
  });
  const firstResponse = await claimReferral({
    request: firstRequest,
    env: { REFERRAL_SIGNING_SECRET: SECRET }
  });
  const firstBody = await firstResponse.json();
  const setCookie = firstResponse.headers.get("Set-Cookie");

  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.claimed, true);
  assert.equal((await verifyReferralToken(firstBody.referralToken, SECRET))?.partner?.id, "kalkbrenner");
  assert.equal(firstResponse.headers.get("Cache-Control"), "no-store");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Domain=boat4two\.com/);

  const wwwResponse = await claimReferral({
    request: new Request("https://www.boat4two.com/api/referral-claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://www.boat4two.com" },
      body: JSON.stringify({ slug: "kalkbrenner" })
    }),
    env: { REFERRAL_SIGNING_SECRET: SECRET }
  });
  assert.match(wwwResponse.headers.get("Set-Cookie"), /Domain=boat4two\.com/);

  const previewResponse = await claimReferral({
    request: new Request("https://preview.boat4two.pages.dev/api/referral-claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://preview.boat4two.pages.dev"
      },
      body: JSON.stringify({ slug: "kalkbrenner" })
    }),
    env: { REFERRAL_SIGNING_SECRET: SECRET }
  });
  assert.doesNotMatch(previewResponse.headers.get("Set-Cookie"), /Domain=/);

  const cookiePair = setCookie.split(";", 1)[0];
  const repeatRequest = new Request("https://boat4two.com/api/referral-claim", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookiePair,
      Origin: "https://boat4two.com"
    },
    body: JSON.stringify({ slug: "kalkbrenner" })
  });
  const repeatResponse = await claimReferral({
    request: repeatRequest,
    env: { REFERRAL_SIGNING_SECRET: SECRET }
  });

  const repeatBody = await repeatResponse.json();
  assert.deepEqual(repeatBody, {
    ok: true,
    claimed: false,
    reason: "first_touch_preserved",
    referralToken: cookiePair.split("=", 2)[1]
  });
  assert.equal(repeatResponse.headers.get("Set-Cookie"), null);

  const unknownResponse = await claimReferral({
    request: new Request("https://boat4two.com/api/referral-claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "random-agency" })
    }),
    env: { REFERRAL_SIGNING_SECRET: SECRET }
  });
  assert.deepEqual(await unknownResponse.json(), {
    ok: true,
    claimed: false,
    reason: "invalid_partner"
  });

  const expiredToken = await createReferralToken(
    PARTNER_REGISTRY.kalkbrenner,
    "/kalkbrenner",
    SECRET,
    new Date("2020-01-01T00:00:00.000Z")
  );
  const replacementResponse = await claimReferral({
    request: new Request("https://boat4two.com/api/referral-claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${REFERRAL_COOKIE_NAME}=${expiredToken.token}`
      },
      body: JSON.stringify({ slug: "kalkbrenner" })
    }),
    env: { REFERRAL_SIGNING_SECRET: SECRET }
  });
  const replacementBody = await replacementResponse.json();
  assert.equal(replacementBody.ok, true);
  assert.equal(replacementBody.claimed, true);
  assert.equal((await verifyReferralToken(replacementBody.referralToken, SECRET))?.partner?.id, "kalkbrenner");
  assert.match(replacementResponse.headers.get("Set-Cookie"), /^b4t_referral_v1=/);
});

test("booking referral resolution uses a signed proof when the cookie is not yet available", async () => {
  const { token } = await createReferralToken(
    PARTNER_REGISTRY.kalkbrenner,
    "/kalkbrenner",
    SECRET,
    new Date()
  );
  const requestWithoutCookie = new Request("https://boat4two.com/api/create-hold");
  const [proofPayload, proofSignature] = token.split(".");
  const tamperedToken = `${proofPayload}.${proofSignature[0] === "A" ? "B" : "A"}${proofSignature.slice(1)}`;

  assert.equal(
    (await resolveReferralForBooking(
      requestWithoutCookie,
      token,
      { REFERRAL_SIGNING_SECRET: SECRET }
    ))?.partner?.id,
    "kalkbrenner"
  );
  assert.equal(
    await resolveReferralForBooking(
      requestWithoutCookie,
      tamperedToken,
      { REFERRAL_SIGNING_SECRET: SECRET }
    ),
    null
  );
});

test("referral details appear only in the internal admin email", () => {
  const event = {
    id: "event-1",
    start: { dateTime: "2026-08-25T17:00:00.000Z", timeZone: "Europe/Lisbon" },
    end: { dateTime: "2026-08-25T20:30:00.000Z", timeZone: "Europe/Lisbon" },
    extendedProperties: {
      private: {
        tour: "sunset",
        date: "2026-08-25",
        time: "18:00",
        customerName: "Test Customer",
        customerEmail: "test@example.com",
        paymentAmount: "218.00",
        paymentCurrency: "EUR",
        salesChannel: "partner_referral",
        referralPartnerId: "kalkbrenner",
        referralPartnerName: "Kalkbrenner",
        referralPartnerType: "reseller",
        referralCapturedAt: "2026-08-18T17:00:00.000Z",
        referralAttributionModel: "first_touch"
      }
    }
  };
  const model = buildBookingEmailModel({}, event);
  const admin = buildAdminNotificationPayload(model);
  const customerPayment = buildPaymentConfirmationPayload(model);
  const customerTour = buildTourDetailsPayload(model);
  const customerOutput = JSON.stringify([customerPayment, customerTour]);
  const customerIcs = Buffer.from(
    customerTour.attachments[0].contentBase64,
    "base64"
  ).toString("utf8");

  assert.match(admin.subject, /Kalkbrenner referral booking/);
  assert.match(admin.text, /Source: Boat4Two/);
  assert.match(admin.text, /Sales channel: Partner Referral/);
  assert.match(admin.text, /Referral partner: Kalkbrenner/);
  assert.doesNotMatch(customerOutput, /Kalkbrenner|partner_referral|Referral partner|Sales channel/);
  assert.doesNotMatch(customerIcs, /Kalkbrenner|partner_referral|Referral partner|Sales channel/);

  const gygModel = buildBookingEmailModel({}, {
    ...event,
    extendedProperties: {
      private: {
        ...event.extendedProperties.private,
        source: "getyourguide"
      }
    }
  });
  const gygAdmin = buildAdminNotificationPayload(gygModel);
  assert.match(gygAdmin.subject, /New GetYourGuide booking confirmed/);
  assert.match(gygAdmin.text, /Source: GetYourGuide/);
  assert.doesNotMatch(gygAdmin.text, /Sales channel: Partner Referral/);
});

test("partner email includes customer name and 15% commission without contact details", () => {
  const event = {
    id: "partner-email-event",
    start: { dateTime: "2026-08-25T17:00:00.000Z", timeZone: "Europe/Lisbon" },
    end: { dateTime: "2026-08-25T20:30:00.000Z", timeZone: "Europe/Lisbon" },
    extendedProperties: {
      private: {
        tour: "sunset",
        date: "2026-08-25",
        time: "18:00",
        customerName: "Private Customer Name",
        customerEmail: "private-customer@example.com",
        customerPhone: "+351900000000",
        customerMessage: "Private customer note",
        paymentAmount: "218.00",
        paymentCurrency: "EUR",
        paymentOrderId: "B4T-PARTNER-TEST",
        salesChannel: "partner_referral",
        referralPartnerId: "kalkbrenner",
        referralPartnerName: "Kalkbrenner",
        referralPartnerType: "reseller"
      }
    }
  };
  const model = buildBookingEmailModel({}, event);
  const payload = buildPartnerReferralNotificationPayload(model);
  const output = JSON.stringify(payload);

  assert.equal(PARTNER_REGISTRY.kalkbrenner.commissionRateBasisPoints, 1500);
  assert.deepEqual(PARTNER_REGISTRY.kalkbrenner.notificationEmails, [
    "contas@kalkbrenner.ws",
    "info@kalkbrenner.ws"
  ]);
  assert.deepEqual(calculatePartnerCommission("0.10", "EUR", 2000), {
    amount: "0.02",
    amountLabel: "0,02€",
    ratePercent: 20
  });
  assert.equal(calculatePartnerCommission("", "EUR", 2000), null);
  assert.equal(calculatePartnerCommission("invalid", "EUR", 2000), null);
  assert.deepEqual(payload.to, ["contas@kalkbrenner.ws", "info@kalkbrenner.ws"]);
  assert.equal(payload.commissionAmount, "32.70");
  assert.match(payload.text, /^Dear partner,/);
  assert.match(payload.text, /We got another booking through your referral\./);
  assert.match(payload.text, /Customer name: Private Customer Name/);
  assert.match(payload.text, /Total booking: 218,00€/);
  assert.match(payload.text, /Your commission \(15%\): 32,70€/);
  assert.match(payload.html, /<strong>Customer name:<\/strong> Private Customer Name/);
  assert.doesNotMatch(
    output,
    /private-customer@example\.com|351900000000|Private customer note/
  );

  const directModel = buildBookingEmailModel({}, {
    ...event,
    extendedProperties: {
      private: {
        ...event.extendedProperties.private,
        salesChannel: "",
        referralPartnerId: "",
        referralPartnerName: ""
      }
    }
  });
  assert.equal(buildPartnerReferralNotificationPayload(directModel), null);
});

test("paid referral notification sends once and email failure never blocks booking email state", async () => {
  const sentPayloads = [];
  const baseEvent = {
    id: "paid-referral-event",
    start: { dateTime: "2026-08-25T17:00:00.000Z", timeZone: "Europe/Lisbon" },
    end: { dateTime: "2026-08-25T20:30:00.000Z", timeZone: "Europe/Lisbon" },
    extendedProperties: {
      private: {
        bookingType: "paid",
        paymentStatus: "paid",
        tour: "sunset",
        date: "2026-08-25",
        time: "18:00",
        customerName: "Test Customer",
        customerEmail: "test@example.com",
        paymentAmount: "0.10",
        paymentCurrency: "EUR",
        paymentOrderId: "B4T-PAID-REFERRAL",
        paymentConfirmationEmailSentAt: "2026-08-18T18:00:00.000Z",
        tourDetailsEmailSentAt: "2026-08-18T18:00:01.000Z",
        adminBookingNotificationEmailSentAt: "2026-08-18T18:00:02.000Z",
        salesChannel: "partner_referral",
        referralPartnerId: "kalkbrenner",
        referralPartnerName: "Kalkbrenner",
        referralPartnerType: "reseller"
      }
    }
  };
  const env = {
    BOOKING_EMAIL: {
      async send(payload) {
        sentPayloads.push(payload);
        return { messageId: "partner-message-1" };
      }
    }
  };

  const firstResult = await maybeSendBookingConfirmationEmail(env, baseEvent);
  assert.equal(sentPayloads.length, 1);
  assert.deepEqual(sentPayloads[0].to, [
    "contas@kalkbrenner.ws",
    "info@kalkbrenner.ws"
  ]);
  assert.equal(firstResult.patchPrivateProps.partnerReferralNotificationEmailStatus, "sent");
  assert.equal(firstResult.patchPrivateProps.partnerReferralCommissionAmount, "0.02");
  assert.equal(firstResult.patchPrivateProps.partnerReferralCommissionCurrency, "EUR");
  assert.equal(firstResult.patchPrivateProps.partnerReferralCommissionRateBasisPoints, "1500");

  const persistedEvent = {
    ...baseEvent,
    extendedProperties: {
      private: {
        ...baseEvent.extendedProperties.private,
        ...firstResult.patchPrivateProps
      }
    }
  };
  await maybeSendBookingConfirmationEmail(env, persistedEvent);
  assert.equal(sentPayloads.length, 1);

  const holdEvent = {
    ...baseEvent,
    summary: "HOLD - Sunset Tour - Test Customer",
    extendedProperties: {
      private: {
        ...baseEvent.extendedProperties.private,
        bookingType: "hold",
        paymentStatus: "",
        partnerReferralNotificationEmailSentAt: ""
      }
    }
  };
  await maybeSendBookingConfirmationEmail(env, holdEvent);
  assert.equal(sentPayloads.length, 1);

  const failedResult = await maybeSendBookingConfirmationEmail({
    BOOKING_EMAIL: {
      async send() {
        throw new Error("Test partner delivery failure");
      }
    }
  }, baseEvent);
  assert.equal(failedResult.status, "sent");
  assert.equal(failedResult.patchPrivateProps.partnerReferralNotificationEmailStatus, "failed");
  assert.match(
    failedResult.patchPrivateProps.partnerReferralNotificationEmailError,
    /Test partner delivery failure/
  );
});

test("create-hold attaches verified referral metadata and direct bookings remain unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const createdBookingEvents = [];
  const env = {
    GOOGLE_CALENDAR_ID: "calendar@example.com",
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh",
    REFERRAL_SIGNING_SECRET: SECRET
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);

    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "test-access-token" });
    }
    if (url.includes("/freeBusy")) {
      return Response.json({ calendars: { "calendar@example.com": { busy: [] } } });
    }
    if (url.includes("/events?") && (!init.method || init.method === "GET")) {
      return Response.json({ items: [] });
    }
    if (url.endsWith("/events") && init.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.extendedProperties?.private?.bookingType === "slot_lock") {
        return Response.json({ id: body.id, etag: "lock-etag" });
      }

      createdBookingEvents.push(body);
      return Response.json({ id: `booking-event-${createdBookingEvents.length}` });
    }
    if (url.includes("/events/") && init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected fetch in create-hold test: ${init.method || "GET"} ${url}`);
  };

  try {
    const makeRequest = (cookie = "", referralToken = "") => new Request("https://boat4two.com/api/create-hold", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify({
        tour: "custom",
        date: "2099-08-25",
        time: "10:00",
        name: "Test Customer",
        email: "test@example.com",
        phone: "+351900000000",
        country: "Portugal",
        testMode: true,
        referralToken
      })
    });

    const directResponse = await createHold({ request: makeRequest(), env });
    assert.equal(directResponse.status, 200);
    assert.equal((await directResponse.json()).ok, true);
    assert.equal(createdBookingEvents[0].extendedProperties.private.referralPartnerId, undefined);
    assert.doesNotMatch(createdBookingEvents[0].description, /Referral partner/);

    const { token } = await createReferralToken(
      PARTNER_REGISTRY.kalkbrenner,
      "/kalkbrenner",
      SECRET,
      new Date()
    );
    const referralResponse = await createHold({
      request: makeRequest(`${REFERRAL_COOKIE_NAME}=${token}`),
      env
    });
    assert.equal(referralResponse.status, 200);
    assert.equal((await referralResponse.json()).ok, true);

    const referralEvent = createdBookingEvents[1];
    assert.equal(referralEvent.extendedProperties.private.bookingType, "hold");
    assert.equal(referralEvent.extendedProperties.private.salesChannel, "partner_referral");
    assert.equal(referralEvent.extendedProperties.private.referralPartnerId, "kalkbrenner");
    assert.equal(referralEvent.extendedProperties.private.referralPartnerName, "Kalkbrenner");
    assert.equal(referralEvent.extendedProperties.private.referralPartnerType, "reseller");
    assert.match(referralEvent.extendedProperties.private.referralCapturedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(referralEvent.extendedProperties.private.referralLandingPath, "/kalkbrenner");
    assert.equal(referralEvent.extendedProperties.private.referralAttributionModel, "first_touch");
    assert.match(referralEvent.description, /Sales channel: Partner Referral/);
    assert.match(referralEvent.description, /Referral partner: Kalkbrenner/);

    const signedProofResponse = await createHold({
      request: makeRequest("", token),
      env
    });
    assert.equal(signedProofResponse.status, 200);
    assert.equal((await signedProofResponse.json()).ok, true);
    assert.equal(createdBookingEvents[2].extendedProperties.private.referralPartnerId, "kalkbrenner");

    const badCookieResponse = await createHold({
      request: makeRequest(`${REFERRAL_COOKIE_NAME}=bad.token`),
      env
    });
    assert.equal(badCookieResponse.status, 200);
    assert.equal((await badCookieResponse.json()).ok, true);
    assert.equal(createdBookingEvents[3].extendedProperties.private.referralPartnerId, undefined);

    const missingSecretResponse = await createHold({
      request: makeRequest(`${REFERRAL_COOKIE_NAME}=${token}`),
      env: { ...env, REFERRAL_SIGNING_SECRET: "" }
    });
    assert.equal(missingSecretResponse.status, 200);
    assert.equal((await missingSecretResponse.json()).ok, true);
    assert.equal(createdBookingEvents[4].extendedProperties.private.referralPartnerId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("payment lifecycle keeps private metadata and does not send it to myPOS", async () => {
  const [pendingSource, confirmSource, notifySource] = await Promise.all([
    readFile(new URL("../functions/api/create-mypos-payment.js", import.meta.url), "utf8"),
    readFile(new URL("../functions/api/confirm-mypos-payment.js", import.meta.url), "utf8"),
    readFile(new URL("../functions/api/mypos-notify.js", import.meta.url), "utf8")
  ]);

  assert.match(pendingSource, /\.\.\.privateProps,[\s\S]*bookingType: "pending_payment"/);
  assert.match(confirmSource, /\.\.\.privateProps,[\s\S]*bookingType: "paid"/);
  assert.match(notifySource, /\.\.\.privateProps,[\s\S]*bookingType: "paid"/);
  assert.doesNotMatch(pendingSource, /ReferralPartner|referralPartner|salesChannel/);
  assert.doesNotMatch(confirmSource, /ReferralPartner|referralPartner|salesChannel/);
  assert.doesNotMatch(notifySource, /ReferralPartner|referralPartner|salesChannel/);
});
