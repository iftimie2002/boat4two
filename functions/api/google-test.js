import {
  getBusyGoogleCalendarIds,
  getGoogleCalendarAuthMode,
  getGoogleAccessToken,
  getGoogleCalendarErrorPayload,
  getMissingGoogleCalendarConfigNames,
  getPrimaryGoogleCalendarId
} from "./_google.js";

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
  const { env } = context;
  const primaryCalendarId = getPrimaryGoogleCalendarId(env);
  const busyCalendarIds = getBusyGoogleCalendarIds(env);
  const authMode = getGoogleCalendarAuthMode(env);
  const missingGoogleConfig = getMissingGoogleCalendarConfigNames(env);

  if (missingGoogleConfig.length) {
    return Response.json(
      {
        ok: false,
        error: "Missing required Google environment variables.",
        missing: missingGoogleConfig,
        authMode: authMode || null
      },
      { status: 500 }
    );
  }

  try {
    let accessToken = "";

    try {
      accessToken = await getGoogleAccessToken(env);
    } catch (error) {
      return Response.json(
        {
          ok: false,
          step: "google_authentication_failed",
          ...getGoogleCalendarErrorPayload(error),
          details: error?.details || null,
          authMode: authMode || null,
          adminHint: error?.code === "google_refresh_token_invalid"
            ? "Reconnect GOOGLE_REFRESH_TOKEN in Cloudflare Workers & Pages, or finish switching to a Google service account."
            : (authMode === "service_account"
              ? "Check the Google service account email, private key, and calendar sharing permissions in Cloudflare."
              : "")
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
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          timeMin: startOfDay.toISOString(),
          timeMax: endOfDay.toISOString(),
          timeZone: BOOKING_RULES.timezone,
          items: busyCalendarIds.map((id) => ({ id }))
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
      authMode: authMode || null,
      calendarId: primaryCalendarId,
      busyCalendarIds,
      timezone: BOOKING_RULES.timezone,
      lisbonDate: dateStr,
      busy: busyCalendarIds.flatMap((calendarId) => freeBusyData.calendars?.[calendarId]?.busy || []),
      busyByCalendar: Object.fromEntries(
        busyCalendarIds.map((calendarId) => [calendarId, freeBusyData.calendars?.[calendarId]?.busy || []])
      )
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
