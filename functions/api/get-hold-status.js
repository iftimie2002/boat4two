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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getDescriptionValue(description, key) {
  if (!description) return "";

  const safeKey = escapeRegex(key);
  const regex = new RegExp("^" + safeKey + ":(.*)$", "mi");
  const match = description.match(regex);

  return match ? match[1].trim() : "";
}

function getPrivateProps(event) {
  if (
    event &&
    event.extendedProperties &&
    event.extendedProperties.private
  ) {
    return event.extendedProperties.private;
  }

  return {};
}

function isHoldEvent(event) {
  const privateProps = getPrivateProps(event);
  const summary = event && event.summary ? event.summary : "";
  const description = event && event.description ? event.description : "";

  return (
    privateProps.isHold === "true" ||
    Boolean(privateProps.holdId) ||
    summary.indexOf("[HOLD]") === 0 ||
    /HOLD_ID:/i.test(description)
  );
}

function eventMatchesHoldId(event, holdId) {
  const privateProps = getPrivateProps(event);
  const description = event && event.description ? event.description : "";

  return (
    privateProps.holdId === holdId ||
    getDescriptionValue(description, "HOLD_ID") === holdId
  );
}

function getHoldExpiresAt(event) {
  const privateProps = getPrivateProps(event);
  const description = event && event.description ? event.description : "";

  return (
    privateProps.holdExpiresAt ||
    getDescriptionValue(description, "HOLD_EXPIRES_AT") ||
    ""
  );
}

async function listEvents(env, accessToken, extraParams) {
  const url = new URL(
    "https://www.googleapis.com/calendar/v3/calendars/" +
      encodeURIComponent(env.GOOGLE_CALENDAR_ID) +
      "/events"
  );

  url.searchParams.set("singleEvents", "false");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "2500");

  Object.entries(extraParams || {}).forEach(function(entry) {
    const key = entry[0];
    const value = entry[1];

    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: "Bearer " + accessToken
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Failed to list calendar events");
  }

  return data.items || [];
}

async function findHoldEventById(env, accessToken, holdId) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  let events = [];

  try {
    events = await listEvents(env, accessToken, {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      privateExtendedProperty: "holdId=" + holdId
    });
  } catch (error) {
    events = [];
  }

  let match = events.find(function(event) {
    return isHoldEvent(event) && eventMatchesHoldId(event, holdId);
  });

  if (match) {
    return match;
  }

  const fallbackEvents = await listEvents(env, accessToken, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString()
  });

  match = fallbackEvents.find(function(event) {
    return isHoldEvent(event) && eventMatchesHoldId(event, holdId);
  });

  return match || null;
}

export async function onRequestGet(context) {
  const request = context.request;
  const env = context.env;

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
    const url = new URL(request.url);
    const holdId = (url.searchParams.get("holdId") || "").trim();

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
    const event = await findHoldEventById(env, accessToken, holdId);

    if (!event) {
      return json({
        ok: true,
        exists: false,
        expired: true,
        holdId
      });
    }

    const expiresAt = getHoldExpiresAt(event);
    const expiresAtDate = expiresAt ? new Date(expiresAt) : null;
    const expired = expiresAtDate ? Date.now() >= expiresAtDate.getTime() : false;

    return json({
      ok: true,
      exists: true,
      expired,
      holdId,
      eventId: event.id,
      expiresAt: expiresAt || null
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
