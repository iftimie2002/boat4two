import {
  getGoogleAccessToken,
  getGoogleCalendarErrorPayload,
  hasGoogleCalendarCredentials
} from "./_google.js";
import { GYG_RULES } from "./gyg/_shared.js";
import { notifyGyGAvailabilityForTourDates } from "./gyg/_notify_outbound.js";

const DEFAULT_SYNC_DAYS = 365;
const MAX_SYNC_DAYS = 730;
const DEFAULT_BATCH_DAYS = 60;
const MAX_BATCH_DAYS = 90;
const DEFAULT_TOURS = ["amor", "sunset"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function parseBooleanFlag(value, fallback = false) {
  const normalized = cleanText(value, 20).toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInteger(value, fallback, max) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const values = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return values;
}

function getTodayInTimeZone(timeZone) {
  const parts = getDatePartsInTimeZone(new Date(), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateString(dateStr, days) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));

  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function parseDateList(value) {
  return cleanText(value, 4000)
    .split(/[,\s;]+/)
    .map((entry) => cleanText(entry, 20))
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
}

function getSyncDates(url) {
  const explicitDates = parseDateList(url.searchParams.get("dates"));

  if (explicitDates.length) {
    return Array.from(new Set(explicitDates)).slice(0, MAX_SYNC_DAYS);
  }

  const singleDate = cleanText(url.searchParams.get("date"), 20);

  if (/^\d{4}-\d{2}-\d{2}$/.test(singleDate)) {
    return [singleDate];
  }

  const days = parsePositiveInteger(
    url.searchParams.get("days"),
    DEFAULT_SYNC_DAYS,
    MAX_SYNC_DAYS
  );
  const start = /^\d{4}-\d{2}-\d{2}$/.test(cleanText(url.searchParams.get("start"), 20))
    ? cleanText(url.searchParams.get("start"), 20)
    : getTodayInTimeZone(GYG_RULES.timezone);

  return Array.from({ length: days }, (_, index) => addDaysToDateString(start, index));
}

function getSyncTours(url) {
  const requested = cleanText(url.searchParams.get("tour"), 200).toLowerCase();

  if (!requested || requested === "all") {
    return DEFAULT_TOURS;
  }

  return requested
    .split(/[,\s;]+/)
    .map((entry) => cleanText(entry, 80).toLowerCase())
    .filter((entry) => DEFAULT_TOURS.includes(entry));
}

function chunkDates(dates, batchSize) {
  const chunks = [];

  for (let index = 0; index < dates.length; index += batchSize) {
    chunks.push(dates.slice(index, index + batchSize));
  }

  return chunks;
}

function summarizeDelivery(delivery) {
  const availabilities = delivery?.payload?.data?.availabilities || [];

  return {
    productId: delivery.productId,
    date: delivery.date,
    dates: delivery.dates,
    ok: Boolean(delivery.ok),
    skipped: Boolean(delivery.skipped),
    reason: cleanText(delivery.reason, 120) || undefined,
    status: delivery.status || undefined,
    endpointUrl: delivery.endpointUrl,
    vacancySummary: availabilities.map((item) => ({
      dateTime: item.dateTime,
      vacancies: item.vacancies
    })),
    responseBody: delivery.responseBody
  };
}

function isAuthorized(request, env) {
  const configuredKey = cleanText(env.GYG_SYNC_KEY || env.DAILY_SYSTEM_CHECK_KEY, 600);

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
      reason: "Unauthorized GYG availability sync request."
    };
  }

  return { ok: true };
}

async function runSync(env, url) {
  const accessToken = await getGoogleAccessToken(env);
  const sandbox = parseBooleanFlag(url.searchParams.get("sandbox"), false);
  const dates = getSyncDates(url);
  const tours = getSyncTours(url);
  const batchDays = parsePositiveInteger(
    url.searchParams.get("batchDays"),
    DEFAULT_BATCH_DAYS,
    MAX_BATCH_DAYS
  );
  const dateChunks = chunkDates(dates, batchDays);
  const results = [];

  for (const tour of tours) {
    for (const dateChunk of dateChunks) {
      const result = await notifyGyGAvailabilityForTourDates(env, {
        accessToken,
        tour,
        dates: dateChunk,
        sandbox
      });

      results.push({
        tour,
        dateCount: dateChunk.length,
        firstDate: dateChunk[0] || null,
        lastDate: dateChunk[dateChunk.length - 1] || null,
        ok: Boolean(result.ok),
        deliveries: (result.deliveries || []).map(summarizeDelivery)
      });
    }
  }

  return {
    ok: results.every((entry) => entry.ok),
    sandbox,
    tours,
    dateCount: dates.length,
    batchDays,
    batchCount: dateChunks.length,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    checkedAt: new Date().toISOString(),
    results
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
        error: "Missing required Google calendar environment variables."
      },
      500
    );
  }

  try {
    const result = await runSync(env, new URL(request.url));
    return json(result, result.ok ? 200 : 502);
  } catch (error) {
    return json(
      {
        ok: false,
        step: "gyg_availability_sync_failed",
        ...(getGoogleCalendarErrorPayload(error) || {
          error: error?.message || "GYG availability sync failed."
        })
      },
      500
    );
  }
}

export const onRequestPost = onRequestGet;
