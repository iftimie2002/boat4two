import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getAnalyticsSessionId,
  getAnalyticsSource,
  makeBookingKey,
  queueAnalyticsEvent,
  recordAnalyticsEvent
} from "../functions/api/_analytics.js";
import {
  buildDailyConversionReport,
  getPreviousLisbonDayRange
} from "../functions/api/_analytics-report.js";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function makeInsertDb(options = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return {
            async run() {
              if (options.fail) throw new Error("analytics unavailable");
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
}

function makeReportDb(dailyEvents, lookbackEvents) {
  let call = 0;
  return {
    prepare() {
      return {
        bind() {
          const current = call++;
          return {
            async all() {
              return { results: current === 0 ? dailyEvents : lookbackEvents };
            }
          };
        }
      };
    }
  };
}

test("analytics accepts only anonymous UUID sessions and classifies acquisition sources", () => {
  assert.equal(getAnalyticsSessionId(SESSION_ID), SESSION_ID);
  assert.equal(getAnalyticsSessionId("customer@example.com"), "");

  assert.deepEqual(getAnalyticsSource({ partnerId: "kalkbrenner" }), {
    sourceType: "partner",
    sourceName: "kalkbrenner",
    referrerHost: "",
    utmSource: "",
    utmMedium: "",
    utmCampaign: ""
  });
  assert.equal(getAnalyticsSource({ referrer: "https://www.google.com/search?q=sailing" }).sourceType, "organic_search");
  assert.equal(getAnalyticsSource({ referrer: "https://example.com/article" }).sourceName, "example.com");
  assert.equal(getAnalyticsSource({}).sourceType, "direct");
});

test("booking correlation is one-way and analytics binding failure is non-blocking", async () => {
  const key = await makeBookingKey("secret-hold-id");
  assert.equal(key.length, 40);
  assert.doesNotMatch(key, /secret-hold-id/);

  assert.deepEqual(await recordAnalyticsEvent({}, {
    eventName: "session_started",
    sessionId: SESSION_ID
  }), { ok: false, recorded: false, reason: "binding_unavailable" });

  const waited = [];
  const context = {
    env: { ANALYTICS_DB: makeInsertDb({ fail: true }) },
    waitUntil(promise) {
      waited.push(promise);
    }
  };
  queueAnalyticsEvent(context, {
    eventName: "hold_created",
    sessionId: SESSION_ID,
    holdId: "hold-1"
  });
  await Promise.all(waited);
  assert.equal(waited.length, 1);
});

test("server booking events are deduplicated without storing raw hold IDs", async () => {
  const db = makeInsertDb();
  const result = await recordAnalyticsEvent({ ANALYTICS_DB: db }, {
    eventName: "payment_paid",
    sessionId: SESSION_ID,
    holdId: "raw-hold-id",
    amountCents: 19800,
    currency: "EUR"
  });

  assert.equal(result.recorded, true);
  const values = db.calls[0].values;
  assert.equal(values.includes("raw-hold-id"), false);
  assert.match(values.at(-1), /^payment_paid:[0-9a-f]{40}$/);
});

test("daily report covers sources, funnel, revenue, and unresolved pending payments", async () => {
  const now = new Date("2026-08-18T09:00:00.000Z");
  const daily = [
    { occurred_at: "2026-08-17T09:00:00.000Z", session_id: SESSION_ID, event_name: "session_started", source_type: "partner", source_name: "kalkbrenner", amount_cents: null },
    { occurred_at: "2026-08-17T09:01:00.000Z", session_id: SESSION_ID, event_name: "page_viewed", source_type: "partner", source_name: "kalkbrenner", amount_cents: null },
    { occurred_at: "2026-08-17T09:02:00.000Z", session_id: SESSION_ID, event_name: "booking_opened", source_type: "partner", source_name: "kalkbrenner", amount_cents: null },
    { occurred_at: "2026-08-17T09:03:00.000Z", session_id: SESSION_ID, event_name: "availability_viewed", source_type: "partner", source_name: "kalkbrenner", amount_cents: null },
    { occurred_at: "2026-08-17T09:04:00.000Z", session_id: SESSION_ID, event_name: "hold_created", source_type: "partner", source_name: "kalkbrenner", booking_key: "booking-paid", amount_cents: null },
    { occurred_at: "2026-08-17T09:05:00.000Z", session_id: SESSION_ID, event_name: "checkout_started", source_type: "partner", source_name: "kalkbrenner", booking_key: "booking-paid", amount_cents: 19800 },
    { occurred_at: "2026-08-17T09:06:00.000Z", session_id: SESSION_ID, event_name: "payment_submitted", source_type: "partner", source_name: "kalkbrenner", booking_key: "booking-paid", amount_cents: 19800 },
    { occurred_at: "2026-08-17T09:07:00.000Z", session_id: SESSION_ID, event_name: "payment_paid", source_type: "partner", source_name: "kalkbrenner", booking_key: "booking-paid", amount_cents: 19800 }
  ];
  const lookback = [
    ...daily.filter((event) => ["checkout_started", "payment_paid"].includes(event.event_name)),
    { occurred_at: "2026-08-17T05:00:00.000Z", session_id: "223e4567-e89b-42d3-a456-426614174000", event_name: "checkout_started", booking_key: "booking-pending", amount_cents: 21800, tour: "sunset" }
  ];
  const report = await buildDailyConversionReport({ ANALYTICS_DB: makeReportDb(daily, lookback) }, now);

  assert.equal(report.date, "2026-08-17");
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.paidBookings, 1);
  assert.equal(report.totals.revenueCents, 19800);
  assert.equal(report.totals.unresolvedPendingPayments, 1);
  assert.equal(report.totals.unresolvedPendingAmountCents, 21800);
  assert.equal(report.sources[0].sourceName, "kalkbrenner");
  assert.equal(report.sources[0].conversionRate, 100);
});

test("Lisbon report boundaries stay correct across daylight-saving time", () => {
  const summer = getPreviousLisbonDayRange(new Date("2026-08-18T09:00:00.000Z"));
  assert.equal(summer.start.toISOString(), "2026-08-16T23:00:00.000Z");
  assert.equal(summer.end.toISOString(), "2026-08-17T23:00:00.000Z");

  const winter = getPreviousLisbonDayRange(new Date("2026-12-18T09:00:00.000Z"));
  assert.equal(winter.start.toISOString(), "2026-12-17T00:00:00.000Z");
  assert.equal(winter.end.toISOString(), "2026-12-18T00:00:00.000Z");
});

test("frontend analytics sends no customer form fields and preserves payment implementation", async () => {
  const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const tracker = source.match(/function trackAnalytics\([\s\S]*?\n      }\n\n      function trackAnalyticsOnce/);

  assert.ok(tracker);
  assert.doesNotMatch(tracker[0], /formValues|customerEmail|customerPhone|customerName|message:/);
  assert.match(source, /analyticsSessionId/);
  assert.match(source, /sdk\.createPaymentForm\(/);
  assert.match(source, /currentMyposPaymentForm\.processPayment\(\)/);
});
