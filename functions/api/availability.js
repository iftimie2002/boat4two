import {
  getBusyGoogleCalendarIds,
  getGoogleAccessToken,
  getGoogleCalendarErrorPayload
} from "./_google.js";
import { bestEffortCleanupStaleBookingArtifacts } from "./_stale-bookings.js";

const BOOKING_RULES = {
  timezone: "Europe/Lisbon",
  minimumNoticeHours: 24,
  bufferMinutes: 30,
  tours: {
    amor: {
      label: "Amor Tour",
      durationMinutes: 210,
      startTimes: ["10:00", "14:00"]
    },
    sunset: {
      label: "Sunset Tour",
      durationMinutes: 210,
      startTimes: ["18:00"]
    },
    custom: {
      label: "Custom Tour",
      durationMinutes: 360,
      startTimes: ["10:00", "14:00"]
    }
  }
};

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
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

async function getBusyRanges(env, accessToken, timeMin, timeMax) {
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
      timeZone: BOOKING_RULES.timezone,
      items: busyCalendarIds.map((id) => ({ id }))
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Failed to fetch Google Calendar busy ranges");
  }

  return busyCalendarIds.flatMap((calendarId) => data.calendars?.[calendarId]?.busy || []);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const tour = (url.searchParams.get("tour") || "").toLowerCase();
  const date = url.searchParams.get("date") || "";

  if (!BOOKING_RULES.tours[tour]) {
    return Response.json(
      { ok: false, error: "Invalid tour." },
      { status: 400 }
    );
  }

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json(
      { ok: false, error: "Invalid date format. Use YYYY-MM-DD." },
      { status: 400 }
    );
  }

  const [yearStr, monthStr, dayStr] = date.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return Response.json(
      { ok: false, error: "Invalid date value." },
      { status: 400 }
    );
  }

  try {
    const selectedTour = BOOKING_RULES.tours[tour];
    const now = new Date();
    const minAllowedDateTime = new Date(
      now.getTime() + BOOKING_RULES.minimumNoticeHours * 60 * 60 * 1000
    );

    const accessToken = await getGoogleAccessToken(env);
    await bestEffortCleanupStaleBookingArtifacts(env, accessToken);

    const dayStart = makeDateInTimeZone(date, "00:00:00", BOOKING_RULES.timezone);
    const dayEnd = makeDateInTimeZone(date, "23:59:59", BOOKING_RULES.timezone);

    const busyRangesRaw = await getBusyRanges(
      env,
      accessToken,
      dayStart.toISOString(),
      dayEnd.toISOString()
    );

    const busyRanges = busyRangesRaw.map((range) => ({
      start: new Date(range.start),
      end: new Date(range.end)
    }));

    const slots = selectedTour.startTimes.map((time) => {
      const slotStart = makeDateInTimeZone(date, `${time}:00`, BOOKING_RULES.timezone);
      const slotEnd = addMinutes(slotStart, selectedTour.durationMinutes);
      const slotBlockedEnd = addMinutes(slotEnd, BOOKING_RULES.bufferMinutes);

      const respectsNotice = slotStart >= minAllowedDateTime;

      const overlaps = busyRanges.some((busy) =>
        rangesOverlap(slotStart, slotBlockedEnd, busy.start, busy.end)
      );

      return {
        time,
        available: respectsNotice && !overlaps
      };
    });

    return Response.json({
      ok: true,
      tour,
      date,
      slots
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        ...getGoogleCalendarErrorPayload(error)
      },
      { status: 500 }
    );
  }
}
