
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
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const freeBusyResponse = await fetch(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          timeMin: now.toISOString(),
          timeMax: tomorrow.toISOString(),
          timeZone: "Europe/Lisbon",
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
