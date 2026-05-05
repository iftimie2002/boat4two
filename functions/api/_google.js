export const GOOGLE_CALENDAR_PUBLIC_ERROR_MESSAGE =
  "Booking calendar is temporarily offline while we reconnect it. Please contact us on WhatsApp to reserve your slot.";
const GOOGLE_SERVICE_ACCOUNT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function normalizeMultilineSecret(value) {
  let normalized = String(value || "").trim();

  if (
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }

  return normalized
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\r\n|\r/g, "\n");
}

function parseCalendarIds(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createGoogleCalendarError(message, code, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details || null;
  error.publicMessage = GOOGLE_CALENDAR_PUBLIC_ERROR_MESSAGE;
  return error;
}

function hasGoogleOAuthRefreshCredentials(env) {
  return Boolean(
    cleanText(env.GOOGLE_CLIENT_ID, 240) &&
    cleanText(env.GOOGLE_CLIENT_SECRET, 240) &&
    cleanText(env.GOOGLE_REFRESH_TOKEN, 1200)
  );
}

function hasGoogleServiceAccountCredentials(env) {
  return Boolean(
    cleanText(env.GOOGLE_SERVICE_ACCOUNT_JSON, 120000) ||
    (
      cleanText(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, 320) &&
      cleanText(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, 120000)
    )
  );
}

function base64UrlEncodeString(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pemValue) {
  const normalized = normalizeMultilineSecret(pemValue);
  const base64 = normalized
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");

  if (!base64) {
    throw createGoogleCalendarError(
      "Google service account private key is empty or invalid.",
      "google_service_account_private_key_invalid"
    );
  }

  let binary = "";

  try {
    binary = atob(base64);
  } catch {
    throw createGoogleCalendarError(
      "Google service account private key is not valid base64 PEM data.",
      "google_service_account_private_key_invalid"
    );
  }

  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function getGoogleServiceAccountConfig(env) {
  const rawJson = cleanText(env.GOOGLE_SERVICE_ACCOUNT_JSON, 120000);

  if (rawJson) {
    let parsed = null;

    try {
      parsed = JSON.parse(rawJson);
    } catch (error) {
      throw createGoogleCalendarError(
        "Google service account JSON is not valid JSON.",
        "google_service_account_json_invalid",
        { message: error?.message || "Invalid JSON" }
      );
    }

    return {
      clientEmail: cleanText(parsed?.client_email, 320),
      privateKey: normalizeMultilineSecret(parsed?.private_key),
      tokenUri: cleanText(parsed?.token_uri, 240) || GOOGLE_SERVICE_ACCOUNT_TOKEN_URI
    };
  }

  const clientEmail = cleanText(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, 320);
  const privateKey = normalizeMultilineSecret(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);

  if (!clientEmail || !privateKey) {
    return null;
  }

  return {
    clientEmail,
    privateKey,
    tokenUri: cleanText(env.GOOGLE_SERVICE_ACCOUNT_TOKEN_URI, 240) || GOOGLE_SERVICE_ACCOUNT_TOKEN_URI
  };
}

async function createGoogleServiceAccountAssertion(config) {
  if (!config?.clientEmail || !config?.privateKey) {
    throw createGoogleCalendarError(
      "Google service account credentials are incomplete.",
      "google_service_account_credentials_incomplete"
    );
  }

  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: config.clientEmail,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: config.tokenUri || GOOGLE_SERVICE_ACCOUNT_TOKEN_URI,
    iat: now,
    exp: now + 3600
  };
  const signingInput = [
    base64UrlEncodeString(JSON.stringify(header)),
    base64UrlEncodeString(JSON.stringify(claims))
  ].join(".");

  let privateKey = null;

  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(config.privateKey),
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );
  } catch (error) {
    throw createGoogleCalendarError(
      "Google service account private key could not be imported.",
      "google_service_account_private_key_invalid",
      { message: error?.message || "Key import failed" }
    );
  }

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function getGoogleServiceAccountAccess(env) {
  const config = getGoogleServiceAccountConfig(env);

  if (!config) {
    return null;
  }

  const assertion = await createGoogleServiceAccountAssertion(config);
  const tokenResponse = await fetch(config.tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const tokenData = await tokenResponse.json().catch(() => null);

  if (!tokenResponse.ok || !tokenData?.access_token) {
    const description = cleanText(tokenData?.error_description || tokenData?.error, 180);

    throw createGoogleCalendarError(
      `Google service account authentication failed: ${description || "Unknown error"}.`,
      "google_service_account_auth_failed",
      tokenData
    );
  }

  return {
    accessToken: tokenData.access_token,
    authMode: "service_account",
    fallbackUsed: false
  };
}

async function getGoogleOAuthRefreshAccess(env) {
  if (!hasGoogleOAuthRefreshCredentials(env)) {
    return null;
  }

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

  return {
    accessToken: tokenData.access_token,
    authMode: "oauth_refresh_token",
    fallbackUsed: false
  };
}

export function getGoogleCalendarAuthMode(env) {
  if (hasGoogleServiceAccountCredentials(env)) {
    return "service_account";
  }

  if (hasGoogleOAuthRefreshCredentials(env)) {
    return "oauth_refresh_token";
  }

  return "";
}

export function getMissingGoogleCalendarConfigNames(env) {
  const missing = [];

  if (!getPrimaryGoogleCalendarId(env)) {
    missing.push("GOOGLE_CALENDAR_ID");
  }

  const hasServiceAccountJson = Boolean(cleanText(env.GOOGLE_SERVICE_ACCOUNT_JSON, 120000));
  const hasServiceAccountEmail = Boolean(cleanText(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, 320));
  const hasServiceAccountKey = Boolean(cleanText(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, 120000));

  if (hasServiceAccountJson || (hasServiceAccountEmail && hasServiceAccountKey)) {
    return missing;
  }

  if (hasServiceAccountEmail || hasServiceAccountKey) {
    if (!hasServiceAccountEmail) {
      missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    }

    if (!hasServiceAccountKey) {
      missing.push("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
    }

    return missing;
  }

  const hasClientId = Boolean(cleanText(env.GOOGLE_CLIENT_ID, 240));
  const hasClientSecret = Boolean(cleanText(env.GOOGLE_CLIENT_SECRET, 240));
  const hasRefreshToken = Boolean(cleanText(env.GOOGLE_REFRESH_TOKEN, 1200));

  if (hasClientId || hasClientSecret || hasRefreshToken) {
    if (!hasClientId) {
      missing.push("GOOGLE_CLIENT_ID");
    }

    if (!hasClientSecret) {
      missing.push("GOOGLE_CLIENT_SECRET");
    }

    if (!hasRefreshToken) {
      missing.push("GOOGLE_REFRESH_TOKEN");
    }

    return missing;
  }

  missing.push(
    "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN"
  );

  return missing;
}

export function hasGoogleCalendarCredentials(env) {
  return getMissingGoogleCalendarConfigNames(env).length === 0;
}

export async function getGoogleCalendarAccess(env) {
  const serviceAccountPreferred = hasGoogleServiceAccountCredentials(env);
  const oauthAvailable = hasGoogleOAuthRefreshCredentials(env);

  if (serviceAccountPreferred) {
    try {
      return await getGoogleServiceAccountAccess(env);
    } catch (error) {
      if (!oauthAvailable) {
        throw error;
      }
    }
  }

  const oauthAccess = await getGoogleOAuthRefreshAccess(env);

  if (oauthAccess) {
    return {
      ...oauthAccess,
      fallbackUsed: serviceAccountPreferred
    };
  }

  throw createGoogleCalendarError(
    "Missing required Google Calendar authentication variables.",
    "google_calendar_credentials_missing"
  );
}

export async function getGoogleAccessToken(env) {
  const access = await getGoogleCalendarAccess(env);
  return access.accessToken;
}

export function getPrimaryGoogleCalendarId(env) {
  return cleanText(env.GOOGLE_CALENDAR_ID, 240);
}

export function getBusyGoogleCalendarIds(env) {
  const configuredIds = [
    ...parseCalendarIds(env.GOOGLE_BUSY_CALENDAR_IDS),
    ...parseCalendarIds(env.GOOGLE_CALENDAR_IDS),
    getPrimaryGoogleCalendarId(env)
  ].filter(Boolean);

  return Array.from(new Set(configuredIds));
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
