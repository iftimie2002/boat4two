import {
  GYG_RULES,
  enumerateSlots,
  formatGyGDateTime,
  getBusyRanges,
  getGyGProduct,
  slotHasAvailability
} from "./_shared.js";

const GYG_NOTIFY_PRODUCTION_URL = "https://supplier-api.getyourguide.com/1/notify-availability-update";
const GYG_NOTIFY_SANDBOX_URL = "https://supplier-api.getyourguide.com/sandbox/1/notify-availability-update";

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = formatter.formatToParts(date);
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const asUtcTimestamp = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return (asUtcTimestamp - date.getTime()) / 60000;
}

function makeDateInTimeZone(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute, second = 0] = timeStr.split(":").map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, utcGuess);

  return new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
}

function parseBasicAuthCredentialEntry(value) {
  const entry = cleanText(value, 600);
  const separatorIndex = entry.indexOf(":");

  if (!entry || separatorIndex <= 0) {
    return null;
  }

  return {
    username: entry.slice(0, separatorIndex),
    password: entry.slice(separatorIndex + 1)
  };
}

function getGyGNotifyCredentials(env) {
  const pairs = [
    [env.GYG_NOTIFY_USERNAME, env.GYG_NOTIFY_PASSWORD],
    [env.GYG_ENDPOINTS_USERNAME, env.GYG_ENDPOINTS_PASSWORD],
    [env.GYG_GETYOURGUIDE_USERNAME, env.GYG_GETYOURGUIDE_PASSWORD]
  ];

  for (const [username, password] of pairs) {
    if (cleanText(username, 200) && cleanText(password, 400)) {
      return {
        username: cleanText(username, 200),
        password: cleanText(password, 400)
      };
    }
  }

  return parseBasicAuthCredentialEntry(env.GYG_NOTIFY_BASIC_AUTH_CREDENTIALS);
}

function getGyGNotifyEndpointUrl(env, sandbox = false) {
  if (sandbox) {
    return cleanText(env.GYG_NOTIFY_SANDBOX_URL, 400) || GYG_NOTIFY_SANDBOX_URL;
  }

  return cleanText(env.GYG_NOTIFY_URL, 400) || GYG_NOTIFY_PRODUCTION_URL;
}

function getGyGProductIdsForTour(tour) {
  return Object.entries(GYG_RULES.products)
    .filter(([, product]) => product.tour === tour)
    .map(([productId]) => productId);
}

function normalizeDateList(dates) {
  return Array.from(
    new Set(
      (Array.isArray(dates) ? dates : [dates])
        .map((entry) => cleanText(entry, 20))
        .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
    )
  ).sort();
}

async function buildNotifyAvailabilityPayload(env, accessToken, productId, dates) {
  const product = getGyGProduct(productId);

  if (!product) {
    throw new Error(`Unknown GetYourGuide product ${productId}.`);
  }

  const normalizedDates = normalizeDateList(dates);

  if (!normalizedDates.length) {
    throw new Error("At least one valid availability date is required.");
  }

  const firstDate = normalizedDates[0];
  const lastDate = normalizedDates[normalizedDates.length - 1];
  const fromDate = makeDateInTimeZone(firstDate, "00:00:00", GYG_RULES.timezone);
  const toDate = makeDateInTimeZone(lastDate, "23:59:59", GYG_RULES.timezone);
  const busyRanges = await getBusyRanges(
    env,
    accessToken,
    fromDate.toISOString(),
    toDate.toISOString()
  );
  const slots = normalizedDates.flatMap((date) => {
    const dayStart = makeDateInTimeZone(date, "00:00:00", GYG_RULES.timezone);
    const dayEnd = makeDateInTimeZone(date, "23:59:59", GYG_RULES.timezone);
    return enumerateSlots(productId, dayStart, dayEnd);
  });

  return {
    data: {
      productId,
      availabilities: slots.map((slot) => ({
        dateTime: formatGyGDateTime(slot.start),
        vacancies: slotHasAvailability(slot, busyRanges) ? product.participantMax : 0
      }))
    }
  };
}

async function postGyGNotifyAvailability(env, payload, sandbox = false) {
  const credentials = getGyGNotifyCredentials(env);

  if (!credentials?.username || !credentials?.password) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_credentials"
    };
  }

  const endpointUrl = getGyGNotifyEndpointUrl(env, sandbox);
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const rawText = await response.text();

  let responseBody = null;
  try {
    responseBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    responseBody = rawText || null;
  }

  return {
    ok: response.ok,
    status: response.status,
    endpointUrl,
    payload,
    responseBody,
    requestedAt: new Date().toISOString()
  };
}

export async function notifyGyGAvailabilityForTourDate(env, {
  accessToken,
  tour,
  date,
  sandbox = false
}) {
  return notifyGyGAvailabilityForTourDates(env, {
    accessToken,
    tour,
    dates: [date],
    sandbox
  });
}

export async function notifyGyGAvailabilityForTourDates(env, {
  accessToken,
  tour,
  dates,
  sandbox = false
}) {
  const normalizedTour = cleanText(tour, 80).toLowerCase();
  const normalizedDates = normalizeDateList(dates);

  if (!normalizedTour || !normalizedDates.length) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_tour_or_dates",
      deliveries: []
    };
  }

  const productIds = getGyGProductIdsForTour(normalizedTour);

  if (!productIds.length) {
    return {
      ok: true,
      skipped: true,
      reason: "no_mapped_products",
      deliveries: []
    };
  }

  const deliveries = [];

  for (const productId of productIds) {
    const payload = await buildNotifyAvailabilityPayload(
      env,
      accessToken,
      productId,
      normalizedDates
    );
    const delivery = await postGyGNotifyAvailability(env, payload, sandbox);
    deliveries.push({
      productId,
      date: normalizedDates.length === 1 ? normalizedDates[0] : undefined,
      dates: normalizedDates,
      ...delivery
    });
  }

  return {
    ok: deliveries.every((entry) => entry.ok || entry.skipped),
    deliveries
  };
}

export async function notifyGyGAvailabilityForEvents(env, {
  accessToken,
  deletedEvents = [],
  sandbox = false
}) {
  const seen = new Set();
  const deliveries = [];

  for (const event of deletedEvents) {
    const tour = cleanText(event?.tour, 80).toLowerCase();
    const date = cleanText(event?.date, 20);

    if (!tour || !date) {
      continue;
    }

    const key = `${tour}:${date}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const result = await notifyGyGAvailabilityForTourDate(env, {
      accessToken,
      tour,
      date,
      sandbox
    });
    deliveries.push(...(result.deliveries || []));
  }

  return {
    ok: deliveries.every((entry) => entry.ok || entry.skipped),
    deliveries
  };
}
