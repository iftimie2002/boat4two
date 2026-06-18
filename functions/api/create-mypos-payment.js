import {
  getGoogleAccessToken,
  getGoogleCalendarErrorPayload,
  getMissingGoogleCalendarConfigNames
} from "./_google.js";
import { bestEffortCleanupStaleBookingArtifacts } from "./_stale-bookings.js";

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

const BOOKING_RULES = {
  timezone: "Europe/Lisbon",
  currency: "EUR",
  paymentPendingMinutes: 120,
  sourceName: "Boat4Two",
  tours: {
    amor: {
      label: "Amor Tour",
      totalAmount: 170.00
    },
    sunset: {
      label: "Sunset Tour",
      totalAmount: 190.00
    },
    custom: {
      label: "Custom Tour",
      totalAmount: null
    }
  }
};

const TEST_PRICE_TOTAL_AMOUNT = 0.10;

const MYPOS_EMBEDDED_PRODUCTION_URL = "https://mypos.com/vmp/checkout";
const MYPOS_EMBEDDED_TEST_URL = "https://mypos.com/vmp/checkout-test";

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function getMissingEnvNames(env, names) {
  return names.filter((name) => !env[name]);
}

function getMissingPaymentEnvNames(env) {
  const missing = [
    ...getMissingGoogleCalendarConfigNames(env),
    ...getMissingEnvNames(env, [
      "MYPOS_SID",
      "MYPOS_KEY_INDEX",
      "MYPOS_PRIVATE_KEY",
      "MYPOS_PUBLIC_CERT"
    ])
  ];

  if (!getWalletNumber(env)) {
    missing.push("MYPOS_WALLET_NUMBER");
  }

  return Array.from(new Set(missing));
}

function getWalletNumber(env) {
  return env.MYPOS_WALLET_NUMBER || env.MYPOS_CLIENT_NUMBER || "";
}

function formatMoney(value) {
  return Number(value).toFixed(2);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function parseAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100) / 100;
}

function parseBooleanFlag(value) {
  if (value === true) return true;
  const text = cleanText(value, 20).toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
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
    summary.startsWith("HOLD - ") ||
    summary.startsWith("[HOLD]") ||
    /Hold ID:/i.test(description) ||
    /HOLD_ID:/i.test(description)
  );
}

function eventMatchesHoldId(event, holdId) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.holdId === holdId ||
    getDescriptionValue(description, "Hold ID") === holdId ||
    getDescriptionValue(description, "HOLD_ID") === holdId
  );
}

function getHoldExpiresAt(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.holdExpiresAt ||
    getDescriptionValue(description, "Hold expires at") ||
    getDescriptionValue(description, "HOLD_EXPIRES_AT") ||
    ""
  );
}

function isTestPriceHold(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.testBookingMode === "true" ||
    /^Test booking mode:\s*yes$/im.test(description)
  );
}

function normalizeTour(value) {
  const v = String(value || "").trim().toLowerCase();

  if (v === "amor" || v === "private" || v === "private sailing tour for couples") return "amor";
  if (v === "sunset" || v === "sunset private sailing tour for couples") return "sunset";
  if (v === "custom" || v === "custom private tour") return "custom";

  return "";
}

function splitCustomerName(fullName) {
  const cleaned = cleanText(fullName, 120);
  const parts = cleaned.split(/\s+/).filter(Boolean);

  if (!parts.length) {
    return {
      firstNames: "",
      familyName: ""
    };
  }

  if (parts.length === 1) {
    return {
      firstNames: parts[0],
      familyName: parts[0]
    };
  }

  return {
    firstNames: parts.slice(0, -1).join(" "),
    familyName: parts.slice(-1).join(" ")
  };
}

function normalizeCountryIso3(value) {
  const raw = cleanText(value, 60).toUpperCase();
  if (/^[A-Z]{3}$/.test(raw)) return raw;

  const map = {
    PORTUGAL: "PRT",
    SPAIN: "ESP",
    ESPANHA: "ESP",
    FRANCE: "FRA",
    GERMANY: "DEU",
    UNITEDKINGDOM: "GBR",
    "UNITED KINGDOM": "GBR",
    UK: "GBR",
    ENGLAND: "GBR",
    IRELAND: "IRL",
    NETHERLANDS: "NLD",
    BELGIUM: "BEL",
    SWITZERLAND: "CHE",
    AUSTRIA: "AUT",
    ITALY: "ITA",
    USA: "USA",
    "UNITED STATES": "USA",
    CANADA: "CAN",
    BRAZIL: "BRA",
    BRASIL: "BRA"
  };

  return map[raw] || "";
}

function sanitizeExtras(extras) {
  if (!Array.isArray(extras)) return [];

  return extras
    .map((item) => {
      const name = cleanText(item?.name, 80);
      const quantity = Math.max(1, Math.floor(Number(item?.quantity || 1)));
      const unitPrice = parseAmount(item?.unitPrice);

      if (!name || unitPrice === null || unitPrice < 0) return null;

      return {
        name,
        quantity,
        unitPrice,
        amount: Math.round(quantity * unitPrice * 100) / 100
      };
    })
    .filter(Boolean);
}

function buildCartItems(tourLabel, baseAmount, currency, extras) {
  const items = [
    {
      name: tourLabel,
      quantity: 1,
      unitPrice: baseAmount,
      amount: baseAmount,
      currency
    }
  ];

  for (const extra of extras) {
    items.push({
      name: extra.name,
      quantity: extra.quantity,
      unitPrice: extra.unitPrice,
      amount: extra.amount,
      currency
    });
  }

  return items;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function base64EncodeUtf8(value) {
  return bytesToBase64(new TextEncoder().encode(value));
}

function decodeWalletSessionToken(token) {
  try {
    const decoded = JSON.parse(atob(token));
    const parts = String(decoded?.info || "").split("-");

    return {
      merchantIdentifier: parts[0] || "",
      cardSchemes: parts[1] || "",
      applePayAvailable: parts[2] === "1",
      googlePayAvailable: parts[3] === "1",
      currency: parts[4] || "",
      amount: parts[5] || "",
      merchantCountry: parts[6] || ""
    };
  } catch (_) {
    return null;
  }
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;

  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }

  return result;
}

function encodeDerLength(length) {
  if (length < 128) {
    return new Uint8Array([length]);
  }

  const bytes = [];
  let value = length;

  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function wrapPkcs1PrivateKeyToPkcs8(pkcs1Bytes) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const nullParam = new Uint8Array([0x05, 0x00]);

  const algorithmSequenceBody = concatBytes(rsaOid, nullParam);
  const algorithmSequence = concatBytes(
    new Uint8Array([0x30]),
    encodeDerLength(algorithmSequenceBody.length),
    algorithmSequenceBody
  );

  const privateKeyOctetString = concatBytes(
    new Uint8Array([0x04]),
    encodeDerLength(pkcs1Bytes.length),
    pkcs1Bytes
  );

  const body = concatBytes(version, algorithmSequence, privateKeyOctetString);

  return concatBytes(
    new Uint8Array([0x30]),
    encodeDerLength(body.length),
    body
  );
}

function normalizePemValue(pem) {
  let value = String(pem || "").trim();

  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return value
    .replace(/\\+\//g, "/")
    .replace(/\\+r\\+n|\\+n|\\+r/g, "\n")
    .replace(/\r\n|\r/g, "\n");
}

function getPemLabel(pem) {
  const match = normalizePemValue(pem).match(/-----BEGIN ([^-]+)-----/);
  return match ? match[1] : "";
}

function pemToDerBytes(pem, name = "PEM") {
  const base64 = normalizePemValue(pem)
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "");

  if (!base64) {
    throw new Error(`Invalid ${name} value. Check the PEM header, footer, and body in Cloudflare.`);
  }

  try {
    return base64ToBytes(base64);
  } catch {
    throw new Error(`Invalid ${name} value. Check that the PEM body is valid base64 and that escaped newlines are pasted correctly.`);
  }
}

function readDerElement(bytes, offset = 0) {
  const tag = bytes[offset];
  let lengthByte = bytes[offset + 1];
  let length = 0;
  let lengthBytesCount = 0;

  if ((lengthByte & 0x80) === 0) {
    length = lengthByte;
  } else {
    lengthBytesCount = lengthByte & 0x7f;
    for (let i = 0; i < lengthBytesCount; i++) {
      length = (length << 8) | bytes[offset + 2 + i];
    }
  }

  const headerLength = 2 + lengthBytesCount;
  const start = offset;
  const valueStart = offset + headerLength;
  const end = valueStart + length;

  return {
    tag,
    length,
    start,
    valueStart,
    end,
    headerLength
  };
}

function readDerChildren(bytes, element) {
  const children = [];
  let offset = element.valueStart;

  while (offset < element.end) {
    const child = readDerElement(bytes, offset);
    children.push(child);
    offset = child.end;
  }

  return children;
}

function looksLikePkcs1PrivateKey(bytes) {
  try {
    const root = readDerElement(bytes, 0);
    if (root.tag !== 0x30 || root.end > bytes.length) return false;

    const children = readDerChildren(bytes, root);
    return (
      children.length >= 9 &&
      children[0].tag === 0x02 &&
      children[1].tag === 0x02 &&
      children[2].tag === 0x02 &&
      children[3].tag === 0x02
    );
  } catch {
    return false;
  }
}

function extractSpkiFromCertificatePem(certificatePem) {
  const certBytes = pemToDerBytes(certificatePem, "MYPOS_PUBLIC_CERT");
  const root = readDerElement(certBytes, 0);
  const rootChildren = readDerChildren(certBytes, root);

  if (!rootChildren.length) {
    throw new Error("Invalid certificate.");
  }

  const tbsCertificate = rootChildren[0];
  const tbsChildren = readDerChildren(certBytes, tbsCertificate);

  let spkiIndex = 5;
  if (tbsChildren[0] && tbsChildren[0].tag === 0xa0) {
    spkiIndex = 6;
  }

  const spki = tbsChildren[spkiIndex];
  if (!spki) {
    throw new Error("Could not extract public key from certificate.");
  }

  return certBytes.slice(spki.start, spki.end);
}

async function importPrivateKey(privateKeyPem) {
  const label = getPemLabel(privateKeyPem);
  const privateKeyBytes = pemToDerBytes(privateKeyPem, "MYPOS_PRIVATE_KEY");
  const pkcs8 = label === "RSA PRIVATE KEY" ||
    (!label && looksLikePkcs1PrivateKey(privateKeyBytes))
    ? wrapPkcs1PrivateKeyToPkcs8(privateKeyBytes)
    : privateKeyBytes;

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
}

async function signValuesInOrder(values, privateKeyPem) {
  const payload = base64EncodeUtf8(values.map((value) => String(value)).join("-"));
  const key = await importPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(payload)
  );

  return bytesToBase64(new Uint8Array(signature));
}

function isMyposSandboxUrl(value) {
  return /checkout-test/i.test(String(value || ""));
}

function getMyposHostedCheckoutUrl(env) {
  return env.MYPOS_CHECKOUT_URL || MYPOS_EMBEDDED_PRODUCTION_URL;
}

function getMyposEmbeddedCheckoutUrl(env) {
  return isMyposSandboxUrl(env.MYPOS_CHECKOUT_URL)
    ? MYPOS_EMBEDDED_TEST_URL
    : MYPOS_EMBEDDED_PRODUCTION_URL;
}

function getMyposApiUrl(env) {
  return getMyposEmbeddedCheckoutUrl(env);
}

async function createPaymentSessionToken(env, checkoutUrl, {
  orderId,
  totalAmount,
  walletNumber,
  cartItems
}) {
  const sessionData = {
    IPCmethod: "IPCPaymentSessionCreate",
    IPCVersion: "1.4",
    IPCLanguage: "EN",
    OrderID: orderId,
    Amount: formatMoney(totalAmount),
    Currency: BOOKING_RULES.currency,
    SID: env.MYPOS_SID,
    WalletNumber: walletNumber,
    KeyIndex: String(env.MYPOS_KEY_INDEX),
    RequestToken: "0",
    CartItems: String(cartItems.length)
  };

  cartItems.forEach((item, index) => {
    const row = index + 1;
    sessionData[`Article_${row}`] = item.name;
    sessionData[`Quantity_${row}`] = String(item.quantity);
    sessionData[`Price_${row}`] = formatMoney(item.unitPrice);
    sessionData[`Amount_${row}`] = formatMoney(item.amount);
    sessionData[`Currency_${row}`] = item.currency;
  });

  sessionData.OutputFormat = "JSON";
  sessionData.Signature = await signValuesInOrder(Object.values(sessionData), env.MYPOS_PRIVATE_KEY);

  const response = await fetch(checkoutUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(sessionData)
  });
  const text = await response.text();
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("myPOS returned an invalid payment session response.");
  }

  if (!response.ok || Number(data?.Status) !== 0 || !data?.SessionToken) {
    const host = new URL(checkoutUrl).host;
    throw new Error(`${data?.StatusMsg || "Could not create myPOS wallet payment session."} (${host})`);
  }

  return data.SessionToken;
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
    throw new Error(data?.error?.message || "Failed to list calendar events");
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
      privateExtendedProperty: `holdId=${holdId}`
    });
  } catch (_) {
    events = [];
  }

  let match = events.find((event) => isHoldEvent(event) && eventMatchesHoldId(event, holdId));

  if (match) return match;

  const fallbackEvents = await listEvents(env, accessToken, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString()
  });

  match = fallbackEvents.find((event) => isHoldEvent(event) && eventMatchesHoldId(event, holdId));

  return match || null;
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
    throw new Error(data?.error?.message || "Failed to update calendar event");
  }

  return data;
}

function buildAutoSubmitHtml(actionUrl, postData) {
  const inputs = Object.entries(postData)
    .map(([key, value]) => {
      return `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Redirecting to secure payment...</title>
  <meta name="robots" content="noindex,nofollow">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-[#f8f6f6] text-zinc-900">
  <main class="min-h-screen flex items-center justify-center px-4">
    <div class="w-full max-w-lg rounded-[2rem] border border-zinc-200 bg-white p-8 text-center shadow-xl">
      <p class="text-sm font-semibold uppercase tracking-[0.2em] text-[#e65e19]">Boat4Two</p>
      <h1 class="mt-3 text-3xl font-black">Redirecting to secure payment</h1>
      <p class="mt-4 text-sm leading-relaxed text-zinc-600">
        Please wait while we send you to the secure myPOS checkout page.
      </p>
      <div class="mt-6 rounded-2xl bg-[#e65e19]/10 p-4 text-sm text-zinc-700">
        Secure payment powered by myPOS.
      </div>
      <form id="myposCheckoutForm" method="post" action="${escapeHtml(actionUrl)}" class="hidden">
        ${inputs}
      </form>
      <noscript>
        <div class="mt-6">
          <button form="myposCheckoutForm" type="submit" class="inline-flex h-12 items-center justify-center rounded-full bg-[#e65e19] px-6 text-sm font-bold text-white">
            Continue to payment
          </button>
        </div>
      </noscript>
    </div>
  </main>
  <script>
    document.getElementById("myposCheckoutForm").submit();
  </script>
</body>
</html>`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const missingEnvNames = getMissingPaymentEnvNames(env);

  if (missingEnvNames.length) {
    return json(
      {
        ok: false,
        error: `Missing required Google or myPOS environment variables: ${missingEnvNames.join(", ")}.`,
        missing: missingEnvNames
      },
      500
    );
  }

  try {
    const body = await request.json();
    const holdId = cleanText(body?.holdId, 120);
    const extras = sanitizeExtras(body?.extras || []);
    const responseMode = cleanText(body?.responseMode, 40);
    const requestedTestPriceMode = parseBooleanFlag(body?.testMode);

    if (!holdId) {
      return json({ ok: false, error: "Missing holdId." }, 400);
    }

    const accessToken = await getGoogleAccessToken(env);
    await bestEffortCleanupStaleBookingArtifacts(env, accessToken);
    const holdEvent = await findHoldEventById(env, accessToken, holdId);

    if (!holdEvent) {
      return json({ ok: false, error: "Hold not found." }, 404);
    }

    const holdExpiresAt = getHoldExpiresAt(holdEvent);
    if (!holdExpiresAt || Date.now() >= new Date(holdExpiresAt).getTime()) {
      return json({ ok: false, error: "This hold has expired." }, 409);
    }

    const privateProps = holdEvent.extendedProperties?.private || {};
    const tour = normalizeTour(privateProps.tour || "");
    const selectedTour = BOOKING_RULES.tours[tour];

    if (!selectedTour) {
      return json({ ok: false, error: "Invalid hold tour." }, 400);
    }

    if (selectedTour.totalAmount === null) {
      return json({ ok: false, error: "This tour is not available for online payment yet." }, 400);
    }

    const testPriceMode = requestedTestPriceMode && isTestPriceHold(holdEvent);
    const paymentExtras = testPriceMode ? [] : extras;
    const baseAmount = testPriceMode ? TEST_PRICE_TOTAL_AMOUNT : selectedTour.totalAmount;
    const extrasTotal = paymentExtras.reduce((sum, item) => sum + item.amount, 0);
    const totalAmount = Math.round((baseAmount + extrasTotal) * 100) / 100;

    const customerName = cleanText(privateProps.customerName, 120);
    const customerEmail = cleanText(privateProps.customerEmail, 200);
    const customerPhone = cleanText(privateProps.customerPhone, 80);
    const customerCountry = normalizeCountryIso3(privateProps.customerCountry);

    const nameParts = splitCustomerName(customerName);
    if (!customerEmail || !nameParts.firstNames || !nameParts.familyName) {
      return json({ ok: false, error: "Hold is missing required customer data for payment." }, 400);
    }

    const orderId = `B4T-${holdId}`;
    const walletOrderIds = {
      applePay: `${orderId}-AP`,
      googlePay: `${orderId}-GP`
    };
    const successUrl = new URL("/api/mypos-ok", request.url).toString();
    const cancelUrl = new URL("/api/mypos-cancel", request.url).toString();
    const notifyUrl = new URL("/api/mypos-notify", request.url).toString();
    const checkoutUrl = getMyposHostedCheckoutUrl(env);
    const myposApiUrl = getMyposApiUrl(env);
    const walletNumber = getWalletNumber(env);

    const paymentTourLabel = testPriceMode
      ? `TEST BOOKING - ${selectedTour.label}`
      : selectedTour.label;

    const cartItems = buildCartItems(
      paymentTourLabel,
      baseAmount,
      BOOKING_RULES.currency,
      paymentExtras
    );

    const postData = {
      IPCmethod: "IPCPurchase",
      IPCVersion: "1.4",
      IPCLanguage: "EN",
      SID: env.MYPOS_SID,
      WalletNumber: walletNumber,
      Amount: formatMoney(totalAmount),
      Currency: BOOKING_RULES.currency,
      OrderID: orderId,
      URL_OK: successUrl,
      URL_Cancel: cancelUrl,
      URL_Notify: notifyUrl,
      CardTokenRequest: "0",
      KeyIndex: String(env.MYPOS_KEY_INDEX),
      PaymentParametersRequired: "1",
      CustomerEmail: customerEmail,
      CustomerFirstNames: nameParts.firstNames,
      CustomerFamilyName: nameParts.familyName,
      CustomerPhone: customerPhone,
      Note: `Boat4Two booking ${holdId}`,
      Source: BOOKING_RULES.sourceName,
      CartItems: String(cartItems.length)
    };

    if (customerCountry) {
      postData.CustomerCountry = customerCountry;
    }

    cartItems.forEach((item, index) => {
      const row = index + 1;
      postData[`Article_${row}`] = item.name;
      postData[`Quantity_${row}`] = String(item.quantity);
      postData[`Price_${row}`] = formatMoney(item.unitPrice);
      postData[`Currency_${row}`] = item.currency;
      postData[`Amount_${row}`] = formatMoney(item.amount);
    });

    const signature = await signValuesInOrder(Object.values(postData), env.MYPOS_PRIVATE_KEY);
    postData.Signature = signature;

    const paymentStartedAtDate = new Date();
    const paymentStartedAt = paymentStartedAtDate.toISOString();
    const paymentPendingExpiresAt = addMinutes(
      paymentStartedAtDate,
      BOOKING_RULES.paymentPendingMinutes
    ).toISOString();
    const descriptionLines = [
      holdEvent.description || "",
      "",
      `Payment pending started at: ${paymentStartedAt}`,
      `Payment pending expires at: ${paymentPendingExpiresAt}`,
      `Payment Order ID: ${orderId}`,
      `Apple Pay Order ID: ${walletOrderIds.applePay}`,
      `Google Pay Order ID: ${walletOrderIds.googlePay}`,
      `Payment Amount: ${formatMoney(totalAmount)} ${BOOKING_RULES.currency}`,
      testPriceMode ? `Test payment mode: yes` : "",
      testPriceMode ? `Standard payment amount: ${formatMoney(selectedTour.totalAmount)} ${BOOKING_RULES.currency}` : "",
      paymentExtras.length ? `Payment Extras: ${JSON.stringify(paymentExtras)}` : ""
    ].filter(Boolean);

    await updateCalendarEvent(env, accessToken, holdEvent.id, {
      summary: `${testPriceMode ? "PAYMENT PENDING TEST" : "PAYMENT PENDING"} - ${selectedTour.label} - ${customerName}`,
      description: descriptionLines.join("\n"),
      extendedProperties: {
        private: {
          ...privateProps,
          bookingType: "pending_payment",
          isHold: "false",
          holdExpiresAt: "",
          paymentStatus: "pending",
          testPaymentMode: testPriceMode ? "true" : "false",
          standardPaymentAmount: testPriceMode ? formatMoney(selectedTour.totalAmount) : "",
          paymentOrderId: orderId,
          walletApplePayOrderId: walletOrderIds.applePay,
          walletGooglePayOrderId: walletOrderIds.googlePay,
          paymentAmount: formatMoney(totalAmount),
          paymentCurrency: BOOKING_RULES.currency,
          paymentExtrasJson: JSON.stringify(paymentExtras),
          paymentStartedAt,
          paymentPendingExpiresAt
        }
      }
    });

    if (responseMode === "embedded") {
      const keyIndexNumber = Number(env.MYPOS_KEY_INDEX);
      const embeddedCheckoutUrl = getMyposEmbeddedCheckoutUrl(env);
      let walletSessionToken = "";
      let applePaySessionToken = "";
      let googlePaySessionToken = "";
      let applePaySessionMeta = null;
      let googlePaySessionMeta = null;
      let walletSessionError = "";

      try {
        applePaySessionToken = await createPaymentSessionToken(env, myposApiUrl, {
          orderId: walletOrderIds.applePay,
          totalAmount,
          walletNumber,
          cartItems
        });
        applePaySessionMeta = decodeWalletSessionToken(applePaySessionToken);
      } catch (error) {
        walletSessionError = error.message || "Could not create Apple Pay payment session.";
      }

      try {
        googlePaySessionToken = await createPaymentSessionToken(env, myposApiUrl, {
          orderId: walletOrderIds.googlePay,
          totalAmount,
          walletNumber,
          cartItems
        });
        googlePaySessionMeta = decodeWalletSessionToken(googlePaySessionToken);
      } catch (error) {
        walletSessionError = walletSessionError
          ? `${walletSessionError} ${error.message || "Could not create Google Pay payment session."}`
          : (error.message || "Could not create Google Pay payment session.");
      }

      walletSessionToken = applePaySessionToken || googlePaySessionToken;

      return json({
        ok: true,
        mode: "embedded",
        holdId,
        orderId,
        walletOrderIds,
        checkoutUrl: embeddedCheckoutUrl,
        isSandbox: isMyposSandboxUrl(embeddedCheckoutUrl),
        walletSessionToken,
        walletSessionTokens: {
          applePay: applePaySessionToken,
          googlePay: googlePaySessionToken
        },
        walletSessionMeta: {
          applePay: applePaySessionMeta,
          googlePay: googlePaySessionMeta
        },
        walletSessionError,
        paymentParams: {
          sid: env.MYPOS_SID,
          ipcLanguage: "en",
          walletNumber,
          amount: Number(formatMoney(totalAmount)),
          currency: BOOKING_RULES.currency,
          orderID: orderId,
          urlNotify: notifyUrl,
          urlOk: successUrl,
          urlCancel: cancelUrl,
          keyIndex: Number.isFinite(keyIndexNumber) ? keyIndexNumber : String(env.MYPOS_KEY_INDEX),
          cartItems: cartItems.map((item) => ({
            article: item.name,
            quantity: item.quantity,
            price: Number(formatMoney(item.unitPrice)),
            currency: item.currency
          }))
        }
      });
    }

    if (responseMode === "form") {
      return json({
        ok: true,
        checkoutUrl,
        method: "POST",
        fields: postData
      });
    }

    return htmlResponse(buildAutoSubmitHtml(checkoutUrl, postData));
  } catch (error) {
    return json(
      {
        ok: false,
        ...getGoogleCalendarErrorPayload(error)
      },
      500
    );
  }
}
