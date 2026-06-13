import {
  getGoogleAccessToken,
  getGoogleCalendarErrorPayload,
  hasGoogleCalendarCredentials
} from "./_google.js";
import { notifyGyGAvailabilityForTourDates } from "./gyg/_notify_outbound.js";

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

function parseDates(url) {
  const explicitDates = cleanText(url.searchParams.get("dates"), 2000);

  if (explicitDates) {
    return explicitDates
      .split(/[,\s;]+/)
      .map((entry) => cleanText(entry, 20))
      .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
  }

  const singleDate = cleanText(url.searchParams.get("date"), 20);

  if (singleDate && /^\d{4}-\d{2}-\d{2}$/.test(singleDate)) {
    return [singleDate];
  }

  const countRaw = Number(url.searchParams.get("count") || 5);
  const count = Number.isFinite(countRaw) ? Math.min(Math.max(Math.trunc(countRaw), 1), 10) : 5;
  const startDate = new Date();
  const dates = [];

  for (let index = 0; index < count; index += 1) {
    const current = new Date(startDate.getTime());
    current.setUTCDate(startDate.getUTCDate() + index);
    dates.push(current.toISOString().slice(0, 10));
  }

  return dates;
}

async function runNotify(env, url) {
  const accessToken = await getGoogleAccessToken(env);
  const sandbox = parseBooleanFlag(url.searchParams.get("sandbox"), true);
  const tour = cleanText(url.searchParams.get("tour"), 80).toLowerCase() || "amor";
  const dates = parseDates(url);
  const result = await notifyGyGAvailabilityForTourDates(env, {
    accessToken,
    tour,
    dates,
    sandbox
  });
  const deliveries = (result.deliveries || []).map((entry) => ({
    tour,
    sandbox,
    ...entry
  }));

  return {
    ok: Boolean(result.ok) && deliveries.every((entry) => entry.ok || entry.skipped),
    tour,
    sandbox,
    requestedDates: dates,
    deliveries
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;

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
    const url = new URL(request.url);
    const result = await runNotify(env, url);
    return json(result);
  } catch (error) {
    return json(
      {
        ok: false,
        step: "gyg_push_availability_failed",
        ...(getGoogleCalendarErrorPayload(error) || {
          error: error?.message || "GYG push availability test failed."
        })
      },
      500
    );
  }
}

export const onRequestPost = onRequestGet;
