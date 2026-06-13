import {
  getBookingEmailDiagnostics,
  sendSystemEmail
} from "./_booking-email.js";

const DEFAULT_REPORT_TO_EMAIL = "info.boat4two@gmail.com";
const CHECK_TIMEZONE = "Europe/Lisbon";
const HOLD_TEST_NAME = "Daily Automation Check";
const HOLD_TEST_EMAIL = "info.boat4two@gmail.com";
const HOLD_TEST_PHONE = "+351000000000";
const HOLD_TEST_COUNTRY = "Portugal";
const HOLD_TEST_OCCASION = "automation";
const HOLD_TEST_MESSAGE = "Daily system check smoke test";

function cleanText(value, max = 400) {
  return String(value || "").trim().slice(0, max);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function getOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function getLisbonDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHECK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return parts;
}

function formatMonth(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function addMonths(baseDate, monthsToAdd) {
  const copy = new Date(baseDate.getTime());
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() + monthsToAdd);
  return copy;
}

function addDays(baseDate, daysToAdd) {
  const copy = new Date(baseDate.getTime());
  copy.setUTCDate(copy.getUTCDate() + daysToAdd);
  return copy;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeBody(body) {
  if (!body || typeof body !== "object") {
    return body;
  }

  return {
    ok: body.ok,
    status: body.status,
    provider: body.provider,
    authMode: body.authMode,
    message: body.message,
    error: body.error,
    deletedCount: body.deletedCount,
    releasedCount: body.releasedCount,
    exists: body.exists,
    expired: body.expired,
    holdId: body.holdId,
    eventId: body.eventId,
    month: body.month,
    availableDatesCount: Array.isArray(body.availableDates) ? body.availableDates.length : undefined,
    requestedDates: body.requestedDates,
    gygNotifyOk: body.gygNotify?.ok,
    deliveries: Array.isArray(body.deliveries)
      ? body.deliveries.map((entry) => ({
          date: entry.date,
          ok: entry.ok,
          status: entry.status,
          endpoint: entry.endpoint,
          response: entry.response
        }))
      : undefined
  };
}

async function fetchJson(origin, path, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("daily_system_check_timeout"), timeoutMs);

  let response = null;
  let body = null;

  try {
    response = await fetch(`${origin}${path}`, {
      ...init,
      signal: controller.signal
    });
    body = await response.json();
  } catch (error) {
    clearTimeout(timeout);
    return {
      httpOk: false,
      status: response?.status || 0,
      body: {
        ok: false,
        error: cleanText(error?.message || "Request timed out during daily system check.", 320)
      }
    };
  }

  clearTimeout(timeout);

  return {
    httpOk: response.ok,
    status: response.status,
    body
  };
}

function makeCheck(name, passed, details, error = "") {
  return {
    name,
    passed,
    error: cleanText(error || "", 600),
    details
  };
}

async function runAvailabilityCheck(origin, tour, month, options = {}) {
  const skipCleanup = options.skipCleanup === true;
  const path = [
    `/api/availability-calendar?tour=${encodeURIComponent(tour)}`,
    `month=${encodeURIComponent(month)}`,
    skipCleanup ? "skipCleanup=1" : ""
  ].filter(Boolean).join("&");
  const result = await fetchJson(
    origin,
    path
  );
  const availableDates = Array.isArray(result.body?.availableDates) ? result.body.availableDates : [];
  const passed = result.httpOk && result.body?.ok === true;

  return {
    check: makeCheck(
      `availability_${tour}`,
      passed,
      {
        month,
        availableDatesCount: availableDates.length,
        firstAvailableDates: availableDates.slice(0, 5)
      },
      !passed ? result.body?.error || `HTTP ${result.status}` : ""
    ),
    availableDates
  };
}

async function collectFutureAvailableDates(origin, tour, count = 5) {
  const now = new Date();
  const collected = [];

  for (let offset = 0; offset <= 6 && collected.length < count; offset += 1) {
    const month = formatMonth(addMonths(now, offset));
    const result = await runAvailabilityCheck(origin, tour, month, { skipCleanup: true });

    if (result.check.passed) {
      for (const date of result.availableDates) {
        if (!collected.includes(date)) {
          collected.push(date);
        }

        if (collected.length >= count) {
          break;
        }
      }
    }

    if (collected.length < count) {
      await sleep(800);
    }
  }

  return collected;
}

function getDeterministicFutureDates(count = 2, startOffsetDays = 90) {
  const today = new Date();

  return Array.from({ length: count }, (_, index) =>
    addDays(today, startOffsetDays + index).toISOString().slice(0, 10)
  );
}

async function runHoldLifecycleCheck(origin, preferredDates = null) {
  const futureDates = Array.isArray(preferredDates) && preferredDates.length
    ? preferredDates
    : await collectFutureAvailableDates(origin, "amor", 3);
  const selectedDate = futureDates[0] || "";

  if (!selectedDate) {
    return makeCheck(
      "hold_lifecycle",
      false,
      {
        selectedDate: null
      },
      "Could not find a safe future Amor Tour date for the hold smoke test."
    );
  }

  const attemptedTimes = ["10:00", "14:00"];
  let createResult = null;
  let selectedTime = "";
  let createError = "";

  for (const time of attemptedTimes) {
    createResult = await fetchJson(origin, "/api/create-hold", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tour: "amor",
        date: selectedDate,
        time,
        name: HOLD_TEST_NAME,
        email: HOLD_TEST_EMAIL,
        phone: HOLD_TEST_PHONE,
        country: HOLD_TEST_COUNTRY,
        occasion: HOLD_TEST_OCCASION,
        message: HOLD_TEST_MESSAGE
      })
    });

    if (createResult.httpOk && createResult.body?.ok) {
      selectedTime = time;
      break;
    }

    createError = cleanText(createResult.body?.error || `HTTP ${createResult.status}`, 240);
  }

  if (!createResult?.httpOk || !createResult.body?.ok || !createResult.body?.holdId) {
    return makeCheck(
      "hold_lifecycle",
      false,
      {
        selectedDate,
        attemptedTimes
      },
      createError || "Failed to create the daily hold smoke test."
    );
  }

  const holdId = cleanText(createResult.body.holdId, 160);
  const statusBefore = await fetchJson(
    origin,
    `/api/get-hold-status?holdId=${encodeURIComponent(holdId)}`
  );
  const releaseResult = await fetchJson(origin, "/api/release-hold", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ holdId })
  });
  const statusAfter = await fetchJson(
    origin,
    `/api/get-hold-status?holdId=${encodeURIComponent(holdId)}`
  );

  const beforeExists = statusBefore.body?.exists === true && statusBefore.body?.expired === false;
  const releaseOk = releaseResult.httpOk && releaseResult.body?.ok === true;
  const afterGone = statusAfter.body?.exists === false || statusAfter.body?.expired === true;
  const passed = beforeExists && releaseOk && afterGone;

  return makeCheck(
    "hold_lifecycle",
    passed,
    {
      selectedDate,
      selectedTime,
      holdId,
      create: summarizeBody(createResult.body),
      statusBefore: summarizeBody(statusBefore.body),
      release: summarizeBody(releaseResult.body),
      statusAfter: summarizeBody(statusAfter.body)
    },
    !passed
      ? cleanText(
          createError ||
          releaseResult.body?.error ||
          statusAfter.body?.error ||
          "Hold lifecycle smoke test did not complete cleanly.",
          320
        )
      : ""
  );
}

async function runDailySystemCheck(origin) {
  const now = new Date();
  const thisMonth = formatMonth(addMonths(now, 0));
  const futurePushDates = getDeterministicFutureDates(2, 90);
  const pushDateParam = futurePushDates.join(",");
  const googleResult = await fetchJson(origin, "/api/google-test");
  await sleep(1000);

  const [emailResult, myposResult] = await Promise.all([
    fetchJson(origin, "/api/email-test"),
    fetchJson(origin, "/api/mypos-test")
  ]);

  await sleep(1000);
  const amorAvailability = await runAvailabilityCheck(origin, "amor", thisMonth, { skipCleanup: true });
  await sleep(1000);
  const sunsetAvailability = await runAvailabilityCheck(origin, "sunset", thisMonth, { skipCleanup: true });
  await sleep(1000);

  let holdTestDates = amorAvailability.availableDates.slice(0, 3);
  if (!holdTestDates.length) {
    holdTestDates = await collectFutureAvailableDates(origin, "amor", 3);
  }

  const holdLifecycle = await runHoldLifecycleCheck(origin, holdTestDates);
  await sleep(1000);
  const cleanupResult = await fetchJson(origin, "/api/cleanup-holds");

  let gygPush = makeCheck(
    "gyg_push_availability_sandbox",
    false,
    {
      requestedDates: futurePushDates
    },
    "Could not find future available Amor Tour dates for the GYG push test."
  );

  if (futurePushDates.length >= 1) {
    const pushResult = await fetchJson(
      origin,
      `/api/gyg-push-availability-test?tour=amor&dates=${encodeURIComponent(pushDateParam)}&sandbox=1`
    );
    const allDeliveriesOk = Array.isArray(pushResult.body?.deliveries)
      && pushResult.body.deliveries.every((entry) => entry.ok === true);

    gygPush = makeCheck(
      "gyg_push_availability_sandbox",
      pushResult.httpOk && pushResult.body?.ok === true && allDeliveriesOk,
      summarizeBody(pushResult.body),
      !(pushResult.httpOk && pushResult.body?.ok === true && allDeliveriesOk)
        ? cleanText(pushResult.body?.error || `HTTP ${pushResult.status}`, 320)
        : ""
    );
  }

  const checks = [
    makeCheck(
      "google_calendar",
      googleResult.httpOk && googleResult.body?.ok === true && googleResult.body?.authMode === "service_account",
      summarizeBody(googleResult.body),
      !(googleResult.httpOk && googleResult.body?.ok === true && googleResult.body?.authMode === "service_account")
        ? cleanText(googleResult.body?.error || "Google calendar check failed or auth mode changed.", 320)
        : ""
    ),
    amorAvailability.check,
    sunsetAvailability.check,
    makeCheck(
      "email_transport",
      emailResult.httpOk && emailResult.body?.ok === true,
      summarizeBody(emailResult.body),
      !(emailResult.httpOk && emailResult.body?.ok === true)
        ? cleanText(emailResult.body?.error || `HTTP ${emailResult.status}`, 320)
        : ""
    ),
    makeCheck(
      "mypos_readiness",
      myposResult.httpOk && myposResult.body?.ok === true,
      summarizeBody(myposResult.body),
      !(myposResult.httpOk && myposResult.body?.ok === true)
        ? cleanText(myposResult.body?.error || myposResult.body?.message || `HTTP ${myposResult.status}`, 320)
        : ""
    ),
    makeCheck(
      "stale_slot_cleanup",
      cleanupResult.httpOk && cleanupResult.body?.ok === true,
      summarizeBody(cleanupResult.body),
      !(cleanupResult.httpOk && cleanupResult.body?.ok === true)
        ? cleanText(cleanupResult.body?.error || `HTTP ${cleanupResult.status}`, 320)
        : ""
    ),
    holdLifecycle,
    gygPush
  ];

  const failedChecks = checks.filter((check) => !check.passed);
  const lisbonParts = getLisbonDateParts(now);

  return {
    ok: failedChecks.length === 0,
    checkedAt: now.toISOString(),
    lisbonDate: `${lisbonParts.year}-${lisbonParts.month}-${lisbonParts.day}`,
    lisbonTime: `${lisbonParts.hour}:${lisbonParts.minute}:${lisbonParts.second}`,
    checks
  };
}

function buildReportText(report) {
  const lines = [
    `Boat4Two daily system check`,
    `Date (Lisbon): ${report.lisbonDate}`,
    `Time (Lisbon): ${report.lisbonTime}`,
    `Overall status: ${report.ok ? "OK" : "FAILED"}`,
    ""
  ];

  for (const check of report.checks) {
    lines.push(`[${check.passed ? "PASS" : "FAIL"}] ${check.name}`);
    if (check.error) {
      lines.push(`Error: ${check.error}`);
    }
    lines.push(`Details: ${JSON.stringify(check.details)}`);
    lines.push("");
  }

  return lines.join("\n");
}

function buildReportHtml(report) {
  const rows = report.checks.map((check) => `
    <tr>
      <td style="padding:10px 12px;border:1px solid #eadfd9;font-weight:700;color:${check.passed ? "#1f6f43" : "#9b1c1c"};">
        ${check.passed ? "PASS" : "FAIL"}
      </td>
      <td style="padding:10px 12px;border:1px solid #eadfd9;color:#211611;">${check.name}</td>
      <td style="padding:10px 12px;border:1px solid #eadfd9;color:#4a3b34;">${check.error ? check.error : "OK"}</td>
      <td style="padding:10px 12px;border:1px solid #eadfd9;color:#4a3b34;"><pre style="margin:0;white-space:pre-wrap;font:12px/1.5 Menlo,monospace;">${JSON.stringify(check.details, null, 2)}</pre></td>
    </tr>
  `).join("");

  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f8f6f6;color:#211611;font-family:Arial,sans-serif;">
  <div style="max-width:960px;margin:0 auto;background:#ffffff;border:1px solid #eadfd9;border-radius:20px;padding:24px;">
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#e65e19;">Boat4Two</p>
    <h1 style="margin:0 0 10px;font-size:28px;line-height:1.2;">Daily system check ${report.ok ? "OK" : "FAILED"}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#4a3b34;">
      Checked at ${report.lisbonDate} ${report.lisbonTime} (${CHECK_TIMEZONE}).
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.6;">
      <thead>
        <tr>
          <th style="padding:10px 12px;border:1px solid #eadfd9;background:#fff7f3;text-align:left;">Status</th>
          <th style="padding:10px 12px;border:1px solid #eadfd9;background:#fff7f3;text-align:left;">Check</th>
          <th style="padding:10px 12px;border:1px solid #eadfd9;background:#fff7f3;text-align:left;">Summary</th>
          <th style="padding:10px 12px;border:1px solid #eadfd9;background:#fff7f3;text-align:left;">Details</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

async function sendDailyReportEmail(env, report) {
  const diagnostics = getBookingEmailDiagnostics(env);
  const toEmail = cleanText(env.DAILY_SYSTEM_CHECK_TO_EMAIL, 200) || DEFAULT_REPORT_TO_EMAIL;
  const subject = report.ok
    ? `Boat4Two Daily System Check OK - ${report.lisbonDate}`
    : `URGENT: Boat4Two Daily System Check FAILED - ${report.lisbonDate}`;

  const payload = {
    to: toEmail,
    from: {
      email: diagnostics.fromEmail,
      name: "Boat4Two Reservations"
    },
    replyTo: {
      email: diagnostics.replyToEmail,
      name: "Boat4Two Reservations"
    },
    subject,
    text: buildReportText(report),
    html: buildReportHtml(report)
  };

  return sendSystemEmail(env, payload);
}

function isAuthorized(request, env) {
  const configuredKey = cleanText(env.DAILY_SYSTEM_CHECK_KEY, 400);

  if (!configuredKey) {
    return {
      ok: false,
      reason: "Missing DAILY_SYSTEM_CHECK_KEY in Cloudflare environment."
    };
  }

  const header = cleanText(request.headers.get("authorization"), 600);
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const queryKey = cleanText(new URL(request.url).searchParams.get("key"), 600);
  const supplied = bearer || queryKey;

  if (!supplied || supplied !== configuredKey) {
    return {
      ok: false,
      reason: "Unauthorized daily system check request."
    };
  }

  return { ok: true };
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

  const origin = getOrigin(request);
  const report = await runDailySystemCheck(origin);

  try {
    const emailResult = await sendDailyReportEmail(env, report);
    const status = report.ok ? 200 : 500;

    return json(
      {
        ...report,
        emailDelivery: {
          ok: true,
          messageId: cleanText(emailResult?.messageId, 200)
        }
      },
      status
    );
  } catch (error) {
    return json(
      {
        ...report,
        emailDelivery: {
          ok: false,
          error: cleanText(error?.message || "Daily report email could not be sent.", 320)
        }
      },
      500
    );
  }
}

export const onRequestPost = onRequestGet;
