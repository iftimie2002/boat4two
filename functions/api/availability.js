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

function parseLisbonDateTime(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00+01:00`);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

async function getAccessToken(env) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
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

  try {
    const selectedTour = BOOKING_RULES.tours[tour];
    const now = new Date();
    const minAllowedDate = new Date(now.getTime() + BOOKING_RULES.minimumNoticeHours * 60 * 60 * 1000);

    const accessToken = await getAccessToken(env);

    const dayStart = new Date(`${date}T00:00:00+01:00`);
    const dayEnd = new Date(`${date}T23:59:59+01:00`);

    const busyRangesRaw = await getBusyRanges(
      env,
      accessToken,
      dayStart.toISOString(),
      dayEnd.toISOString()
    );

    const busyRanges = busyRangesRaw.map(range => ({
      start: new Date(range.start),
      end: new Date(range.end)
    }));

    const slots = selectedTour.startTimes.map((time) => {
      const slotStart = parseLisbonDateTime(date, time);
      const slotEnd = addMinutes(slotStart, selectedTour.durationMinutes);
      const slotBlockedEnd = addMinutes(slotEnd, BOOKING_RULES.bufferMinutes);

      const respectsNotice = slotStart >= minAllowedDate;

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
        error: error.message || "Unknown error"
      },
      { status: 500 }
    );
  }
}
