import { getGoogleAccessToken, getGoogleCalendarErrorPayload } from "./_google.js";

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

function getDaysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
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
      items: [{ id: env.GOOGLE_CALENDAR_ID }]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Failed to fetch Google Calendar busy ranges");
  }

  return data.calendars?.[env.GOOGLE_CALENDAR_ID]?.busy || [];
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const tour = (url.searchParams.get("tour") || "").toLowerCase();
  const month = url.searchParams.get("month") || "";

  if (!BOOKING_RULES.tours[tour]) {
    return Response.json(
      { ok: false, error: "Invalid tour." },
      { status: 400 }
    );
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return Response.json(
      { ok: false, error: "Invalid month format. Use YYYY-MM." },
      { status: 400 }
    );
  }

  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const monthNumber = Number(monthStr);

  if (monthNumber < 1 || monthNumber > 12) {
    return Response.json(
      { ok: false, error: "Invalid month. Must be between 01 and 12." },
      { status: 400 }
    );
  }

  try {
    const selectedTour = BOOKING_RULES.tours[tour];
    const monthIndex = monthNumber - 1;

    const now = new Date();
    const minAllowedDateTime = new Date(
      now.getTime() + BOOKING_RULES.minimumNoticeHours * 60 * 60 * 1000
    );

    const accessToken = await getGoogleAccessToken(env);

    const firstDay = `${month}-01`;
    const lastDay = `${month}-${String(getDaysInMonth(year, monthIndex)).padStart(2, "0")}`;

    const rangeStart = makeDateInTimeZone(firstDay, "00:00:00", BOOKING_RULES.timezone);
    const rangeEnd = makeDateInTimeZone(lastDay, "23:59:59", BOOKING_RULES.timezone);

    const busyRangesRaw = await getBusyRanges(
      env,
      accessToken,
      rangeStart.toISOString(),
      rangeEnd.toISOString()
    );

    const busyRanges = busyRangesRaw.map((range) => ({
      start: new Date(range.start),
      end: new Date(range.end)
    }));

    const availableDates = [];
    const totalDays = getDaysInMonth(year, monthIndex);

    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${month}-${String(day).padStart(2, "0")}`;

      const hasAvailableSlot = selectedTour.startTimes.some((time) => {
        const slotStart = makeDateInTimeZone(dateStr, `${time}:00`, BOOKING_RULES.timezone);
        const slotEnd = addMinutes(slotStart, selectedTour.durationMinutes);
        const slotBlockedEnd = addMinutes(slotEnd, BOOKING_RULES.bufferMinutes);

        if (slotStart < minAllowedDateTime) {
          return false;
        }

        const overlaps = busyRanges.some((busy) =>
          rangesOverlap(slotStart, slotBlockedEnd, busy.start, busy.end)
        );

        return !overlaps;
      });

      if (hasAvailableSlot) {
        availableDates.push(dateStr);
      }
    }

    return Response.json({
      ok: true,
      tour,
      month,
      availableDates
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
