const BOOKING_RULES = {
  timezone: "Europe/Lisbon"
};

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

function makeDateInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(date);
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const dateStr = `${values.year}-${values.month}-${values.day}`;
  const utcGuess = new Date(Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    0, 0, 0
  ));

  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, utcGuess);
  const startOfDay = new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
  const endOfDay = new Date(startOfDay.getTime() + (24 * 60 * 60 * 1000) - 1000);

  return { dateStr, startOfDay, endOfDay };
}

export async function onRequestGet(context) {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
    GOOGLE_CALENDAR_ID
  } = context.env;

  if (
    !GOOGLE_CLIENT_ID ||
    !GOOGLE_CLIENT_SECRET ||
    !GOOGLE_REFRESH_TOKEN ||
    !GOOGLE_CALENDAR_ID
  ) {
    return Response.json(
      {
        ok: false,
        error: "Missing required Google environment variables."
      },
      { status: 500 }
    );
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token"
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return Response.json(
        {
          ok: false,
          step: "refresh_token_exchange_failed",
          details: tokenData
        },
        { status: 500 }
      );
    }

    const now = new Date();
    const { dateStr, startOfDay, endOfDay } = makeDateInTimeZone(now, BOOKING_RULES.timezone);

    const freeBusyResponse = await fetch(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          timeMin: startOfDay.toISOString(),
          timeMax: endOfDay.toISOString(),
          timeZone: BOOKING_RULES.timezone,
          items: [{ id: GOOGLE_CALENDAR_ID }]
        })
      }
    );

    const freeBusyData = await freeBusyResponse.json();

    if (!freeBusyResponse.ok) {
      return Response.json(
        {
          ok: false,
          step: "freebusy_failed",
          details: freeBusyData
        },
        { status: 500 }
      );
    }

    return Response.json({
      ok: true,
      message: "Google Calendar connection working",
      calendarId: GOOGLE_CALENDAR_ID,
      timezone: BOOKING_RULES.timezone,
      lisbonDate: dateStr,
      busy: freeBusyData.calendars?.[GOOGLE_CALENDAR_ID]?.busy || []
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
