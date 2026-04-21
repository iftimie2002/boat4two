const BOOKING_RULES = {
  timezone: "Europe/Lisbon",
  minimumNoticeHours: 24,
  bufferMinutes: 30,
  holdMinutes: 12,
  slotLockMinutes: 2,
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
    if (part.type !== "literal") values[part.type] = part.value;
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

function normalizeTour(value) {
  const v = String(value || "").trim().toLowerCase();

  if (v === "amor" || v === "private" || v === "private sailing tour for couples") return "amor";
  if (v === "sunset" || v === "sunset private sailing tour for couples") return "sunset";
  if (v === "custom" || v === "custom private tour") return "custom";

  return "";
}

function normalizeTimeInput(value) {
  const v = String(value || "").trim().toLowerCase();

  const direct24h = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (direct24h) return `${direct24h[1]}:${direct24h[2]}`;

  const twelveHour = /^(\d{1,2}):(\d{2})\s*([ap]m)$/.exec(v);
  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const minute = twelveHour[2];
    const meridiem = twelveHour[3];

    if (hour < 1 || hour > 12) return "";
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    return `${String(hour).padStart(2, "0")}:${minute}`;
  }

  return "";
}

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

async function getAccessToken(env) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error("Failed to refresh Google access token");
  }

  return tokenData.access_token;
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

async function createCalendarEvent(env, accessToken, eventBody) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`,
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

async function getCalendarEventById(env, accessToken, eventId) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
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

async function updateCalendarEvent(env, accessToken, eventId, patchBody, etag = "") {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };

  if (etag) {
    headers["If-Match"] = etag;
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers,
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

async function deleteCalendarEvent(env, accessToken, eventId, etag = "") {
  const headers = {
    Authorization: `Bearer ${accessToken}`
  };

  if (etag) {
    headers["If-Match"] = etag;
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers
    }
  );

  if (response.status === 404 || response.status === 410) {
    return;
  }

  if (!response.ok) {
    const error = new Error("Failed to delete calendar event");
    error.status = response.status;
    throw error;
  }
}

function buildDayLockEventId(date) {
  return `b4tlock${date.replace(/-/g, "")}`;
}

function makeSlotLockBody(date, token, expiresAt) {
  const lockStart = makeDateInTimeZone(date, "00:00:00", BOOKING_RULES.timezone);
  const lockEnd = addMinutes(lockStart, 5);

  return {
    id: buildDayLockEventId(date),
    summary: `BOOKING LOCK - ${date}`,
    transparency: "transparent",
    start: {
      dateTime: lockStart.toISOString(),
      timeZone: BOOKING_RULES.timezone
    },
    end: {
      dateTime: lockEnd.toISOString(),
      timeZone: BOOKING_RULES.timezone
    },
    extendedProperties: {
      private: {
        bookingType: "slot_lock",
        slotLockDate: date,
        slotLockState: "active",
        slotLockToken: token,
        slotLockExpiresAt: expiresAt.toISOString()
      }
    }
  };
}

function slotLockIsActive(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const expiresAt = privateProps.slotLockExpiresAt || "";

  if (privateProps.bookingType !== "slot_lock" || privateProps.slotLockState !== "active") {
    return false;
  }

  if (!expiresAt) {
    return false;
  }

  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && Date.now() < expiresAtMs;
}

function bookingConflictError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

async function acquireSlotLock(env, accessToken, date) {
  const token = crypto.randomUUID();
  const expiresAt = addMinutes(new Date(), BOOKING_RULES.slotLockMinutes);
  const lockBody = makeSlotLockBody(date, token, expiresAt);

  try {
    const createdLock = await createCalendarEvent(env, accessToken, lockBody);
    return {
      eventId: createdLock.id,
      etag: createdLock.etag || "",
      token,
      date
    };
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
  }

  const existingLock = await getCalendarEventById(env, accessToken, lockBody.id);

  if (!existingLock) {
    throw bookingConflictError("Another booking is being reserved for this date. Please try again in a moment.");
  }

  if (slotLockIsActive(existingLock)) {
    throw bookingConflictError("Another booking is being reserved for this date. Please try again in a moment.");
  }

  try {
    const { id, ...patchBody } = lockBody;
    const updatedLock = await updateCalendarEvent(
      env,
      accessToken,
      lockBody.id,
      patchBody,
      existingLock?.etag || ""
    );

    return {
      eventId: updatedLock.id,
      etag: updatedLock.etag || "",
      token,
      date
    };
  } catch (error) {
    if (error.status === 412 || error.status === 409) {
      throw bookingConflictError("Another booking is being reserved for this date. Please try again in a moment.");
    }

    throw error;
  }
}

async function releaseSlotLock(env, accessToken, lock) {
  await deleteCalendarEvent(env, accessToken, lock.eventId, lock.etag);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const tour = normalizeTour(body.tour);
    const date = cleanText(body.date, 10);
    const time = normalizeTimeInput(body.time);

    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 200);
    const phone = cleanText(body.phone, 80);
    const country = cleanText(body.country, 120);
    const occasion = cleanText(body.occasion, 200);
    const message = cleanText(body.message, 1000);

    if (
      !env.GOOGLE_CLIENT_ID ||
      !env.GOOGLE_CLIENT_SECRET ||
      !env.GOOGLE_REFRESH_TOKEN ||
      !env.GOOGLE_CALENDAR_ID
    ) {
      return Response.json(
        { ok: false, error: "Missing required Google environment variables." },
        { status: 500 }
      );
    }

    if (!BOOKING_RULES.tours[tour]) {
      return Response.json({ ok: false, error: "Invalid tour." }, { status: 400 });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ ok: false, error: "Invalid date format." }, { status: 400 });
    }

    if (!time) {
      return Response.json({ ok: false, error: "Invalid time." }, { status: 400 });
    }

    if (!name || !email || !phone || !country) {
      return Response.json(
        { ok: false, error: "Missing required customer fields." },
        { status: 400 }
      );
    }

    const selectedTour = BOOKING_RULES.tours[tour];

    if (!selectedTour.startTimes.includes(time)) {
      return Response.json(
        { ok: false, error: "Time is not valid for this tour." },
        { status: 400 }
      );
    }

    const slotStart = makeDateInTimeZone(date, `${time}:00`, BOOKING_RULES.timezone);
    const slotEnd = addMinutes(slotStart, selectedTour.durationMinutes);
    const slotBlockedEnd = addMinutes(slotEnd, BOOKING_RULES.bufferMinutes);

    const now = new Date();
    const minAllowedDateTime = new Date(
      now.getTime() + BOOKING_RULES.minimumNoticeHours * 60 * 60 * 1000
    );

    if (slotStart < minAllowedDateTime) {
      return Response.json(
        { ok: false, error: "This slot no longer respects minimum notice." },
        { status: 409 }
      );
    }

    const accessToken = await getAccessToken(env);
    let slotLock = null;

    try {
      slotLock = await acquireSlotLock(env, accessToken, date);

      const busyRangesRaw = await getBusyRanges(
        env,
        accessToken,
        addMinutes(slotStart, -BOOKING_RULES.bufferMinutes).toISOString(),
        slotBlockedEnd.toISOString()
      );

      const busyRanges = busyRangesRaw.map((range) => ({
        start: new Date(range.start),
        end: new Date(range.end)
      }));

      const overlaps = busyRanges.some((busy) =>
        rangesOverlap(slotStart, slotBlockedEnd, busy.start, busy.end)
      );

      if (overlaps) {
        return Response.json(
          { ok: false, error: "This slot is no longer available." },
          { status: 409 }
        );
      }

      const holdExpiresAt = addMinutes(now, BOOKING_RULES.holdMinutes);
      const holdId = crypto.randomUUID();

      const eventBody = {
        summary: `[HOLD] ${selectedTour.label} - ${name}`,
        description: [
          `Temporary hold for booking flow`,
          ``,
          `HOLD_ID: ${holdId}`,
          `HOLD_EXPIRES_AT: ${holdExpiresAt.toISOString()}`,
          ``,
          `Tour: ${selectedTour.label}`,
          `Date: ${date}`,
          `Time: ${time}`,
          ``,
          `Name: ${name}`,
          `Email: ${email}`,
          `Phone: ${phone}`,
          `Country: ${country}`,
          occasion ? `Occasion: ${occasion}` : "",
          message ? `Notes: ${message}` : ""
        ].filter(Boolean).join("\n"),
        start: {
          dateTime: slotStart.toISOString(),
          timeZone: BOOKING_RULES.timezone
        },
        end: {
          dateTime: slotEnd.toISOString(),
          timeZone: BOOKING_RULES.timezone
        },
        extendedProperties: {
          private: {
            bookingType: "hold",
            isHold: "true",
            holdId,
            holdExpiresAt: holdExpiresAt.toISOString(),
            tour,
            date,
            time,
            customerName: name,
            customerEmail: email,
            customerPhone: phone,
            customerCountry: country,
            customerOccasion: occasion,
            customerMessage: message
          }
        }
      };

      const createdEvent = await createCalendarEvent(env, accessToken, eventBody);

      return Response.json({
        ok: true,
        holdId,
        eventId: createdEvent.id,
        expiresAt: holdExpiresAt.toISOString(),
        tour,
        date,
        time,
        customer: {
          name,
          email,
          phone,
          country,
          occasion,
          message
        }
      });
    } finally {
      if (slotLock) {
        try {
          await releaseSlotLock(env, accessToken, slotLock);
        } catch (_) {
          // The lock expires quickly; a failed best-effort release should not hide the booking result.
        }
      }
    }
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error.message || "Unknown error"
      },
      { status: error.status && error.status >= 400 && error.status < 500 ? error.status : 500 }
    );
  }
}
