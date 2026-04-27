export const GOOGLE_CALENDAR_PUBLIC_ERROR_MESSAGE =
  "Booking calendar is temporarily offline while we reconnect it. Please contact us on WhatsApp to reserve your slot.";

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function createGoogleCalendarError(message, code, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details || null;
  error.publicMessage = GOOGLE_CALENDAR_PUBLIC_ERROR_MESSAGE;
  return error;
}

export async function getGoogleAccessToken(env) {
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

  const tokenData = await tokenResponse.json().catch(() => null);

  if (!tokenResponse.ok || !tokenData?.access_token) {
    const googleError = cleanText(tokenData?.error, 60).toLowerCase();
    const description = cleanText(tokenData?.error_description, 180);

    if (googleError === "invalid_grant") {
      throw createGoogleCalendarError(
        "Google Calendar connection has expired or been revoked.",
        "google_refresh_token_invalid",
        tokenData
      );
    }

    if (googleError) {
      throw createGoogleCalendarError(
        `Google Calendar authentication failed: ${description || googleError}.`,
        "google_calendar_auth_failed",
        tokenData
      );
    }

    throw createGoogleCalendarError(
      "Failed to refresh Google access token.",
      "google_access_token_refresh_failed",
      tokenData
    );
  }

  return tokenData.access_token;
}

export function getGoogleCalendarErrorPayload(error, fallbackMessage = "Unknown error") {
  const payload = {
    error: error?.message || fallbackMessage
  };

  if (error?.code) {
    payload.errorCode = error.code;
  }

  if (error?.publicMessage) {
    payload.publicMessage = error.publicMessage;
  }

  return payload;
}
