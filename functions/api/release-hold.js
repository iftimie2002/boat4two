function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
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

function getDescriptionValue(description, key) {
  if (!description) return "";
  const regex = new RegExp(`^${key}:(.*)$`, "mi");
  const match = description.match(regex);
  return match ? match[1].trim() : "";
}

function isHoldEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const summary = event?.summary || "";
  const description = event?.description || "";
  const bookingType = privateProps.bookingType || "";

  if (bookingType && bookingType !== "hold") {
    return false;
  }

  return (
    bookingType === "hold" ||
    privateProps.isHold === "true" ||
    (!privateProps.paymentStatus && Boolean(privateProps.holdId)) ||
    summary.startsWith("[HOLD]") ||
    /HOLD_ID:/i.test(description)
  );
}

function eventMatchesHoldId(event, holdId) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.holdId === holdId ||
    getDescriptionValue(description, "HOLD_ID") === holdId
  );
}

async function listEvents(env, accessToken, extraParams = {}) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`
  );

  url.searchParams.set("singleEvents", "false");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "2500");

  Object.entries(extraParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Failed to list calendar events");
  }

  return data.items || [];
}

async function findHoldEventsById(env, accessToken, holdId) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  let events = [];

  try {
    events = await listEvents(env, accessToken, {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      privateExtendedProperty: `holdId=${holdId}`
    });
  } catch (_) {
    events = [];
  }

  let matching = events.filter((event) => isHoldEvent(event) && eventMatchesHoldId(event, holdId));

  if (matching.length) {
    return matching;
  }

  const fallbackEvents = await listEvents(env, accessToken, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString()
  });

  matching = fallbackEvents.filter((event) => isHoldEvent(event) && eventMatchesHoldId(event, holdId));

  return matching;
}

async function updateCalendarEvent(env, accessToken, eventId, patchBody) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
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
    throw new Error(data?.error?.message || "Failed to release hold event");
  }

  return data;
}

async function parseBody(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return await request.json();
  }

  const raw = await request.text();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (_) {
    return { holdId: raw.trim() };
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN ||
    !env.GOOGLE_CALENDAR_ID
  ) {
    return json(
      {
        ok: false,
        error: "Missing required Google environment variables."
      },
      500
    );
  }

  try {
    const body = await parseBody(request);
    const holdId = (body?.holdId || "").trim();

    if (!holdId) {
      return json(
        {
          ok: false,
          error: "Missing holdId."
        },
        400
      );
    }

    const accessToken = await getAccessToken(env);
    const holdEvents = await findHoldEventsById(env, accessToken, holdId);

    if (!holdEvents.length) {
      return json({
        ok: true,
        released: false,
        reason: "already_missing",
        holdId
      });
    }

    let releasedCount = 0;

    for (const event of holdEvents) {
      const privateProps = event.extendedProperties?.private || {};
      const releasedAt = new Date().toISOString();

      await updateCalendarEvent(env, accessToken, event.id, {
        summary: `RELEASED HOLD - ${event.summary || "Booking"}`,
        transparency: "transparent",
        extendedProperties: {
          private: {
            ...privateProps,
            bookingType: "released_hold",
            isHold: "false",
            holdExpiresAt: "",
            releasedAt
          }
        }
      });

      releasedCount += 1;
    }

    return json({
      ok: true,
      released: true,
      holdId,
      releasedCount,
      deletedCount: 0
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error.message || "Unknown error"
      },
      500
    );
  }
}


