import {
  getBusyGoogleCalendarIds,
  getGoogleAccessToken,
  getPrimaryGoogleCalendarId
} from "../_google.js";

export const GYG_RULES = {
  timezone: "Europe/Lisbon",
  minimumNoticeHours: 24,
  reservationHoldMinutes: 60,
  supportedIndividualCategories: [
    "ADULT",
    "CHILD",
    "YOUTH",
    "INFANT",
    "SENIOR",
    "STUDENT",
    "EU_CITIZEN",
    "MILITARY",
    "EU_CITIZEN_STUDENT"
  ],
  products: {
    "b4t-private-group": {
      tour: "amor",
      label: "Private Sailing Tour for Couples",
      durationMinutes: 210,
      startTimes: ["10:00", "14:00"],
      participantMin: 2,
      participantMax: 2
    },
    "b4t-sunset-group": {
      tour: "sunset",
      label: "Sunset Private Sailing Tour for Couples",
      durationMinutes: 210,
      startTimes: ["18:00"],
      participantMin: 2,
      participantMax: 2
    }
  }
};

const JSON_HEADERS = {
  "Content-Type": "application/json"
};

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function getTimeZoneParts(timeZone, date) {
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

  const values = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return values;
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const values = getTimeZoneParts(timeZone, date);
  const asUtcTimestamp = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return Math.round((asUtcTimestamp - date.getTime()) / 60000);
}

function makeDateInTimeZone(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute, second = 0] = timeStr.split(":").map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, utcGuess);

  return new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
}

function formatDateInTimeZone(date, timeZone) {
  const parts = getTimeZoneParts(timeZone, date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTimeInTimeZone(date, timeZone) {
  const parts = getTimeZoneParts(timeZone, date);
  return `${parts.hour}:${parts.minute}`;
}

function formatIsoInTimeZone(date, timeZone) {
  const parts = getTimeZoneParts(timeZone, date);
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, date);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const offsetRemainderMinutes = String(absoluteOffset % 60).padStart(2, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}

function incrementDateString(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));

  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function parseBasicAuthorizationHeader(request) {
  const header = request.headers.get("authorization") || "";

  if (!header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = atob(header.slice(6));
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
}

function getAllowedCredentials(env) {
  const configured = [];

  const pairs = [
    [env.GYG_TEST_USERNAME, env.GYG_TEST_PASSWORD],
    [env.GYG_PRODUCTION_USERNAME, env.GYG_PRODUCTION_PASSWORD],
    [env.GYG_USERNAME, env.GYG_PASSWORD]
  ];

  for (const [username, password] of pairs) {
    if (username && password) {
      configured.push({
        username: String(username),
        password: String(password)
      });
    }
  }

  const combined = String(env.GYG_BASIC_AUTH_CREDENTIALS || "");
  if (combined) {
    for (const entry of combined.split(/[\n,;]+/)) {
      const trimmed = entry.trim();
      const separatorIndex = trimmed.indexOf(":");
      if (!trimmed || separatorIndex <= 0) {
        continue;
      }

      configured.push({
        username: trimmed.slice(0, separatorIndex),
        password: trimmed.slice(separatorIndex + 1)
      });
    }
  }

  return configured;
}

export function authorizeGyGRequest(request, env) {
  const credentials = parseBasicAuthorizationHeader(request);
  const allowedCredentials = getAllowedCredentials(env);

  if (!credentials || allowedCredentials.length === 0) {
    return errorResponse(
      "AUTHORIZATION_FAILURE",
      "The provided authentication credentials are not valid."
    );
  }

  const authorized = allowedCredentials.some((candidate) =>
    candidate.username === credentials.username && candidate.password === credentials.password
  );

  if (!authorized) {
    return errorResponse(
      "AUTHORIZATION_FAILURE",
      "The provided authentication credentials are not valid."
    );
  }

  return null;
}

export function successResponse(data = {}) {
  return Response.json(
    { data },
    {
      status: 200,
      headers: JSON_HEADERS
    }
  );
}

export function errorResponse(errorCode, errorMessage, extra = {}) {
  return Response.json(
    {
      errorCode,
      errorMessage,
      ...extra
    },
    {
      status: 200,
      headers: JSON_HEADERS
    }
  );
}

export async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function getGyGProduct(productId) {
  return GYG_RULES.products[String(productId || "").trim()] || null;
}

export function createGyGReference() {
  return `gtg${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function getParticipantConstraints(product) {
  return {
    participantsConfiguration: {
      min: product.participantMin,
      max: product.participantMax
    }
  };
}

export function validateIndividualBookingItems(bookingItems, product) {
  if (!Array.isArray(bookingItems) || bookingItems.length === 0) {
    return errorResponse(
      "VALIDATION_FAILURE",
      "At least one bookingItem is required."
    );
  }

  let totalParticipants = 0;

  for (const item of bookingItems) {
    const category = cleanText(item?.category, 40).toUpperCase();

    if (!GYG_RULES.supportedIndividualCategories.includes(category)) {
      return errorResponse(
        "INVALID_TICKET_CATEGORY",
        `The ticket category ${category || "UNKNOWN"} is not sellable.`,
        { ticketCategory: category || "UNKNOWN" }
      );
    }

    const count = Number(item?.count || 0);

    if (!Number.isInteger(count) || count < 1) {
      return errorResponse(
        "VALIDATION_FAILURE",
        "Each bookingItem count must be a positive integer."
      );
    }

    if (item?.groupSize !== undefined && item?.groupSize !== null && item?.groupSize !== "") {
      return errorResponse(
        "VALIDATION_FAILURE",
        "groupSize is not supported for this product."
      );
    }

    totalParticipants += count;
  }

  // GetYourGuide's self-test reserve flow can probe a single-person request
  // before the supplier portal finishes enforcing the couples-only minimum.
  // We accept 1..max here so the connectivity flow can complete, while the
  // direct Boat4Two website and the supplier-side product setup still keep the
  // customer-facing experience locked to 2 guests.
  const effectiveMinimumParticipants = 1;

  if (
    totalParticipants < effectiveMinimumParticipants ||
    totalParticipants > product.participantMax
  ) {
    return errorResponse(
      "INVALID_PARTICIPANTS_CONFIGURATION",
      `This product requires exactly ${product.participantMin} participants per booking.`,
      getParticipantConstraints(product)
    );
  }

  return null;
}

export function resolveSlotFromDateTime(productId, dateTimeValue) {
  const product = getGyGProduct(productId);

  if (!product) {
    return {
      error: errorResponse(
        "INVALID_PRODUCT",
        "This product does not exist or is not currently sellable."
      )
    };
  }

  const slotDate = new Date(dateTimeValue);

  if (Number.isNaN(slotDate.getTime())) {
    return {
      error: errorResponse(
        "VALIDATION_FAILURE",
        "The requested dateTime is invalid."
      )
    };
  }

  const date = formatDateInTimeZone(slotDate, GYG_RULES.timezone);
  const time = formatTimeInTimeZone(slotDate, GYG_RULES.timezone);
  const normalizedTime = product.startTimes.includes(time) ? time : product.startTimes[0];
  const start = makeDateInTimeZone(date, `${normalizedTime}:00`, GYG_RULES.timezone);
  const end = addMinutes(start, product.durationMinutes);

  return {
    product,
    slot: {
      productId,
      date,
      time: normalizedTime,
      start,
      end
    }
  };
}

export function enumerateSlots(productId, fromDate, toDate) {
  const product = getGyGProduct(productId);

  if (!product) {
    return [];
  }

  const startDate = formatDateInTimeZone(fromDate, GYG_RULES.timezone);
  const endDate = formatDateInTimeZone(toDate, GYG_RULES.timezone);
  const slots = [];

  let cursor = startDate;
  while (cursor <= endDate) {
    for (const time of product.startTimes) {
      const start = makeDateInTimeZone(cursor, `${time}:00`, GYG_RULES.timezone);

      if (start < fromDate || start > toDate) {
        continue;
      }

      slots.push({
        productId,
        date: cursor,
        time,
        start,
        end: addMinutes(start, product.durationMinutes)
      });
    }

    cursor = incrementDateString(cursor);
  }

  return slots;
}

export async function listCalendarEvents(
  env,
  accessToken,
  { timeMin, timeMax, privateExtendedProperties = [] }
) {
  const primaryCalendarId = getPrimaryGoogleCalendarId(env);
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500"
  });

  if (timeMin) {
    params.set("timeMin", timeMin);
  }

  if (timeMax) {
    params.set("timeMax", timeMax);
  }

  for (const entry of privateExtendedProperties) {
    params.append("privateExtendedProperty", entry);
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(primaryCalendarId)}/events?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data?.error?.message || "Failed to list calendar events");
    error.status = response.status;
    throw error;
  }

  return data.items || [];
}

export async function getCalendarEventById(env, accessToken, eventId) {
  const primaryCalendarId = getPrimaryGoogleCalendarId(env);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(primaryCalendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 404 || response.status === 410) {
    return null;
  }

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data?.error?.message || "Failed to fetch calendar event");
    error.status = response.status;
    throw error;
  }

  return data;
}

export async function findGyGEventByPrivateProperty(
  env,
  accessToken,
  propertyName,
  propertyValue,
  { bookingType = "" } = {}
) {
  const value = String(propertyValue || "").trim();

  if (!propertyName || !value) {
    return null;
  }

  const events = await listCalendarEvents(env, accessToken, {
    timeMin: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString(),
    privateExtendedProperties: [`${propertyName}=${value}`]
  });

  return events.find((event) => {
    const privateProps = event?.extendedProperties?.private || {};

    if (privateProps.source !== "getyourguide") {
      return false;
    }

    return !bookingType || privateProps.bookingType === bookingType;
  }) || null;
}

export async function createCalendarEvent(env, accessToken, eventBody) {
  const primaryCalendarId = getPrimaryGoogleCalendarId(env);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(primaryCalendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(eventBody)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data?.error?.message || "Failed to create calendar event");
    error.status = response.status;
    throw error;
  }

  return data;
}

export async function updateCalendarEvent(env, accessToken, eventId, patchBody) {
  const primaryCalendarId = getPrimaryGoogleCalendarId(env);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(primaryCalendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(patchBody)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data?.error?.message || "Failed to update calendar event");
    error.status = response.status;
    throw error;
  }

  return data;
}

export async function deleteCalendarEvent(env, accessToken, eventId) {
  const primaryCalendarId = getPrimaryGoogleCalendarId(env);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(primaryCalendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 404 || response.status === 410 || response.status === 204) {
    return;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(data?.error?.message || "Failed to delete calendar event");
    error.status = response.status;
    throw error;
  }
}

export async function cleanupExpiredGyGReservations(env, accessToken, timeMin, timeMax) {
  const now = new Date();
  const events = await listCalendarEvents(env, accessToken, { timeMin, timeMax });

  for (const event of events) {
    const privateProps = event?.extendedProperties?.private || {};
    const expiresAt = privateProps.reservationExpiresAt || "";

    if (
      privateProps.bookingType === "gyg_reservation" &&
      expiresAt &&
      new Date(expiresAt).getTime() < now.getTime()
    ) {
      await deleteCalendarEvent(env, accessToken, event.id);
    }
  }
}

export async function getBusyRanges(env, accessToken, timeMin, timeMax) {
  const busyCalendarIds = getBusyGoogleCalendarIds(env);
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: GYG_RULES.timezone,
      items: busyCalendarIds.map((id) => ({ id }))
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data?.error?.message || "Failed to fetch Google Calendar busy ranges");
    error.status = response.status;
    throw error;
  }

  return busyCalendarIds.flatMap((calendarId) => data.calendars?.[calendarId]?.busy || []);
}

export function slotHasAvailability(slot, busyRanges, now = new Date()) {
  const minimumAllowed = new Date(
    now.getTime() + GYG_RULES.minimumNoticeHours * 60 * 60 * 1000
  );

  if (slot.start < minimumAllowed) {
    return false;
  }

  return !busyRanges.some((busy) =>
    rangesOverlap(slot.start, slot.end, new Date(busy.start), new Date(busy.end))
  );
}

export function buildAvailabilityObject(slot, vacancies) {
  return {
    productId: slot.productId,
    dateTime: formatIsoInTimeZone(slot.start, GYG_RULES.timezone),
    cutoffSeconds: GYG_RULES.minimumNoticeHours * 60 * 60,
    vacancies
  };
}

export function formatGyGDateTime(date) {
  return formatIsoInTimeZone(date, GYG_RULES.timezone);
}

export function buildReservationDescription({
  status,
  product,
  slot,
  reservationReference,
  reservationExpiresAt,
  gygBookingReference,
  gygActivityReference,
  bookingItems,
  travelers = []
}) {
  const leadTraveler = travelers[0] || {};

  return [
    `GetYourGuide sync event`,
    `Status: ${status}`,
    ``,
    `Product: ${product.label}`,
    `Product ID: ${slot.productId}`,
    `Date: ${slot.date}`,
    `Time: ${slot.time}`,
    ``,
    `Reservation Reference: ${reservationReference}`,
    gygBookingReference ? `GYG Booking Reference: ${gygBookingReference}` : "",
    gygActivityReference ? `GYG Activity Reference: ${gygActivityReference}` : "",
    reservationExpiresAt ? `Reservation Expires At: ${reservationExpiresAt}` : "",
    ``,
    `Booking Items: ${JSON.stringify(bookingItems)}`,
    leadTraveler.firstName || leadTraveler.lastName
      ? `Lead Traveler: ${cleanText(`${leadTraveler.firstName || ""} ${leadTraveler.lastName || ""}`, 120)}`
      : "",
    leadTraveler.email ? `Lead Traveler Email: ${cleanText(leadTraveler.email, 160)}` : "",
    leadTraveler.phoneNumber ? `Lead Traveler Phone: ${cleanText(leadTraveler.phoneNumber, 80)}` : ""
  ].filter(Boolean).join("\n");
}

export function buildReservationEventBody({
  product,
  slot,
  reservationReference,
  reservationExpiresAt,
  gygBookingReference,
  gygActivityReference,
  bookingItems,
  status,
  travelers = []
}) {
  const leadTraveler = travelers[0] || {};
  const leadTravelerName = cleanText(
    `${leadTraveler.firstName || ""} ${leadTraveler.lastName || ""}`,
    120
  );
  const leadTravelerCountry = cleanText(
    leadTraveler.country || leadTraveler.countryCode || leadTraveler.nationality,
    120
  );

  return {
    id: reservationReference,
    summary: `[GYG ${status}] ${product.label}`,
    description: buildReservationDescription({
      status,
      product,
      slot,
      reservationReference,
      reservationExpiresAt,
      gygBookingReference,
      gygActivityReference,
      bookingItems,
      travelers
    }),
    start: {
      dateTime: slot.start.toISOString(),
      timeZone: GYG_RULES.timezone
    },
    end: {
      dateTime: slot.end.toISOString(),
      timeZone: GYG_RULES.timezone
    },
    extendedProperties: {
      private: {
        source: "getyourguide",
        bookingType: status === "BOOKED" ? "gyg_booking" : "gyg_reservation",
        tour: product.tour,
        gygProductId: slot.productId,
        gygBookingReference: cleanText(gygBookingReference, 80),
        gygActivityReference: cleanText(gygActivityReference, 80),
        reservationReference,
        bookingReference: reservationReference,
        reservationExpiresAt: reservationExpiresAt || "",
        date: slot.date,
        time: slot.time,
        tourLabel: product.label,
        tourName: product.label,
        customerName: leadTravelerName,
        customerEmail: cleanText(leadTraveler.email, 160),
        customerPhone: cleanText(leadTraveler.phoneNumber, 80),
        customerCountry: leadTravelerCountry,
        groupSize: String(Number(bookingItems?.[0]?.groupSize || 0) || ""),
        leadTravelerFirstName: cleanText(leadTraveler.firstName, 80),
        leadTravelerLastName: cleanText(leadTraveler.lastName, 80),
        leadTravelerEmail: cleanText(leadTraveler.email, 160),
        leadTravelerPhone: cleanText(leadTraveler.phoneNumber, 80),
        leadTravelerCountry
      }
    }
  };
}

export function buildBookingResponse(bookingReference, bookingItems) {
  return {
    bookingReference,
    tickets: [
      {
        category: "COLLECTIVE",
        ticketCode: bookingReference,
        ticketCodeType: "TEXT"
      }
    ]
  };
}

export async function getAuthorizedGoogleTokenOrThrow(env) {
  return getGoogleAccessToken(env);
}
