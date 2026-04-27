import { getGoogleAccessToken } from "./_google.js";
import { maybeSendBookingConfirmationEmail } from "./_booking-email.js";

function textResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
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

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function getPayloadValue(payload, names) {
  for (const name of names) {
    if (payload[name] !== undefined && payload[name] !== null) {
      return payload[name];
    }
  }

  return "";
}

function getDescriptionValue(description, key) {
  if (!description) return "";
  const regex = new RegExp(`^${key}:(.*)$`, "mi");
  const match = description.match(regex);
  return match ? match[1].trim() : "";
}

function isHoldLikeEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  const summary = event?.summary || "";
  const description = event?.description || "";

  return (
    privateProps.bookingType === "hold" ||
    privateProps.bookingType === "paid" ||
    privateProps.bookingType === "payment_rollback" ||
    Boolean(privateProps.holdId) ||
    Boolean(privateProps.paymentOrderId) ||
    summary.startsWith("HOLD - ") ||
    summary.startsWith("PAID - ") ||
    /Hold ID:/i.test(description)
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

function eventMatchesOrderId(event, orderId) {
  const privateProps = event?.extendedProperties?.private || {};
  const description = event?.description || "";

  return (
    privateProps.paymentOrderId === orderId ||
    privateProps.walletApplePayOrderId === orderId ||
    privateProps.walletGooglePayOrderId === orderId ||
    getDescriptionValue(description, "Payment Order ID") === orderId ||
    getDescriptionValue(description, "Apple Pay Order ID") === orderId ||
    getDescriptionValue(description, "Google Pay Order ID") === orderId
  );
}

function formatMoney(value) {
  return Number(value).toFixed(2);
}

function normalizeTour(value) {
  const v = String(value || "").trim().toLowerCase();

  if (v === "amor" || v === "private" || v === "private sailing tour for couples") return "amor";
  if (v === "sunset" || v === "sunset private sailing tour for couples") return "sunset";
  if (v === "custom" || v === "custom private tour") return "custom";

  return "";
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

async function importPublicKeyFromCertificate(certificatePem) {
  const spki = extractSpkiFromCertificatePem(certificatePem);

  return crypto.subtle.importKey(
    "spki",
    spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );
}

async function verifyPostSignature(entries, signatureBase64, certificatePem) {
  const filteredValues = entries
    .filter(([key]) => key !== "Signature")
    .map(([, value]) => String(value));

  const payload = base64EncodeUtf8(filteredValues.join("-"));
  const publicKey = await importPublicKeyFromCertificate(certificatePem);

  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64ToBytes(signatureBase64),
    new TextEncoder().encode(payload)
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

async function findPaidEventByOrderId(env, accessToken, orderId) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const events = await listEvents(env, accessToken, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString()
  });

  return (
    events.find((event) =>
      isPaidEvent(event) && eventMatchesOrderId(event, orderId)
    ) || null
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
      isHoldLikeEvent(event) &&
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

async function applyConfirmationEmailPatch(env, accessToken, event, paymentData = {}) {
  const emailResult = await maybeSendBookingConfirmationEmail(env, event, paymentData);

  if (!emailResult.shouldPatch || !emailResult.patchPrivateProps) {
    return emailResult;
  }

  const privateProps = event?.extendedProperties?.private || {};
  await updateCalendarEvent(env, accessToken, event.id, {
    extendedProperties: {
      private: {
        ...privateProps,
        ...emailResult.patchPrivateProps
      }
    }
  });

  return emailResult;
}

async function createCalendarEvent(env, accessToken, eventBody) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(eventBody)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Failed to create calendar event");
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

  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(text || "Failed to delete calendar event");
  }
}


function extractHoldIdFromOrderId(orderId) {
  const value = cleanText(orderId, 120);
  if (value.startsWith("B4T-")) {
    return value.slice(4).replace(/-(AP|GP)$/i, "");
  }
  return "";
}

function buildPaidSummary(privateProps) {
  const tour = normalizeTour(privateProps.tour || "");
  const label = BOOKING_RULES.tours[tour]?.label || "Booking";
  const customerName = cleanText(privateProps.customerName, 120);

  return customerName ? `PAID - ${label} - ${customerName}` : `PAID - ${label}`;
}

function buildRollbackSummary(privateProps) {
  const tour = normalizeTour(privateProps.tour || "");
  const label = BOOKING_RULES.tours[tour]?.label || "Booking";
  const customerName = cleanText(privateProps.customerName, 120);

  return customerName ? `PAYMENT ROLLBACK - ${label} - ${customerName}` : `PAYMENT ROLLBACK - ${label}`;
}

function buildCancelSummary(privateProps) {
  const tour = normalizeTour(privateProps.tour || "");
  const label = BOOKING_RULES.tours[tour]?.label || "Booking";
  const customerName = cleanText(privateProps.customerName, 120);

  return customerName ? `PAYMENT CANCELLED - ${label} - ${customerName}` : `PAYMENT CANCELLED - ${label}`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN ||
    !env.GOOGLE_CALENDAR_ID ||
    !env.MYPOS_PUBLIC_CERT ||
    !env.MYPOS_SID
  ) {
    return textResponse("Configuration error", 500);
  }

  try {
    const formData = await request.formData();
    const entries = Array.from(formData.entries()).map(([key, value]) => [String(key), String(value)]);

    const signature = cleanText(formData.get("Signature"), 5000);
    if (!signature) {
      return textResponse("Missing signature", 400);
    }

    const signatureIsValid = await verifyPostSignature(entries, signature, env.MYPOS_PUBLIC_CERT);
    if (!signatureIsValid) {
      return textResponse("Invalid signature", 400);
    }

    const payload = Object.fromEntries(entries);
    const ipcMethod = cleanText(getPayloadValue(payload, ["IPCmethod", "IPCMethod", "ipcMethod"]), 80);
    const sid = cleanText(getPayloadValue(payload, ["SID", "sid"]), 80);
    const orderId = cleanText(getPayloadValue(payload, ["OrderID", "orderID", "orderId"]), 120);
    const amount = cleanText(getPayloadValue(payload, ["Amount", "amount"]), 40);
    const currency = cleanText(getPayloadValue(payload, ["Currency", "currency"]), 10);
    const trnref = cleanText(getPayloadValue(payload, ["IPC_Trnref", "ipcTrnref", "trnref"]), 120);
    const requestDateTime = cleanText(getPayloadValue(payload, ["RequestDateTime", "requestDateTime"]), 80);
    const requestStan = cleanText(getPayloadValue(payload, ["RequestSTAN", "requestSTAN", "requestStan"]), 80);

    if (sid !== env.MYPOS_SID) {
      return textResponse("Invalid SID", 400);
    }

    const holdId = extractHoldIdFromOrderId(orderId);
    if (!holdId) {
      return textResponse("Invalid OrderID", 400);
    }

    const accessToken = await getGoogleAccessToken(env);
    const event = await findEventByOrderIdOrHoldId(env, accessToken, orderId, holdId);

    if (!event) {
      return textResponse("OK", 200, {
        "X-Boat4Two-Payment-State": "missing"
      });
    }

    const privateProps = event.extendedProperties?.private || {};

    if (ipcMethod === "IPCPurchaseNotify" || ipcMethod === "IPCPurchaseOK") {
      if (privateProps.bookingType === "paid" || privateProps.paymentStatus === "paid") {
        await applyConfirmationEmailPatch(env, accessToken, event, {
          amount,
          currency,
          paymentTransactionRef: trnref
        });
        return textResponse("OK", 200, {
          "X-Boat4Two-Payment-State": "paid"
        });
      }

      const expectedAmount = cleanText(privateProps.paymentAmount, 40);
      const expectedCurrency = cleanText(privateProps.paymentCurrency, 10) || BOOKING_RULES.currency;

      if (expectedAmount && formatMoney(Number(expectedAmount)) !== formatMoney(Number(amount))) {
        return textResponse("Amount mismatch", 400);
      }

      if (expectedCurrency && expectedCurrency !== currency) {
        return textResponse("Currency mismatch", 400);
      }

      const paidAt = new Date().toISOString();

      const updatedDescription = [
        event.description || "",
        "",
        `Payment confirmed at: ${paidAt}`,
        `Payment transaction ref: ${trnref}`,
        requestDateTime ? `Payment request datetime: ${requestDateTime}` : "",
        requestStan ? `Payment request STAN: ${requestStan}` : ""
      ].filter(Boolean).join("\n");

      const paidEvent = await updateCalendarEvent(env, accessToken, event.id, {
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
            paymentAmount: amount,
            paymentCurrency: currency,
            paidAt,
            paymentPendingExpiresAt: "",
            paymentRequestDateTime: requestDateTime,
            paymentRequestSTAN: requestStan
          }
        }
      });
      await applyConfirmationEmailPatch(env, accessToken, paidEvent, {
        amount,
        currency,
        paymentTransactionRef: trnref
      });

      return textResponse("OK", 200, {
        "X-Boat4Two-Payment-State": "paid"
      });
    }

    if (ipcMethod === "IPCPurchaseCancel") {
      if (privateProps.bookingType === "paid" || privateProps.paymentStatus === "paid") {
        return textResponse("OK", 200, {
          "X-Boat4Two-Payment-State": "paid"
        });
      }

      const expectedAmount = cleanText(privateProps.paymentAmount, 40);
      const expectedCurrency = cleanText(privateProps.paymentCurrency, 10) || BOOKING_RULES.currency;

      if (expectedAmount && formatMoney(Number(expectedAmount)) !== formatMoney(Number(amount))) {
        return textResponse("Amount mismatch", 400);
      }

      if (expectedCurrency && expectedCurrency !== currency) {
        return textResponse("Currency mismatch", 400);
      }

      await deleteCalendarEvent(env, accessToken, event.id);

      return textResponse("OK", 200, {
        "X-Boat4Two-Payment-State": "cancelled"
      });
    }

    if (ipcMethod === "IPCPurchaseRollback") {
      if (privateProps.bookingType === "paid" || privateProps.paymentStatus === "paid") {
        return textResponse("OK", 200, {
          "X-Boat4Two-Payment-State": "paid"
        });
      }

      await deleteCalendarEvent(env, accessToken, event.id);

      return textResponse("OK", 200, {
        "X-Boat4Two-Payment-State": "rolled_back"
      });
    }

    return textResponse("OK", 200);
  } catch (error) {
    return textResponse(error.message || "Unknown error", 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    message: "Use POST for myPOS notify callbacks."
  });
}
