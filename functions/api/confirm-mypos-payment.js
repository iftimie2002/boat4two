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
  currency: "EUR",
  tours: {
    amor: {
      label: "Amor Tour"
    },
    sunset: {
      label: "Sunset Tour"
    },
    custom: {
      label: "Custom Tour"
    }
  }
};

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function getWalletNumber(env) {
  return env.MYPOS_WALLET_NUMBER || env.MYPOS_CLIENT_NUMBER || "";
}

function getMyposApiUrl(env) {
  return env.MYPOS_CHECKOUT_URL || "https://www.mypos.com/vmp/checkout";
}

function getDescriptionValue(description, key) {
  if (!description) return "";
  const regex = new RegExp(`^${key}:(.*)$`, "mi");
  const match = description.match(regex);
  return match ? match[1].trim() : "";
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

function eventMatchesOrderId(event, orderId) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.paymentOrderId === orderId ||
    getDescriptionValue(description, "Payment Order ID") === orderId
  );
}

function isPaidEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const summary = event?.summary || "";

  return (
    privateProps.bookingType === "paid" ||
    privateProps.paymentStatus === "paid" ||
    summary.startsWith("PAID - ")
  );
}

function normalizeTour(value) {
  const v = String(value || "").trim().toLowerCase();

  if (v === "amor" || v === "private" || v === "private sailing tour for couples") return "amor";
  if (v === "sunset" || v === "sunset private sailing tour for couples") return "sunset";
  if (v === "custom" || v === "custom private tour") return "custom";

  return "";
}

function formatMoney(value) {
  return Number(value).toFixed(2);
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

async function findEventByOrderIdOrHoldId(env, accessToken, orderId, holdId) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const events = await listEvents(env, accessToken, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString()
  });

  return (
    events.find((event) =>
      (
        (orderId && eventMatchesOrderId(event, orderId)) ||
        (holdId && eventMatchesHoldId(event, holdId))
      )
    ) || null
  );
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

async function deleteCalendarEvent(env, accessToken, eventId) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 404 || response.status === 410) {
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Failed to delete calendar event");
  }
}

function buildPaidSummary(privateProps) {
  const tour = normalizeTour(privateProps.tour || "");
  const label = BOOKING_RULES.tours[tour]?.label || "Booking";
  const customerName = cleanText(privateProps.customerName, 120);

  return customerName ? `PAID - ${label} - ${customerName}` : `PAID - ${label}`;
}

async function getMyposPaymentStatus(env, orderId) {
  const walletNumber = getWalletNumber(env);
  const requestData = {
    IPCmethod: "IPCGetPaymentStatus",
    IPCVersion: "1.4",
    IPCLanguage: "EN",
    SID: env.MYPOS_SID,
    KeyIndex: String(env.MYPOS_KEY_INDEX),
    walletnumber: walletNumber,
    OrderID: orderId,
    OutputFormat: "JSON",
    get_declined_payments: "1"
  };

  requestData.Signature = await signValuesInOrder(Object.values(requestData), env.MYPOS_PRIVATE_KEY);

  const response = await fetch(getMyposApiUrl(env), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(requestData)
  });
  const text = await response.text();
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("myPOS returned an invalid payment status response.");
  }

  if (!response.ok || Number(data?.Status) !== 0) {
    throw new Error(data?.StatusMsg || "Could not check myPOS payment status.");
  }

  return data;
}

function getDeclineMessage(statusData) {
  const paymentStatus = Number(statusData?.PaymentStatus);
  const declined = Array.isArray(statusData?.DeclinedPayments)
    ? statusData.DeclinedPayments
    : [];
  const firstDecline = declined[0] || {};
  const description = cleanText(firstDecline.responseCodeDescription, 160);
  const code = cleanText(firstDecline.responseCode, 20);

  if (description && code) return `${description} (${code})`;
  if (description) return description;

  if (paymentStatus === 2) {
    return "myPOS still reports this wallet payment as pending. Please wait a moment before trying again.";
  }

  if (paymentStatus === 3) {
    return "myPOS reports this wallet payment as unsuccessful.";
  }

  if (paymentStatus === 4) {
    return "myPOS reports this wallet payment was reversed.";
  }

  if (Number.isNaN(paymentStatus)) {
    return "myPOS did not return a final payment status for this order.";
  }

  return "The wallet payment was not approved.";
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN ||
    !env.GOOGLE_CALENDAR_ID ||
    !env.MYPOS_SID ||
    !env.MYPOS_KEY_INDEX ||
    !env.MYPOS_PRIVATE_KEY ||
    !getWalletNumber(env)
  ) {
    return json({ ok: false, error: "Missing required Google or myPOS environment variables." }, 500);
  }

  try {
    const body = await request.json();
    const holdId = cleanText(body?.holdId, 120);
    const orderId = cleanText(body?.orderId, 120);

    if (!orderId) {
      return json({ ok: false, error: "Missing OrderID." }, 400);
    }

    const statusData = await getMyposPaymentStatus(env, orderId);
    const paymentStatus = Number(statusData?.PaymentStatus);
    const accessToken = await getAccessToken(env);
    const event = await findEventByOrderIdOrHoldId(env, accessToken, orderId, holdId);

    if (paymentStatus === 1) {
      if (!event) {
        return json({
          ok: true,
          paymentStatus: "paid",
          paymentStatusCode: paymentStatus,
          calendarState: "missing",
          statusData
        });
      }

      const privateProps = event.extendedProperties?.private || {};
      const amount = cleanText(statusData?.Amount, 40);
      const currency = cleanText(statusData?.Currency, 10) || BOOKING_RULES.currency;
      const expectedAmount = cleanText(privateProps.paymentAmount, 40);
      const expectedCurrency = cleanText(privateProps.paymentCurrency, 10) || BOOKING_RULES.currency;

      if (expectedAmount && formatMoney(Number(expectedAmount)) !== formatMoney(Number(amount))) {
        return json({ ok: false, error: "Amount mismatch." }, 400);
      }

      if (expectedCurrency && expectedCurrency !== currency) {
        return json({ ok: false, error: "Currency mismatch." }, 400);
      }

      const paidAt = new Date().toISOString();
      const trnref = cleanText(statusData?.IPC_Trnref, 120);
      const updatedDescription = [
        event.description || "",
        "",
        `Payment confirmed at: ${paidAt}`,
        trnref ? `Payment transaction ref: ${trnref}` : "",
        statusData?.PaymentReference ? `Payment reference: ${cleanText(statusData.PaymentReference, 120)}` : "",
        statusData?.DateTime ? `Payment datetime: ${cleanText(statusData.DateTime, 80)}` : ""
      ].filter(Boolean).join("\n");

      await updateCalendarEvent(env, accessToken, event.id, {
        summary: buildPaidSummary(privateProps),
        description: updatedDescription,
        extendedProperties: {
          private: {
            ...privateProps,
            bookingType: "paid",
            isHold: "false",
            holdExpiresAt: "",
            paymentStatus: "paid",
            paymentOrderId: orderId,
            paymentTransactionRef: trnref,
            paymentReference: cleanText(statusData?.PaymentReference, 120),
            paymentAmount: amount,
            paymentCurrency: currency,
            paidAt,
            paymentPendingExpiresAt: ""
          }
        }
      });

      return json({
        ok: true,
        paymentStatus: "paid",
        paymentStatusCode: paymentStatus,
        calendarState: "paid",
        statusData
      });
    }

    if ((paymentStatus === 3 || paymentStatus === 4) && event && !isPaidEvent(event)) {
      await deleteCalendarEvent(env, accessToken, event.id);
    }

    return json({
      ok: false,
      paymentStatus: paymentStatus === 2 ? "pending" : "declined",
      paymentStatusCode: paymentStatus,
      error: getDeclineMessage(statusData),
      statusData
    }, paymentStatus === 2 ? 409 : 402);
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Unknown error"
    }, 500);
  }
}
