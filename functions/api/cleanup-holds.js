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

  return (
    privateProps.isHold === "true" ||
    Boolean(privateProps.holdId) ||
    summary.startsWith("[HOLD]") ||
    /HOLD_ID:/i.test(description)
  );
}

function getHoldId(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.holdId ||
    getDescriptionValue(description, "HOLD_ID") ||
    ""
  );
}

function getHoldExpiresAt(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.holdExpiresAt ||
    getDescriptionValue(description, "HOLD_EXPIRES_AT") ||
    ""
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

async function getCandidateHoldEvents(env, accessToken) {
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const events = await listEvents(env, accessToken, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString()
  });

  return events.filter(isHoldEvent);
}

export async function onRequestGet(context) {
  const { env } = context;

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
    const accessToken = await getAccessToken(env);
    const holdEvents = await getCandidateHoldEvents(env, accessToken);
    const nowMs = Date.now();

    const expiredHoldEvents = holdEvents.filter((event) => {
      const expiresAt = getHoldExpiresAt(event);
      if (!expiresAt) return false;

      const expiresAtMs = new Date(expiresAt).getTime();
      if (Number.isNaN(expiresAtMs)) return false;

      return nowMs >= expiresAtMs;
    });

    const deletedHoldIds = [];
    let deletedCount = 0;

    for (const event of expiredHoldEvents) {
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(event.id)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      if (response.ok || response.status === 404) {
        deletedCount += 1;
        deletedHoldIds.push(getHoldId(event) || event.id);
      }
    }

    return json({
      ok: true,
      scanned: holdEvents.length,
      expiredFound: expiredHoldEvents.length,
      deletedCount,
      deletedHoldIds
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

export const onRequestPost = onRequestGet;
