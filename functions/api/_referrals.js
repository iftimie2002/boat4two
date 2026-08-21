export const REFERRAL_COOKIE_NAME = "b4t_referral_v1";
export const REFERRAL_ATTRIBUTION_DAYS = 30;
export const REFERRAL_ATTRIBUTION_MODEL = "first_touch";

export const PARTNER_REGISTRY = Object.freeze({
  kalkbrenner: Object.freeze({
    id: "kalkbrenner",
    displayName: "Kalkbrenner",
    type: "reseller",
    active: true,
    notificationEmails: Object.freeze([
      "contas@kalkbrenner.ws",
      "reservas@kalkbrenner.ws"
    ]),
    commissionRateBasisPoints: 1500,
    includeCustomerNameInNotification: true
  }),
  mssd9: Object.freeze({
    id: "mssd9",
    displayName: "Madalena Duque",
    type: "reseller",
    active: true,
    notificationEmails: Object.freeze([
      "madalenaduque9@gmail.com"
    ]),
    commissionRateBasisPoints: 1500,
    includeCustomerNameInNotification: true
  }),
  mserol: Object.freeze({
    id: "mserol",
    displayName: "Marcos Serol",
    type: "reseller",
    active: true,
    notificationEmails: Object.freeze([
      "marcos.serol@gmail.com"
    ]),
    commissionRateBasisPoints: 1500,
    includeCustomerNameInNotification: false
  }),
  orchidvillas: Object.freeze({
    id: "orchidvillas",
    displayName: "Micaela",
    type: "reseller",
    active: true,
    notificationEmails: Object.freeze([
      "orchidvillasprainha@gmail.com"
    ]),
    commissionRateBasisPoints: 1500,
    includeCustomerNameInNotification: false
  }),
  laura: Object.freeze({
    id: "laura",
    displayName: "Laura Miguel",
    type: "reseller",
    active: true,
    notificationEmails: Object.freeze([
      "laurabmiguel13@gmail.com"
    ]),
    commissionRateBasisPoints: 1500,
    includeCustomerNameInNotification: false
  })
});

const TOKEN_VERSION = 1;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ATTRIBUTION_WINDOW_MS = REFERRAL_ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000;

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const text = String(value || "");
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error("Invalid base64url value");
  }

  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export function normalizePartnerSlug(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized) ? normalized : "";
}

export function getActivePartner(value, registry = PARTNER_REGISTRY) {
  const id = normalizePartnerSlug(value);
  const partner = id ? registry[id] : null;
  return partner?.active === true && partner.id === id ? partner : null;
}

export function parseCookies(cookieHeader) {
  const cookies = {};

  for (const part of String(cookieHeader || "").split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 1) continue;

    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (name && cookies[name] === undefined) cookies[name] = value;
  }

  return cookies;
}

export async function createReferralToken(partner, landingPath, secret, now = new Date()) {
  if (!secret) throw new Error("Missing referral signing secret");

  const capturedAt = new Date(now);
  const expiresAt = new Date(capturedAt.getTime() + ATTRIBUTION_WINDOW_MS);
  const canonicalLandingPath = `/${partner.id}`;
  const payload = {
    v: TOKEN_VERSION,
    partnerId: partner.id,
    capturedAt: capturedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    landingPath: landingPath === canonicalLandingPath ? landingPath : canonicalLandingPath
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const encodedPayload = bytesToBase64Url(payloadBytes);
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload)
  );

  return {
    token: `${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`,
    referral: {
      ...payload,
      partner
    }
  };
}

export function decideReferralClaim(existingReferral, requestedPartner) {
  if (existingReferral?.partner) {
    return {
      shouldCreate: false,
      reason: "first_touch_preserved",
      referral: existingReferral
    };
  }

  return {
    shouldCreate: Boolean(requestedPartner),
    reason: requestedPartner ? "claim_created" : "invalid_partner",
    referral: null
  };
}

export async function verifyReferralToken(
  token,
  secret,
  { now = new Date(), registry = PARTNER_REGISTRY } = {}
) {
  try {
    if (!secret) return null;

    const parts = String(token || "").split(".");
    if (parts.length !== 2) return null;

    const [encodedPayload, encodedSignature] = parts;
    const key = await importHmacKey(secret);
    const signatureIsValid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(encodedSignature),
      new TextEncoder().encode(encodedPayload)
    );
    if (!signatureIsValid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload)));
    if (!payload || payload.v !== TOKEN_VERSION) return null;

    const partner = getActivePartner(payload.partnerId, registry);
    if (!partner) return null;

    const capturedAtMs = Date.parse(payload.capturedAt);
    const expiresAtMs = Date.parse(payload.expiresAt);
    const nowMs = new Date(now).getTime();

    if (!Number.isFinite(capturedAtMs) || !Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
      return null;
    }
    if (capturedAtMs > nowMs + MAX_CLOCK_SKEW_MS || expiresAtMs <= nowMs) return null;
    if (expiresAtMs <= capturedAtMs || expiresAtMs - capturedAtMs !== ATTRIBUTION_WINDOW_MS) {
      return null;
    }
    if (payload.landingPath !== `/${partner.id}`) return null;

    return {
      ...payload,
      partner
    };
  } catch (_) {
    return null;
  }
}

export async function getReferralFromRequest(request, env, options = {}) {
  try {
    const secret = env?.REFERRAL_SIGNING_SECRET;
    if (!secret) return null;

    const cookies = parseCookies(request?.headers?.get("Cookie"));
    return await verifyReferralToken(cookies[REFERRAL_COOKIE_NAME], secret, options);
  } catch (_) {
    // Referral metadata is supplementary and must never prevent a booking.
    return null;
  }
}

export async function resolveReferralForBooking(request, fallbackToken, env, options = {}) {
  try {
    const cookieReferral = await getReferralFromRequest(request, env, options);
    if (cookieReferral) return cookieReferral;

    return await verifyReferralToken(
      String(fallbackToken || "").trim(),
      env?.REFERRAL_SIGNING_SECRET,
      options
    );
  } catch (_) {
    // Referral metadata is supplementary and must never prevent a booking.
    return null;
  }
}

export function serializeReferralCookie(
  token,
  expiresAt,
  now = new Date(),
  secure = true,
  domain = ""
) {
  const maxAgeSeconds = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - new Date(now).getTime()) / 1000)
  );
  const attributes = [
    `${REFERRAL_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${new Date(expiresAt).toUTCString()}`
  ];

  if (domain) attributes.push(`Domain=${domain}`);
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function buildReferralPrivateProperties(referral) {
  if (!referral?.partner) return {};

  return {
    salesChannel: "partner_referral",
    referralPartnerId: referral.partner.id,
    referralPartnerName: referral.partner.displayName,
    referralPartnerType: referral.partner.type,
    referralCapturedAt: referral.capturedAt,
    referralLandingPath: referral.landingPath,
    referralAttributionModel: REFERRAL_ATTRIBUTION_MODEL
  };
}

export function buildReferralDescriptionLines(referral) {
  if (!referral?.partner) return [];

  return [
    "Sales channel: Partner Referral",
    `Referral partner: ${referral.partner.displayName}`,
    `Referral ID: ${referral.partner.id}`,
    `Referral captured: ${referral.capturedAt}`,
    "Referral attribution: First Touch"
  ];
}
