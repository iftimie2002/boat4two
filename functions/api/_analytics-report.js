import { ANALYTICS_RETENTION_DAYS } from "./_analytics.js";

const REPORT_TIMEZONE = "Europe/Lisbon";
const PAYMENT_PENDING_MINUTES = 120;
const MAX_REPORT_EVENTS = 10000;

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function timeZoneParts(date, timeZone = REPORT_TIMEZONE) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  return parts;
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const parts = timeZoneParts(date, timeZone);
  const utc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (utc - date.getTime()) / 60000;
}

function localMidnightToUtc(dateString, timeZone = REPORT_TIMEZONE) {
  const [year, month, day] = dateString.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offset = getTimeZoneOffsetMinutes(timeZone, guess);
  return new Date(guess.getTime() - offset * 60000);
}

export function getPreviousLisbonDayRange(now = new Date()) {
  const current = timeZoneParts(now);
  const localToday = new Date(Date.UTC(
    Number(current.year),
    Number(current.month) - 1,
    Number(current.day)
  ));
  const previous = new Date(localToday.getTime() - 86400000);
  const next = new Date(previous.getTime() + 86400000);
  const date = previous.toISOString().slice(0, 10);
  const nextDate = next.toISOString().slice(0, 10);

  return {
    date,
    start: localMidnightToUtc(date),
    end: localMidnightToUtc(nextDate)
  };
}

function uniqueCount(events, field) {
  return new Set(events.map((event) => cleanText(event[field], 160)).filter(Boolean)).size;
}

function countEvents(events, eventName) {
  return events.filter((event) => event.event_name === eventName).length;
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function sumCents(events) {
  return events.reduce((sum, event) => sum + Math.max(0, Number(event.amount_cents || 0)), 0);
}

function makeSourceKey(event) {
  const type = cleanText(event.source_type, 60) || "direct";
  const name = cleanText(event.source_name, 120) || "direct";
  return `${type}|${name}`;
}

function buildSessionSources(events) {
  const sources = new Map();
  const ordered = [...events].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));

  for (const event of ordered) {
    if (!event.session_id || sources.has(event.session_id)) continue;
    sources.set(event.session_id, {
      sourceType: cleanText(event.source_type, 60) || "direct",
      sourceName: cleanText(event.source_name, 120) || "direct",
      referrerHost: cleanText(event.referrer_host, 120),
      campaign: cleanText(event.utm_campaign, 100)
    });
  }

  return sources;
}

function summarizeSources(events, sessionSources) {
  const groups = new Map();
  const sessions = new Set(events.map((event) => event.session_id).filter(Boolean));

  for (const sessionId of sessions) {
    const source = sessionSources.get(sessionId) || { sourceType: "direct", sourceName: "direct" };
    const key = `${source.sourceType}|${source.sourceName}`;
    const group = groups.get(key) || {
      sourceType: source.sourceType,
      sourceName: source.sourceName,
      sessions: 0,
      holds: 0,
      checkouts: 0,
      paid: 0,
      revenueCents: 0
    };
    group.sessions += 1;

    const sessionEvents = events.filter((event) => event.session_id === sessionId);
    group.holds += sessionEvents.some((event) => event.event_name === "hold_created") ? 1 : 0;
    group.checkouts += sessionEvents.some((event) => event.event_name === "checkout_started") ? 1 : 0;
    const paid = sessionEvents.filter((event) => event.event_name === "payment_paid");
    group.paid += paid.length;
    group.revenueCents += sumCents(paid);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, conversionRate: percent(group.paid, group.sessions) }))
    .sort((a, b) => b.sessions - a.sessions || b.paid - a.paid)
    .slice(0, 20);
}

function summarizePending(events, now) {
  const bookings = new Map();

  for (const event of events) {
    if (!event.booking_key) continue;
    const booking = bookings.get(event.booking_key) || {
      bookingKey: event.booking_key,
      checkoutStartedAt: "",
      amountCents: 0,
      tour: "",
      finalState: ""
    };

    if (event.event_name === "checkout_started") {
      booking.checkoutStartedAt = event.occurred_at;
      booking.amountCents = Number(event.amount_cents || 0);
      booking.tour = event.tour || "";
    }

    if (["payment_paid", "payment_declined", "payment_cancelled", "payment_rolled_back"].includes(event.event_name)) {
      booking.finalState = event.event_name;
    }

    bookings.set(event.booking_key, booking);
  }

  const pendingCutoff = now.getTime() - PAYMENT_PENDING_MINUTES * 60000;
  return [...bookings.values()].filter((booking) => {
    if (!booking.checkoutStartedAt || booking.finalState) return false;
    const startedAt = new Date(booking.checkoutStartedAt).getTime();
    return Number.isFinite(startedAt) && startedAt <= pendingCutoff;
  });
}

export async function buildDailyConversionReport(env, now = new Date()) {
  if (!env?.ANALYTICS_DB) {
    return {
      ok: false,
      unavailable: true,
      error: "ANALYTICS_DB is not configured."
    };
  }

  const range = getPreviousLisbonDayRange(now);
  const lookback = new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * 86400000);
  const [dailyResult, lookbackResult] = await Promise.all([
    env.ANALYTICS_DB.prepare(`
      SELECT occurred_at, session_id, event_name, source_type, source_name,
             referrer_host, utm_campaign, tour, booking_key, amount_cents, currency,
             country_code, device_type
      FROM analytics_events
      WHERE is_test = 0 AND occurred_at >= ?1 AND occurred_at < ?2
      ORDER BY occurred_at ASC
      LIMIT ${MAX_REPORT_EVENTS}
    `).bind(range.start.toISOString(), range.end.toISOString()).all(),
    env.ANALYTICS_DB.prepare(`
      SELECT occurred_at, session_id, event_name, source_type, source_name,
             referrer_host, utm_campaign, tour, booking_key, amount_cents, currency,
             country_code, device_type
      FROM analytics_events
      WHERE is_test = 0 AND occurred_at >= ?1
        AND event_name IN ('checkout_started', 'payment_paid', 'payment_declined', 'payment_cancelled', 'payment_rolled_back')
      ORDER BY occurred_at ASC
      LIMIT ${MAX_REPORT_EVENTS}
    `).bind(lookback.toISOString()).all()
  ]);

  const events = dailyResult?.results || [];
  const lookbackEvents = lookbackResult?.results || [];
  const sessionSources = buildSessionSources(events);
  const sessions = uniqueCount(events, "session_id");
  const pageViews = countEvents(events, "page_viewed");
  const bookingOpened = uniqueCount(events.filter((event) => event.event_name === "booking_opened"), "session_id");
  const availabilityViewed = uniqueCount(events.filter((event) => event.event_name === "availability_viewed"), "session_id");
  const holds = countEvents(events, "hold_created");
  const checkouts = countEvents(events, "checkout_started");
  const submitted = countEvents(events, "payment_submitted");
  const paidEvents = events.filter((event) => event.event_name === "payment_paid");
  const declined = countEvents(events, "payment_declined");
  const cancelled = countEvents(events, "payment_cancelled") + countEvents(events, "payment_rolled_back");
  const pending = summarizePending(lookbackEvents, now);

  const reviewSessions = new Set(events.filter((event) => event.event_name === "review_viewed").map((event) => event.session_id));
  const checkoutSessions = new Set(events.filter((event) => event.event_name === "checkout_started").map((event) => event.session_id));
  const reviewDropoffs = [...reviewSessions].filter((sessionId) => sessionId && !checkoutSessions.has(sessionId)).length;

  return {
    ok: true,
    date: range.date,
    timezone: REPORT_TIMEZONE,
    generatedAt: now.toISOString(),
    retentionDays: ANALYTICS_RETENTION_DAYS,
    totals: {
      sessions,
      pageViews,
      bookingOpened,
      availabilityViewed,
      holds,
      checkouts,
      paymentSubmitted: submitted,
      paidBookings: paidEvents.length,
      revenueCents: sumCents(paidEvents),
      declinedPayments: declined,
      cancelledPayments: cancelled,
      reviewDropoffs,
      unresolvedPendingPayments: pending.length,
      unresolvedPendingAmountCents: pending.reduce((sum, booking) => sum + booking.amountCents, 0),
      visitorToPaidRate: percent(paidEvents.length, sessions),
      checkoutToPaidRate: percent(paidEvents.length, checkouts)
    },
    sources: summarizeSources(events, sessionSources),
    pending: pending.map((booking) => ({
      startedAt: booking.checkoutStartedAt,
      tour: booking.tour,
      amountCents: booking.amountCents
    })),
    truncated: events.length >= MAX_REPORT_EVENTS || lookbackEvents.length >= MAX_REPORT_EVENTS
  };
}

export async function applyAnalyticsRetention(env, now = new Date()) {
  if (!env?.ANALYTICS_DB) return { deleted: 0 };
  const cutoff = new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * 86400000).toISOString();
  const result = await env.ANALYTICS_DB.prepare(
    "DELETE FROM analytics_events WHERE occurred_at < ?1"
  ).bind(cutoff).run();
  return { deleted: Number(result?.meta?.changes || 0) };
}

export function formatReportMoney(cents, currency = "EUR") {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2
  }).format(Number(cents || 0) / 100);
}

export function getAnalyticsReportTimezone() {
  return REPORT_TIMEZONE;
}
