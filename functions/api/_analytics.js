const ANALYTICS_BINDING = "ANALYTICS_DB";
const DEFAULT_CURRENCY = "EUR";

export const ANALYTICS_RETENTION_DAYS = 90;

export const CLIENT_EVENT_NAMES = new Set([
  "session_started",
  "page_viewed",
  "booking_opened",
  "tour_selected",
  "availability_viewed",
  "date_selected",
  "time_selected",
  "details_started",
  "review_viewed",
  "checkout_loaded",
  "payment_submitted",
  "payment_cancelled"
]);

const SERVER_EVENT_NAMES = new Set([
  "hold_created",
  "checkout_started",
  "payment_paid",
  "payment_declined",
  "payment_cancelled",
  "payment_rolled_back"
]);

const ALL_EVENT_NAMES = new Set([...CLIENT_EVENT_NAMES, ...SERVER_EVENT_NAMES]);

function cleanText(value, max = 160) {
  return String(value || "").trim().slice(0, max);
}

function normalizePath(value) {
  const path = cleanText(value, 160);
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path.split("?")[0].split("#")[0] || "/";
}

function normalizeSessionId(value) {
  const sessionId = cleanText(value, 80).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)
    ? sessionId
    : "";
}

function normalizeTour(value) {
  const tour = cleanText(value, 40).toLowerCase();
  return ["amor", "sunset", "custom"].includes(tour) ? tour : "";
}

function normalizeCurrency(value) {
  const currency = cleanText(value, 3).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY;
}

function normalizeAmountCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) return null;
  return Math.round(amount);
}

function normalizeHost(value) {
  const raw = cleanText(value, 320);
  if (!raw) return "";

  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "").slice(0, 120);
  } catch {
    return "";
  }
}

function classifyDevice(userAgent) {
  const ua = cleanText(userAgent, 500).toLowerCase();
  if (/ipad|tablet|kindle|silk/.test(ua)) return "tablet";
  if (/mobile|iphone|ipod|android/.test(ua)) return "mobile";
  return "desktop";
}

function classifySource({ partnerId, utmSource, utmMedium, referrerHost, siteHost }) {
  if (partnerId) {
    return { sourceType: "partner", sourceName: partnerId };
  }

  if (utmSource) {
    return {
      sourceType: cleanText(utmMedium, 60).toLowerCase() || "campaign",
      sourceName: cleanText(utmSource, 80).toLowerCase()
    };
  }

  if (!referrerHost || referrerHost === siteHost || referrerHost.endsWith(`.${siteHost}`)) {
    return { sourceType: "direct", sourceName: "direct" };
  }

  if (/^(google|bing|duckduckgo|yahoo|ecosia)\./.test(referrerHost)) {
    return { sourceType: "organic_search", sourceName: referrerHost.split(".")[0] };
  }

  if (/(instagram|facebook|fb|tiktok|youtube|pinterest|linkedin)\./.test(referrerHost)) {
    return { sourceType: "social", sourceName: referrerHost };
  }

  return { sourceType: "referral", sourceName: referrerHost };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function makeBookingKey(holdId) {
  const normalized = cleanText(holdId, 160);
  return normalized ? (await sha256(`boat4two-booking:${normalized}`)).slice(0, 40) : "";
}

export function getAnalyticsSessionId(value) {
  return normalizeSessionId(value);
}

export function getAnalyticsSource(input = {}) {
  const referrerHost = normalizeHost(input.referrer);
  const siteHost = cleanText(input.siteHost, 120).toLowerCase().replace(/^www\./, "") || "boat4two.com";
  const utmSource = cleanText(input.utmSource, 80);
  const utmMedium = cleanText(input.utmMedium, 60);
  const source = classifySource({
    partnerId: cleanText(input.partnerId, 64).toLowerCase(),
    utmSource,
    utmMedium,
    referrerHost,
    siteHost
  });

  return {
    ...source,
    referrerHost,
    utmSource,
    utmMedium,
    utmCampaign: cleanText(input.utmCampaign, 100)
  };
}

export async function recordAnalyticsEvent(env, event = {}) {
  const db = env?.[ANALYTICS_BINDING];
  if (!db) {
    return { ok: false, recorded: false, reason: "binding_unavailable" };
  }

  const eventName = cleanText(event.eventName, 60).toLowerCase();
  if (!ALL_EVENT_NAMES.has(eventName)) {
    return { ok: false, recorded: false, reason: "invalid_event" };
  }

  const bookingKey = event.bookingKey || await makeBookingKey(event.holdId);
  const dedupeKey = cleanText(
    event.dedupeKey || (bookingKey && SERVER_EVENT_NAMES.has(eventName) ? `${eventName}:${bookingKey}` : ""),
    180
  );
  const source = getAnalyticsSource(event);
  const occurredAt = event.occurredAt instanceof Date
    ? event.occurredAt.toISOString()
    : (cleanText(event.occurredAt, 40) || new Date().toISOString());
  const sessionId = normalizeSessionId(event.sessionId);
  const id = crypto.randomUUID();

  const statement = db.prepare(`
    INSERT OR IGNORE INTO analytics_events (
      id, occurred_at, session_id, event_name, page_path,
      source_type, source_name, referrer_host, utm_source, utm_medium, utm_campaign,
      country_code, device_type, tour, booking_key, amount_cents, currency,
      is_test, detail, dedupe_key
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
  `).bind(
    id,
    occurredAt,
    sessionId,
    eventName,
    normalizePath(event.pagePath),
    source.sourceType,
    source.sourceName,
    source.referrerHost,
    source.utmSource,
    source.utmMedium,
    source.utmCampaign,
    cleanText(event.countryCode, 2).toUpperCase(),
    cleanText(event.deviceType, 16) || classifyDevice(event.userAgent),
    normalizeTour(event.tour),
    cleanText(bookingKey, 64),
    normalizeAmountCents(event.amountCents),
    normalizeCurrency(event.currency),
    event.isTest ? 1 : 0,
    cleanText(event.detail, 80),
    dedupeKey || null
  );

  const result = await statement.run();
  return {
    ok: true,
    recorded: Number(result?.meta?.changes || 0) > 0,
    duplicate: Number(result?.meta?.changes || 0) === 0
  };
}

export function queueAnalyticsEvent(context, event) {
  const task = recordAnalyticsEvent(context?.env, event).catch((error) => {
    console.warn("Boat4Two analytics event could not be recorded", {
      eventName: cleanText(event?.eventName, 60),
      error: cleanText(error?.message || "Unknown analytics error", 240)
    });
  });

  if (typeof context?.waitUntil === "function") {
    context.waitUntil(task);
  }

  return task;
}

export function getRequestAnalyticsContext(request) {
  const url = new URL(request.url);
  return {
    pagePath: url.pathname,
    siteHost: url.hostname,
    countryCode: request.cf?.country || "",
    userAgent: request.headers.get("user-agent") || ""
  };
}
