import { getActivePartner } from "./_referrals.js";

const BOOKING_TIMEZONE = "Europe/Lisbon";
const DEFAULT_FROM_EMAIL = "reservas.boat4two@gmail.com";
const DEFAULT_REPLY_TO_EMAIL = "reservas.boat4two@gmail.com";
const DEFAULT_SUPPORT_EMAIL = "reservas.boat4two@gmail.com";
const DEFAULT_SUPPORT_PHONE = "+351932015013";
const DEFAULT_SITE_URL = "https://boat4two.com";
const DEFAULT_BOOKING_NOTIFICATION_EMAIL = "info.boat4two@gmail.com";
const CLOUDFLARE_EMAIL_API_BASE = "https://api.cloudflare.com/client/v4";
const GMAIL_API_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MEETING_POINT_NAME = "Boat4Two";
const MEETING_POINT_ADDRESS = "R. Infante Santo, 8400-252 Ferragudo, Portugal";
const MEETING_POINT_MAPS_URL = "https://maps.app.goo.gl/V7J4hK9nDfdwuRDQ8?g_st=ic";

const TOUR_DETAILS = {
  amor: {
    label: "Private Sailing Tour for Couples",
    durationLabel: "3.5 hours",
    durationMinutes: 210
  },
  sunset: {
    label: "Sunset Private Sailing Tour for Couples",
    durationLabel: "3.5 hours",
    durationMinutes: 210
  },
  custom: {
    label: "Custom Private Tour",
    durationLabel: "Custom duration",
    durationMinutes: 210
  }
};

const INCLUDED_ITEMS = [
  "Private sailing tour for one couple only",
  "Skipper and guide on board",
  "Drinks and snacks",
  "Kayak",
  "SUP",
  "Snorkeling gear",
  "Short sailing lesson, if you would like",
  "Small Polaroid photo album with pictures taken during the trip"
];

const BRING_ITEMS = [
  "Swimwear",
  "Towel",
  "Sunscreen",
  "Sunglasses",
  "Hat",
  "Light jacket, especially for sunset tours",
  "Comfortable clothes",
  "Any personal medication you may need"
];

const IMPORTANT_NOTES = [
  "For safety reasons, the exact route, stops, and water activities may depend on sea and weather conditions on the day.",
  "The skipper always has the final decision regarding navigation, stops, water activities, and safety on board.",
  "Guests must not board under the influence of alcohol or recreational drugs.",
  "Life vests must be used when required, especially during kayak, SUP, or swimming-related activities."
];

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function formatDate(dateInput) {
  const value = cleanText(dateInput, 40);

  if (!value) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: BOOKING_TIMEZONE,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(date);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BOOKING_TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);
}

function formatTime(timeInput) {
  const value = cleanText(timeInput, 40);

  if (!value) {
    return "";
  }

  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return value;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const date = new Date(Date.UTC(2000, 0, 1, hours, minutes, 0));

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(date);
}

function formatMoney(value, currency = "EUR") {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "";
  }

  if ((currency || "").toUpperCase() === "EUR") {
    return `${number.toFixed(2).replace(".", ",")}€`;
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHeaderValue(value, max = 998) {
  return cleanText(String(value || "").replace(/[\r\n]+/g, " "), max);
}

function escapeHeaderDisplayName(value) {
  return sanitizeHeaderValue(value, 120).replace(/"/g, '\\"');
}

function formatAddress(address) {
  if (!address) {
    return "";
  }

  if (typeof address === "string") {
    return sanitizeHeaderValue(address, 320);
  }

  const email = sanitizeHeaderValue(address.email || address.address, 320);
  const name = escapeHeaderDisplayName(address.name || "");

  if (!email) {
    return "";
  }

  return name ? `"${name}" <${email}>` : email;
}

function formatAddressList(addresses) {
  const values = Array.isArray(addresses) ? addresses : [addresses];
  return values
    .map((entry) => formatAddress(entry))
    .filter(Boolean)
    .join(", ");
}

function bytesToBase64(bytes) {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function utf8ToBase64(value) {
  return bytesToBase64(new TextEncoder().encode(String(value || "")));
}

function utf8ToBase64Url(value) {
  return utf8ToBase64(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function foldBase64(base64Value, lineLength = 76) {
  return String(base64Value || "").match(new RegExp(`.{1,${lineLength}}`, "g"))?.join("\r\n") || "";
}

function renderListItems(items) {
  return items.map((item) => `<li style="margin:0 0 8px;">${escapeHtml(item)}</li>`).join("");
}

function buildEmailShell({ title, introHtml, sectionsHtml, footerHtml }) {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f8f6f6;color:#211611;font-family:Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border:1px solid #eadfd9;border-radius:24px;padding:32px;">
      <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#e65e19;">Boat4Two</p>
      <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#211611;">${escapeHtml(title)}</h1>
      <div style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#4a3b34;">
        ${introHtml}
      </div>
      ${sectionsHtml}
      <div style="border-top:1px solid #eadfd9;padding-top:20px;color:#4a3b34;font-size:14px;line-height:1.7;">
        ${footerHtml}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildCardSection(title, bodyHtml, tone = "soft") {
  const background = tone === "white" ? "#ffffff" : "#fff7f3";
  const border = tone === "white" ? "#eadfd9" : "#f1d9cc";

  return `<div style="border:1px solid ${border};background:${background};border-radius:20px;padding:20px 22px;margin:0 0 20px;">
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#e65e19;">${escapeHtml(title)}</p>
    ${bodyHtml}
  </div>`;
}

function getTimeZoneParts(dateInput, timeZone) {
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

  const map = {};
  formatter.formatToParts(dateInput).forEach((part) => {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  });

  return map;
}

function formatIcsUtc(dateInput) {
  return new Date(dateInput).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function formatIcsZoned(dateInput, timeZone) {
  const parts = getTimeZoneParts(new Date(dateInput), timeZone);
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

function foldIcsLine(line, lineLength = 74) {
  const value = String(line || "");
  const chunks = value.match(new RegExp(`.{1,${lineLength}}`, "g")) || [""];

  return chunks.map((chunk, index) => (index === 0 ? chunk : ` ${chunk}`)).join("\r\n");
}

function escapeIcsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function buildMimeMessage(sendPayload) {
  const hasAttachments = Array.isArray(sendPayload.attachments) && sendPayload.attachments.length > 0;
  const topBoundary = `boat4two_${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`;
  const altBoundary = `${topBoundary}_alt`;
  const plainTextBody = foldBase64(utf8ToBase64(sendPayload.text || ""));
  const htmlBody = foldBase64(utf8ToBase64(sendPayload.html || ""));
  const headers = [
    `From: ${formatAddress(sendPayload.from)}`,
    `To: ${formatAddressList(sendPayload.to)}`,
    sendPayload.bcc ? `Bcc: ${formatAddressList(sendPayload.bcc)}` : "",
    sendPayload.replyTo ? `Reply-To: ${formatAddress(sendPayload.replyTo)}` : "",
    `Subject: ${sanitizeHeaderValue(sendPayload.subject, 320)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/${hasAttachments ? "mixed" : "alternative"}; boundary="${topBoundary}"`
  ].filter(Boolean);

  const bodyLines = [
    ...headers,
    "",
    hasAttachments ? `--${topBoundary}` : `--${topBoundary}`,
    hasAttachments
      ? `Content-Type: multipart/alternative; boundary="${altBoundary}"`
      : 'Content-Type: text/plain; charset="UTF-8"',
    hasAttachments ? "" : "Content-Transfer-Encoding: base64",
    hasAttachments ? "" : plainTextBody
  ];

  if (hasAttachments) {
    bodyLines.push(
      "",
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      plainTextBody,
      "",
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      htmlBody,
      "",
      `--${altBoundary}--`
    );

    sendPayload.attachments.forEach((attachment) => {
      bodyLines.push(
        "",
        `--${topBoundary}`,
        `Content-Type: ${attachment.contentType}; name="${sanitizeHeaderValue(attachment.filename, 160)}"`,
        `Content-Disposition: ${attachment.contentDisposition || "attachment"}; filename="${sanitizeHeaderValue(attachment.filename, 160)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        foldBase64(attachment.contentBase64 || "")
      );
    });

    bodyLines.push("", `--${topBoundary}--`, "");
    return bodyLines.join("\r\n");
  }

  bodyLines.push(
    "",
    `--${topBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    htmlBody,
    "",
    `--${topBoundary}--`,
    ""
  );

  return bodyLines.join("\r\n");
}

function getGmailCredentials(env) {
  return {
    clientId: cleanText(env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID, 240),
    clientSecret: cleanText(env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET, 240),
    refreshToken: cleanText(env.GMAIL_REFRESH_TOKEN || env.GOOGLE_REFRESH_TOKEN, 800),
    fromEmail:
      cleanText(env.GMAIL_FROM_EMAIL || env.BOOKING_CONFIRMATION_FROM_EMAIL, 240) ||
      DEFAULT_FROM_EMAIL
  };
}

function hasGmailCredentials(env) {
  const credentials = getGmailCredentials(env);
  return Boolean(credentials.clientId && credentials.clientSecret && credentials.refreshToken);
}

function hasCloudflareEmailApiCredentials(env) {
  const accountId = cleanText(
    env.CLOUDFLARE_EMAIL_ACCOUNT_ID ||
    env.CLOUDFLARE_ACCOUNT_ID ||
    env.CF_ACCOUNT_ID,
    80
  );
  const apiToken = cleanText(env.CLOUDFLARE_EMAIL_API_TOKEN, 400);
  return Boolean(accountId && apiToken);
}

async function getGmailAccessToken(env) {
  const credentials = getGmailCredentials(env);

  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    throw new Error("Missing Gmail API credentials.");
  }

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token"
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.access_token) {
    const errorMessage = cleanText(
      data?.error_description || data?.error || "Could not refresh Gmail access token.",
      240
    );
    throw new Error(errorMessage);
  }

  return {
    accessToken: data.access_token,
    fromEmail: credentials.fromEmail
  };
}

export function getBookingEmailDiagnostics(env) {
  const gmailCredentials = getGmailCredentials(env);
  const hasGmail = hasGmailCredentials(env);
  const hasBinding = Boolean(env.BOOKING_EMAIL && typeof env.BOOKING_EMAIL.send === "function");
  const hasCloudflareApi = hasCloudflareEmailApiCredentials(env);

  return {
    provider:
      hasGmail ? "gmail" :
      hasBinding ? "cloudflare_binding" :
      hasCloudflareApi ? "cloudflare_api" :
      "none",
    loaded: {
      GMAIL_CLIENT_ID: Boolean(gmailCredentials.clientId),
      GMAIL_CLIENT_SECRET: Boolean(gmailCredentials.clientSecret),
      GMAIL_REFRESH_TOKEN: Boolean(gmailCredentials.refreshToken),
      GMAIL_FROM_EMAIL: Boolean(gmailCredentials.fromEmail),
      BOOKING_EMAIL_BINDING: hasBinding,
      CLOUDFLARE_EMAIL_API_TOKEN: Boolean(cleanText(env.CLOUDFLARE_EMAIL_API_TOKEN, 400)),
      CLOUDFLARE_EMAIL_ACCOUNT_ID: Boolean(
        cleanText(
          env.CLOUDFLARE_EMAIL_ACCOUNT_ID ||
          env.CLOUDFLARE_ACCOUNT_ID ||
          env.CF_ACCOUNT_ID,
          80
        )
      )
    },
    fromEmail: gmailCredentials.fromEmail || DEFAULT_FROM_EMAIL,
    replyToEmail: cleanText(env.BOOKING_CONFIRMATION_REPLY_TO_EMAIL, 200) || DEFAULT_REPLY_TO_EMAIL,
    bookingNotificationEmail:
      cleanText(env.BOOKING_NOTIFICATION_EMAIL, 200) || DEFAULT_BOOKING_NOTIFICATION_EMAIL
  };
}

export async function testBookingEmailConnection(env) {
  const diagnostics = getBookingEmailDiagnostics(env);

  if (diagnostics.provider === "gmail") {
    const gmailAccess = await getGmailAccessToken(env);
    return {
      ok: true,
      provider: "gmail",
      fromEmail: gmailAccess.fromEmail
    };
  }

  if (diagnostics.provider === "cloudflare_binding") {
    return {
      ok: true,
      provider: "cloudflare_binding"
    };
  }

  if (diagnostics.provider === "cloudflare_api") {
    return {
      ok: true,
      provider: "cloudflare_api"
    };
  }

  throw new Error("Missing Gmail API credentials or fallback email credentials.");
}

function buildBookingEmailModel(env, event, paymentData = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  const rawTour = cleanText(privateProps.tour, 80).toLowerCase();
  const details = TOUR_DETAILS[rawTour] || TOUR_DETAILS.custom;
  const startIso = cleanText(event?.start?.dateTime || "", 80);
  const endIso = cleanText(event?.end?.dateTime || "", 80);
  const timeZone = cleanText(event?.start?.timeZone || event?.end?.timeZone, 80) || BOOKING_TIMEZONE;
  const leadTravelerName = cleanText(
    `${privateProps.leadTravelerFirstName || ""} ${privateProps.leadTravelerLastName || ""}`,
    120
  );
  const customerName = cleanText(privateProps.customerName, 120) || leadTravelerName;
  const customerEmail =
    cleanText(privateProps.customerEmail, 200) ||
    cleanText(privateProps.leadTravelerEmail, 200);
  const customerPhone =
    cleanText(privateProps.customerPhone, 80) ||
    cleanText(privateProps.leadTravelerPhone, 80);
  const customerCountry =
    cleanText(privateProps.customerCountry, 120) ||
    cleanText(privateProps.leadTravelerCountry, 120);
  const customerOccasion = cleanText(privateProps.customerOccasion, 200);
  const customerMessage = cleanText(privateProps.customerMessage, 1000);
  const tourLabel =
    cleanText(
      privateProps.tourLabel || privateProps.tourName || privateProps.tourDisplayName,
      160
    ) ||
    details.label ||
    "Boat4Two booking";
  const dateLabel = formatDate(privateProps.date || startIso || event?.start?.date);
  const timeLabel = formatTime(privateProps.time);
  const amountLabel = formatMoney(
    paymentData.amount || privateProps.paymentAmount,
    paymentData.currency || privateProps.paymentCurrency || "EUR"
  );
  const paymentAmount = cleanText(paymentData.amount || privateProps.paymentAmount, 40);
  const paymentCurrency = cleanText(
    paymentData.currency || privateProps.paymentCurrency || "EUR",
    10
  ).toUpperCase();
  const paymentReference = cleanText(
    paymentData.paymentReference || privateProps.paymentReference,
    120
  );
  const transactionReference = cleanText(
    paymentData.paymentTransactionRef || privateProps.paymentTransactionRef,
    120
  );
  const bookingReference = cleanText(
    privateProps.gygBookingReference ||
    privateProps.paymentOrderId ||
    privateProps.holdId ||
    event?.id,
    160
  );

  return {
    source: cleanText(privateProps.source, 80),
    salesChannel: cleanText(privateProps.salesChannel, 80),
    referralPartnerId: cleanText(privateProps.referralPartnerId, 80),
    referralPartnerName: cleanText(privateProps.referralPartnerName, 120),
    referralPartnerType: cleanText(privateProps.referralPartnerType, 80),
    referralCapturedAt: cleanText(privateProps.referralCapturedAt, 80),
    referralAttributionModel: cleanText(privateProps.referralAttributionModel, 80),
    gygBookingReference: cleanText(privateProps.gygBookingReference, 120),
    gygActivityReference: cleanText(privateProps.gygActivityReference, 120),
    rawTour,
    customerName,
    customerEmail,
    customerPhone,
    customerCountry,
    customerOccasion,
    customerMessage,
    tourLabel,
    dateLabel,
    timeLabel,
    paymentAmount,
    paymentCurrency,
    amountLabel,
    paymentReference,
    transactionReference,
    durationLabel: details.durationLabel,
    durationMinutes: details.durationMinutes,
    guestCount: 2,
    siteUrl: cleanText(env.BOOKING_CONFIRMATION_SITE_URL, 200) || DEFAULT_SITE_URL,
    supportEmail: cleanText(env.BOOKING_CONFIRMATION_SUPPORT_EMAIL, 200) || DEFAULT_SUPPORT_EMAIL,
    supportPhone: cleanText(env.BOOKING_CONFIRMATION_SUPPORT_PHONE, 40) || DEFAULT_SUPPORT_PHONE,
    replyToEmail: cleanText(env.BOOKING_CONFIRMATION_REPLY_TO_EMAIL, 200) || DEFAULT_REPLY_TO_EMAIL,
    fromEmail: cleanText(env.BOOKING_CONFIRMATION_FROM_EMAIL, 200) || DEFAULT_FROM_EMAIL,
    bccEmail: cleanText(env.BOOKING_CONFIRMATION_BCC_EMAIL, 200),
    bookingNotificationEmail:
      cleanText(env.BOOKING_NOTIFICATION_EMAIL, 200) || DEFAULT_BOOKING_NOTIFICATION_EMAIL,
    startIso,
    endIso,
    timeZone,
    bookingReference,
    meetingPointName: MEETING_POINT_NAME,
    meetingPointAddress: MEETING_POINT_ADDRESS,
    meetingPointMapsUrl: MEETING_POINT_MAPS_URL,
    includedItems: INCLUDED_ITEMS,
    bringItems: BRING_ITEMS,
    importantNotes: IMPORTANT_NOTES
  };
}

function buildPaymentConfirmationSubject() {
  return "Your Boat4Two booking is confirmed";
}

function buildPaymentConfirmationText(model) {
  return [
    `Hello ${model.customerName || "there"},`,
    "",
    "Your payment was received and your Boat4Two booking is now confirmed.",
    "",
    "Booking details",
    "",
    `Tour: ${model.tourLabel}`,
    model.dateLabel ? `Date: ${model.dateLabel}` : "",
    model.timeLabel ? `Time: ${model.timeLabel}` : "",
    model.amountLabel ? `Paid: ${model.amountLabel}` : "",
    model.paymentReference ? `Payment reference: ${model.paymentReference}` : "",
    model.transactionReference ? `Transaction reference: ${model.transactionReference}` : "",
    "",
    "What happens next",
    "",
    "You will also receive a second email shortly with all tour details, including the meeting point, what is included, what to bring, important safety information, and a calendar file you can add to your own calendar.",
    "",
    "If you would like an invoice, please reply to this email with the invoice name, tax or VAT number, and billing address, and we will send it within the next few hours.",
    "",
    "If you need to request a cancellation or refund, please email us with your booking name, tour date, and payment reference.",
    "",
    "Kind regards,",
    "Boat4Two"
  ].filter(Boolean).join("\n");
}

function buildPaymentConfirmationHtml(model) {
  const sectionsHtml = [
    buildCardSection(
      "Booking details",
      `
        <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#211611;">${escapeHtml(model.tourLabel)}</p>
        ${model.dateLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Date:</strong> ${escapeHtml(model.dateLabel)}</p>` : ""}
        ${model.timeLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Time:</strong> ${escapeHtml(model.timeLabel)}</p>` : ""}
        ${model.amountLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Paid:</strong> ${escapeHtml(model.amountLabel)}</p>` : ""}
        ${model.paymentReference ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Payment reference:</strong> ${escapeHtml(model.paymentReference)}</p>` : ""}
        ${model.transactionReference ? `<p style="margin:0;font-size:14px;color:#4a3b34;"><strong>Transaction reference:</strong> ${escapeHtml(model.transactionReference)}</p>` : ""}
      `
    ),
    buildCardSection(
      "What happens next",
      `
        <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#4a3b34;">
          You will also receive a second email shortly with all tour details, including the meeting point, what is included, what to bring, important safety information, and a calendar file you can add to your own calendar.
        </p>
        <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#4a3b34;">
          If you would like an invoice, please reply to this email with the invoice name, tax or VAT number, and billing address, and we will send it within the next few hours.
        </p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#4a3b34;">
          If you need to request a cancellation or refund, please email us with your booking name, tour date, and payment reference.
        </p>
      `,
      "white"
    )
  ].join("");

  const footerHtml = [
    `<p style="margin:0 0 8px;"><strong>Support email:</strong> <a href="mailto:${escapeHtml(model.supportEmail)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.supportEmail)}</a></p>`,
    `<p style="margin:0 0 8px;"><strong>Phone / WhatsApp:</strong> <a href="tel:${escapeHtml(model.supportPhone)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.supportPhone)}</a></p>`,
    `<p style="margin:0;"><strong>Website:</strong> <a href="${escapeHtml(model.siteUrl)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.siteUrl)}</a></p>`
  ].join("");

  return buildEmailShell({
    title: "Your booking is confirmed",
    introHtml: `<p style="margin:0;">Hello ${escapeHtml(model.customerName || "there")}, your payment was received and your Boat4Two booking is now confirmed.</p>`,
    sectionsHtml,
    footerHtml
  });
}

function buildTourDetailsSubject() {
  return "Your Boat4Two tour details";
}

function buildTourDetailsText(model) {
  return [
    `Hello ${model.customerName || "there"},`,
    "",
    "Here are all the details for your Boat4Two experience.",
    "",
    "Booking details",
    "",
    `Tour: ${model.tourLabel}`,
    model.dateLabel ? `Date: ${model.dateLabel}` : "",
    model.timeLabel ? `Time: ${model.timeLabel}` : "",
    model.durationLabel ? `Duration: ${model.durationLabel}` : "",
    `Guests: ${model.guestCount} people`,
    model.paymentReference ? `Payment reference: ${model.paymentReference}` : "",
    "",
    "Meeting point",
    "",
    `${model.meetingPointName}`,
    `${model.meetingPointAddress}`,
    "",
    "Google Maps:",
    `${model.meetingPointMapsUrl}`,
    "",
    "Please follow the Google Maps pin exactly.",
    "",
    "When you arrive at the meeting point, please go to the Ferry Boat Booth. They will already be expecting you. Just let them know you are there for your Boat4Two tour, and they will take you to our boat by ferry boat.",
    "",
    "Please arrive 10 to 15 minutes before your scheduled tour time, so there is enough time for the short transfer and we can start the tour on time.",
    "",
    "If you are coming by car, we recommend leaving a little extra time for parking, especially during busier months.",
    "",
    "What is included",
    "",
    ...model.includedItems.map((item) => `- ${item}`),
    "",
    "What to bring",
    "",
    ...model.bringItems.map((item) => `- ${item}`),
    "",
    "Important safety notes",
    "",
    ...model.importantNotes.map((item) => `- ${item}`),
    "",
    "Add to your calendar",
    "",
    "A calendar file (.ics) is attached to this email so you can add your tour to Apple Calendar, Google Calendar, Outlook, or another calendar app.",
    model.calendarAddUrl ? `Google Calendar link: ${model.calendarAddUrl}` : "",
    "",
    "If you need to request a cancellation or refund, please email us with your booking name, tour date, and payment reference.",
    "",
    "We look forward to welcoming you on board.",
    "",
    "Kind regards,",
    "Boat4Two"
  ].filter(Boolean).join("\n");
}

function buildTourDetailsHtml(model) {
  const bookingDetailsBody = `
    <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#211611;">${escapeHtml(model.tourLabel)}</p>
    ${model.dateLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Date:</strong> ${escapeHtml(model.dateLabel)}</p>` : ""}
    ${model.timeLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Time:</strong> ${escapeHtml(model.timeLabel)}</p>` : ""}
    ${model.durationLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Duration:</strong> ${escapeHtml(model.durationLabel)}</p>` : ""}
    <p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Guests:</strong> ${model.guestCount} people</p>
    ${model.paymentReference ? `<p style="margin:0;font-size:14px;color:#4a3b34;"><strong>Payment reference:</strong> ${escapeHtml(model.paymentReference)}</p>` : ""}
  `;

  const meetingPointBody = `
    <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#211611;">${escapeHtml(model.meetingPointName)}</p>
    <p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#4a3b34;">${escapeHtml(model.meetingPointAddress)}</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#4a3b34;">Please follow the Google Maps pin exactly.</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#4a3b34;">When you arrive at the meeting point, please go to the Ferry Boat Booth. They will already be expecting you. Just let them know you are there for your Boat4Two tour, and they will take you to our boat by ferry boat.</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#4a3b34;">Please arrive 10 to 15 minutes before your scheduled tour time, so there is enough time for the short transfer and we can start the tour on time.</p>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#4a3b34;">If you are coming by car, we recommend leaving a little extra time for parking, especially during busier months.</p>
    <a href="${escapeHtml(model.meetingPointMapsUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#e65e19;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Open Google Maps</a>
  `;

  const sectionsHtml = [
    buildCardSection("Booking details", bookingDetailsBody),
    buildCardSection("Meeting point", meetingPointBody, "white"),
    buildCardSection(
      "What is included",
      `<ul style="margin:0;padding-left:20px;color:#4a3b34;font-size:14px;line-height:1.7;">${renderListItems(model.includedItems)}</ul>`
    ),
    buildCardSection(
      "What to bring",
      `<ul style="margin:0;padding-left:20px;color:#4a3b34;font-size:14px;line-height:1.7;">${renderListItems(model.bringItems)}</ul>`,
      "white"
    ),
    buildCardSection(
      "Important safety notes",
      `<ul style="margin:0;padding-left:20px;color:#4a3b34;font-size:14px;line-height:1.7;">${renderListItems(model.importantNotes)}</ul>`
    ),
    buildCardSection(
      "Add to your calendar",
      `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#4a3b34;">A calendar file (.ics) is attached to this email so you can add your tour to Apple Calendar, Google Calendar, Outlook, or another calendar app.</p>
      ${model.calendarAddUrl ? `<a href="${escapeHtml(model.calendarAddUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#e65e19;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Add with Google Calendar</a>` : ""}`,
      "white"
    )
  ].join("");

  const footerHtml = [
    `<p style="margin:0 0 10px;">If you need to request a cancellation or refund, please email us with your booking name, tour date, and payment reference.</p>`,
    `<p style="margin:0 0 10px;">We look forward to welcoming you on board.</p>`,
    `<p style="margin:0 0 8px;"><strong>Support email:</strong> <a href="mailto:${escapeHtml(model.supportEmail)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.supportEmail)}</a></p>`,
    `<p style="margin:0;"><strong>Phone / WhatsApp:</strong> <a href="tel:${escapeHtml(model.supportPhone)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.supportPhone)}</a></p>`
  ].join("");

  return buildEmailShell({
    title: "Your tour details",
    introHtml: `<p style="margin:0;">Hello ${escapeHtml(model.customerName || "there")}, here are all the details for your Boat4Two experience.</p>`,
    sectionsHtml,
    footerHtml
  });
}

function buildCalendarFilename(model) {
  const datePart = cleanText(model.startIso || model.dateLabel, 32)
    .replace(/[^0-9]/g, "")
    .slice(0, 8) || "tour";
  const tourPart = cleanText(model.rawTour || "boat4two", 40).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `boat4two-${tourPart}-${datePart}.ics`;
}

function buildCalendarIcs(model) {
  const uid = `${cleanText(model.bookingReference || "boat4two", 120)}@boat4two.com`;
  const startValue = model.startIso ? formatIcsZoned(model.startIso, model.timeZone) : "";
  const endValue = model.endIso ? formatIcsZoned(model.endIso, model.timeZone) : "";
  const descriptionLines = [
    `Booking: ${model.tourLabel}`,
    model.dateLabel ? `Date: ${model.dateLabel}` : "",
    model.timeLabel ? `Time: ${model.timeLabel}` : "",
    model.durationLabel ? `Duration: ${model.durationLabel}` : "",
    `Guests: ${model.guestCount} people`,
    model.paymentReference ? `Payment reference: ${model.paymentReference}` : "",
    "",
    "Meeting point:",
    model.meetingPointName,
    model.meetingPointAddress,
    model.meetingPointMapsUrl,
    "",
    "Please arrive 10 to 15 minutes early and go to the Ferry Boat Booth."
  ].filter(Boolean).join("\n");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Boat4Two//Tour Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-TIMEZONE:${escapeIcsText(model.timeZone || BOOKING_TIMEZONE)}`,
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${formatIcsUtc(new Date())}`,
    startValue ? `DTSTART;TZID=${model.timeZone}:${startValue}` : "",
    endValue ? `DTEND;TZID=${model.timeZone}:${endValue}` : "",
    `SUMMARY:${escapeIcsText(model.tourLabel)}`,
    `LOCATION:${escapeIcsText(`${model.meetingPointName}, ${model.meetingPointAddress}`)}`,
    `DESCRIPTION:${escapeIcsText(descriptionLines)}`,
    `URL:${escapeIcsText(model.meetingPointMapsUrl)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].filter(Boolean).map((line) => foldIcsLine(line)).join("\r\n");
}

function buildCalendarAddUrl(model) {
  if (!model.startIso || !model.endIso) {
    return "";
  }

  const details = [
    `Booking: ${model.tourLabel}`,
    model.dateLabel ? `Date: ${model.dateLabel}` : "",
    model.timeLabel ? `Time: ${model.timeLabel}` : "",
    model.durationLabel ? `Duration: ${model.durationLabel}` : "",
    `Guests: ${model.guestCount} people`,
    model.paymentReference ? `Payment reference: ${model.paymentReference}` : "",
    "",
    "Meeting point:",
    model.meetingPointName,
    model.meetingPointAddress,
    model.meetingPointMapsUrl,
    "",
    "Please arrive 10 to 15 minutes early and go to the Ferry Boat Booth."
  ].filter(Boolean).join("\n");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: model.tourLabel || "Boat4Two tour",
    dates: `${formatIcsUtc(model.startIso)}/${formatIcsUtc(model.endIso)}`,
    details,
    location: `${model.meetingPointName}, ${model.meetingPointAddress}`,
    ctz: model.timeZone || BOOKING_TIMEZONE
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildPaymentConfirmationPayload(model) {
  return {
    subject: buildPaymentConfirmationSubject(),
    html: buildPaymentConfirmationHtml(model),
    text: buildPaymentConfirmationText(model)
  };
}

function buildTourDetailsPayload(model) {
  const calendarAddUrl = buildCalendarAddUrl(model);

  return {
    subject: buildTourDetailsSubject(),
    html: buildTourDetailsHtml({
      ...model,
      calendarAddUrl
    }),
    text: buildTourDetailsText({
      ...model,
      calendarAddUrl
    }),
    attachments: [
      {
        filename: buildCalendarFilename(model),
        contentType: 'text/calendar; charset="UTF-8"; method=PUBLISH',
        contentDisposition: "attachment",
        contentBase64: utf8ToBase64(buildCalendarIcs(model))
      }
    ]
  };
}

function isPartnerReferralBooking(model) {
  return (
    model.source !== "getyourguide" &&
    model.salesChannel === "partner_referral" &&
    Boolean(model.referralPartnerId && model.referralPartnerName)
  );
}

function buildAdminNotificationSubject(model) {
  const sourceLabel = model.source === "getyourguide" ? "GetYourGuide" : "Boat4Two";
  if (isPartnerReferralBooking(model)) {
    return `New ${model.referralPartnerName} referral booking confirmed - ${model.tourLabel}`;
  }
  return `New ${sourceLabel} booking confirmed - ${model.tourLabel}`;
}

function buildAdminNotificationText(model) {
  const sourceLabel = model.source === "getyourguide" ? "GetYourGuide" : "Boat4Two";

  return [
    `A new ${sourceLabel} booking has just been confirmed.`,
    "",
    "Booking details",
    "",
    `Source: ${sourceLabel}`,
    isPartnerReferralBooking(model) ? "Sales channel: Partner Referral" : "",
    isPartnerReferralBooking(model)
      ? `Referral partner: ${model.referralPartnerName}`
      : "",
    isPartnerReferralBooking(model)
      ? `Referral ID: ${model.referralPartnerId}`
      : "",
    `Tour: ${model.tourLabel}`,
    model.dateLabel ? `Date: ${model.dateLabel}` : "",
    model.timeLabel ? `Time: ${model.timeLabel}` : "",
    model.durationLabel ? `Duration: ${model.durationLabel}` : "",
    `Guests: ${model.guestCount} people`,
    model.amountLabel ? `Paid: ${model.amountLabel}` : "",
    model.paymentReference ? `Payment reference: ${model.paymentReference}` : "",
    model.transactionReference ? `Transaction reference: ${model.transactionReference}` : "",
    model.bookingReference ? `Booking reference: ${model.bookingReference}` : "",
    model.source === "getyourguide" && model.gygActivityReference
      ? `GYG activity reference: ${model.gygActivityReference}`
      : "",
    "",
    "Client details",
    "",
    model.customerName ? `Name: ${model.customerName}` : "",
    model.customerEmail ? `Email: ${model.customerEmail}` : "",
    model.customerPhone ? `Phone: ${model.customerPhone}` : "",
    model.customerCountry ? `Country: ${model.customerCountry}` : "",
    model.customerOccasion ? `Occasion: ${model.customerOccasion}` : "",
    model.customerMessage ? `Notes: ${model.customerMessage}` : "",
    "",
    "Meeting point",
    "",
    `${model.meetingPointName}`,
    `${model.meetingPointAddress}`,
    `${model.meetingPointMapsUrl}`
  ].filter(Boolean).join("\n");
}

function buildAdminNotificationHtml(model) {
  const sourceLabel = model.source === "getyourguide" ? "GetYourGuide" : "Boat4Two";
  const sectionsHtml = [
    buildCardSection(
      "Booking details",
      `
        <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#211611;">${escapeHtml(model.tourLabel)}</p>
        <p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Source:</strong> ${escapeHtml(sourceLabel)}</p>
        ${isPartnerReferralBooking(model) ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Sales channel:</strong> Partner Referral</p>` : ""}
        ${isPartnerReferralBooking(model) ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Referral partner:</strong> ${escapeHtml(model.referralPartnerName)}</p>` : ""}
        ${isPartnerReferralBooking(model) ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Referral ID:</strong> ${escapeHtml(model.referralPartnerId)}</p>` : ""}
        ${model.dateLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Date:</strong> ${escapeHtml(model.dateLabel)}</p>` : ""}
        ${model.timeLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Time:</strong> ${escapeHtml(model.timeLabel)}</p>` : ""}
        ${model.durationLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Duration:</strong> ${escapeHtml(model.durationLabel)}</p>` : ""}
        <p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Guests:</strong> ${model.guestCount} people</p>
        ${model.amountLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Paid:</strong> ${escapeHtml(model.amountLabel)}</p>` : ""}
        ${model.paymentReference ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Payment reference:</strong> ${escapeHtml(model.paymentReference)}</p>` : ""}
        ${model.transactionReference ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Transaction reference:</strong> ${escapeHtml(model.transactionReference)}</p>` : ""}
        ${model.bookingReference ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Booking reference:</strong> ${escapeHtml(model.bookingReference)}</p>` : ""}
        ${model.source === "getyourguide" && model.gygActivityReference ? `<p style="margin:0;font-size:14px;color:#4a3b34;"><strong>GYG activity reference:</strong> ${escapeHtml(model.gygActivityReference)}</p>` : ""}
      `
    ),
    buildCardSection(
      "Client details",
      `
        ${model.customerName ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Name:</strong> ${escapeHtml(model.customerName)}</p>` : ""}
        ${model.customerEmail ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Email:</strong> <a href="mailto:${escapeHtml(model.customerEmail)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.customerEmail)}</a></p>` : ""}
        ${model.customerPhone ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Phone:</strong> ${escapeHtml(model.customerPhone)}</p>` : ""}
        ${model.customerCountry ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Country:</strong> ${escapeHtml(model.customerCountry)}</p>` : ""}
        ${model.customerOccasion ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Occasion:</strong> ${escapeHtml(model.customerOccasion)}</p>` : ""}
        ${model.customerMessage ? `<p style="margin:0;font-size:14px;color:#4a3b34;"><strong>Notes:</strong> ${escapeHtml(model.customerMessage)}</p>` : ""}
      `,
      "white"
    ),
    buildCardSection(
      "Meeting point",
      `
        <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#211611;">${escapeHtml(model.meetingPointName)}</p>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#4a3b34;">${escapeHtml(model.meetingPointAddress)}</p>
        <a href="${escapeHtml(model.meetingPointMapsUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#e65e19;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Open Google Maps</a>
      `
    )
  ].join("");

  return buildEmailShell({
    title: "New booking confirmed",
    introHtml: `<p style="margin:0;">A new ${escapeHtml(sourceLabel)} booking has just been confirmed.</p>`,
    sectionsHtml,
    footerHtml: `<p style="margin:0;">This notification was sent automatically from the Boat4Two booking flow.</p>`
  });
}

function buildAdminNotificationPayload(model) {
  return {
    subject: buildAdminNotificationSubject(model),
    html: buildAdminNotificationHtml(model),
    text: buildAdminNotificationText(model)
  };
}

function calculatePartnerCommission(amount, currency, commissionRateBasisPoints) {
  const amountText = String(amount ?? "").trim();
  const amountNumber = Number(amountText);
  const rateNumber = Number(commissionRateBasisPoints);

  if (
    !/^\d+(?:\.\d{1,2})?$/.test(amountText) ||
    !Number.isFinite(amountNumber) ||
    amountNumber < 0 ||
    !Number.isInteger(rateNumber) ||
    rateNumber < 0 ||
    rateNumber > 10000
  ) {
    return null;
  }

  const totalMinorUnits = Math.round(amountNumber * 100);
  const commissionMinorUnits = Math.round(totalMinorUnits * rateNumber / 10000);

  return {
    amount: (commissionMinorUnits / 100).toFixed(2),
    amountLabel: formatMoney(commissionMinorUnits / 100, currency || "EUR"),
    ratePercent: rateNumber / 100
  };
}

function buildPartnerReferralNotificationPayload(model, partnerOverride = null) {
  if (!isPartnerReferralBooking(model)) return null;

  const partner = partnerOverride || getActivePartner(model.referralPartnerId);
  if (!partner || partner.id !== model.referralPartnerId) return null;

  const recipient = cleanText(partner.notificationEmail, 200);
  const commission = calculatePartnerCommission(
    model.paymentAmount,
    model.paymentCurrency,
    partner.commissionRateBasisPoints
  );
  if (!recipient || !commission || !model.amountLabel) return null;

  const rateLabel = `${commission.ratePercent.toLocaleString("en-GB", {
    maximumFractionDigits: 2
  })}%`;
  const text = [
    "Dear partner,",
    "",
    "We got another booking through your referral.",
    "",
    "Booking details",
    "",
    model.customerName ? `Customer name: ${model.customerName}` : "",
    `Tour: ${model.tourLabel}`,
    model.dateLabel ? `Date: ${model.dateLabel}` : "",
    model.timeLabel ? `Time: ${model.timeLabel}` : "",
    `Total booking: ${model.amountLabel}`,
    `Your commission (${rateLabel}): ${commission.amountLabel}`,
    model.bookingReference ? `Booking reference: ${model.bookingReference}` : "",
    "",
    "Thank you for working with Boat4Two.",
    "",
    "Kind regards,",
    "Boat4Two"
  ].filter(Boolean).join("\n");
  const sectionsHtml = buildCardSection(
    "Referral booking",
    `
      <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#211611;">${escapeHtml(model.tourLabel)}</p>
      ${model.customerName ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Customer name:</strong> ${escapeHtml(model.customerName)}</p>` : ""}
      ${model.dateLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Date:</strong> ${escapeHtml(model.dateLabel)}</p>` : ""}
      ${model.timeLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Time:</strong> ${escapeHtml(model.timeLabel)}</p>` : ""}
      <p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Total booking:</strong> ${escapeHtml(model.amountLabel)}</p>
      <p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Your commission (${escapeHtml(rateLabel)}):</strong> ${escapeHtml(commission.amountLabel)}</p>
      ${model.bookingReference ? `<p style="margin:0;font-size:14px;color:#4a3b34;"><strong>Booking reference:</strong> ${escapeHtml(model.bookingReference)}</p>` : ""}
    `
  );

  return {
    to: recipient,
    subject: `Another booking through your ${partner.displayName} referral`,
    text,
    html: buildEmailShell({
      title: "Another referral booking",
      introHtml: "<p style=\"margin:0 0 12px;\">Dear partner,</p><p style=\"margin:0;\">We got another booking through your referral.</p>",
      sectionsHtml,
      footerHtml: "<p style=\"margin:0;\">Thank you for working with Boat4Two.</p>"
    }),
    commissionAmount: commission.amount,
    commissionAmountLabel: commission.amountLabel,
    commissionCurrency: model.paymentCurrency || "EUR",
    commissionRateBasisPoints: String(partner.commissionRateBasisPoints)
  };
}

function buildSendPayload(model, content, overrides = {}) {
  const payload = {
    to: overrides.to || model.customerEmail,
    from: {
      email: model.fromEmail,
      name: "Boat4Two Reservations"
    },
    replyTo: {
      email: model.replyToEmail,
      name: "Boat4Two Reservations"
    },
    subject: content.subject,
    html: content.html,
    text: content.text
  };

  if (model.bccEmail && overrides.includeBcc !== false) {
    payload.bcc = model.bccEmail;
  }

  if (Array.isArray(content.attachments) && content.attachments.length) {
    payload.attachments = content.attachments;
  }

  return payload;
}

function buildEmailPatchResult(status, patchPrivateProps, shouldPatch) {
  return {
    status,
    shouldPatch,
    patchPrivateProps
  };
}

export async function maybeSendBookingConfirmationEmail(env, event, paymentData = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  const isPaidBooking =
    privateProps.bookingType === "paid" ||
    privateProps.paymentStatus === "paid" ||
    String(event?.summary || "").startsWith("PAID - ");
  const partnerNotificationAlreadySentAt = cleanText(
    privateProps.partnerReferralNotificationEmailSentAt,
    80
  );
  const paymentConfirmationAlreadySentAt =
    cleanText(privateProps.paymentConfirmationEmailSentAt, 80) ||
    cleanText(privateProps.bookingConfirmationEmailSentAt, 80);
  const tourDetailsAlreadySentAt = cleanText(privateProps.tourDetailsEmailSentAt, 80);
  const adminNotificationAlreadySentAt = cleanText(
    privateProps.adminBookingNotificationEmailSentAt,
    80
  );
  const model = buildBookingEmailModel(env, event, paymentData);

  const patchPrivateProps = {};

  if (isPaidBooking && isPartnerReferralBooking(model) && !partnerNotificationAlreadySentAt) {
    const partnerNotification = buildPartnerReferralNotificationPayload(model);

    if (!partnerNotification) {
      patchPrivateProps.partnerReferralNotificationEmailStatus = "failed";
      patchPrivateProps.partnerReferralNotificationEmailError =
        "The referral partner, recipient, commission rate, or paid amount is invalid.";
    } else {
      try {
        const partnerResult = await sendBookingEmail(
          env,
          buildSendPayload(model, partnerNotification, {
            to: partnerNotification.to,
            includeBcc: false
          })
        );
        patchPrivateProps.partnerReferralNotificationEmailStatus = "sent";
        patchPrivateProps.partnerReferralNotificationEmailSentAt = new Date().toISOString();
        patchPrivateProps.partnerReferralNotificationEmailError = "";
        patchPrivateProps.partnerReferralNotificationEmailMessageId = cleanText(
          partnerResult?.messageId,
          200
        );
        patchPrivateProps.partnerReferralCommissionAmount = partnerNotification.commissionAmount;
        patchPrivateProps.partnerReferralCommissionCurrency =
          partnerNotification.commissionCurrency;
        patchPrivateProps.partnerReferralCommissionRateBasisPoints =
          partnerNotification.commissionRateBasisPoints;
      } catch (error) {
        patchPrivateProps.partnerReferralNotificationEmailStatus = "failed";
        patchPrivateProps.partnerReferralNotificationEmailError = cleanText(
          error?.message || "Unknown partner notification email error",
          300
        );
      }
    }
  }

  let paymentConfirmationStatus = paymentConfirmationAlreadySentAt ? "already_sent" : "pending";
  let tourDetailsStatus = tourDetailsAlreadySentAt ? "already_sent" : "pending";
  let adminNotificationStatus = adminNotificationAlreadySentAt ? "already_sent" : "pending";

  if (!model.customerEmail) {
    paymentConfirmationStatus = "missing_recipient";
    tourDetailsStatus = "missing_recipient";
  } else if (!paymentConfirmationAlreadySentAt) {
    try {
      const confirmationResult = await sendBookingEmail(
        env,
        buildSendPayload(model, buildPaymentConfirmationPayload(model))
      );
      paymentConfirmationStatus = "sent";
      patchPrivateProps.paymentConfirmationEmailStatus = "sent";
      patchPrivateProps.paymentConfirmationEmailSentAt = new Date().toISOString();
      patchPrivateProps.paymentConfirmationEmailError = "";
      patchPrivateProps.paymentConfirmationEmailMessageId = cleanText(confirmationResult?.messageId, 200);
      patchPrivateProps.bookingConfirmationEmailMessageId = cleanText(confirmationResult?.messageId, 200);
    } catch (error) {
      const errorMessage = cleanText(error?.message || "Unknown email error", 300);
      patchPrivateProps.paymentConfirmationEmailStatus = "failed";
      patchPrivateProps.paymentConfirmationEmailError = errorMessage;
      patchPrivateProps.bookingConfirmationEmailStatus = "failed";
      patchPrivateProps.bookingConfirmationEmailError = errorMessage;
      return buildEmailPatchResult("failed", patchPrivateProps, true);
    }
  }

  if (model.customerEmail && !tourDetailsAlreadySentAt) {
    try {
      const tourDetailsResult = await sendBookingEmail(
        env,
        buildSendPayload(model, buildTourDetailsPayload(model))
      );
      tourDetailsStatus = "sent";
      patchPrivateProps.tourDetailsEmailStatus = "sent";
      patchPrivateProps.tourDetailsEmailSentAt = new Date().toISOString();
      patchPrivateProps.tourDetailsEmailError = "";
      patchPrivateProps.tourDetailsEmailMessageId = cleanText(tourDetailsResult?.messageId, 200);
    } catch (error) {
      const errorMessage = cleanText(error?.message || "Unknown email error", 300);
      tourDetailsStatus = "failed";
      patchPrivateProps.tourDetailsEmailStatus = "failed";
      patchPrivateProps.tourDetailsEmailError = errorMessage;
    }
  }

  if (model.bookingNotificationEmail && !adminNotificationAlreadySentAt) {
    try {
      const adminResult = await sendBookingEmail(
        env,
        buildSendPayload(model, buildAdminNotificationPayload(model), {
          to: model.bookingNotificationEmail
        })
      );
      adminNotificationStatus = "sent";
      patchPrivateProps.adminBookingNotificationEmailStatus = "sent";
      patchPrivateProps.adminBookingNotificationEmailSentAt = new Date().toISOString();
      patchPrivateProps.adminBookingNotificationEmailError = "";
      patchPrivateProps.adminBookingNotificationEmailMessageId = cleanText(adminResult?.messageId, 200);
    } catch (error) {
      adminNotificationStatus = "failed";
      patchPrivateProps.adminBookingNotificationEmailStatus = "failed";
      patchPrivateProps.adminBookingNotificationEmailError = cleanText(
        error?.message || "Unknown email error",
        300
      );
    }
  }

  const paymentConfirmationReady =
    paymentConfirmationStatus === "sent" || paymentConfirmationStatus === "already_sent";
  const tourDetailsReady = tourDetailsStatus === "sent" || tourDetailsStatus === "already_sent";
  const overallStatus = paymentConfirmationReady && tourDetailsReady
    ? "sent"
    : paymentConfirmationReady
      ? "partial"
      : "failed";

  patchPrivateProps.bookingConfirmationEmailStatus = overallStatus;
  patchPrivateProps.bookingConfirmationEmailError = !model.customerEmail
    ? "Customer email is missing from this booking."
    : (tourDetailsStatus === "failed"
      ? cleanText(patchPrivateProps.tourDetailsEmailError || "Could not send tour details email.", 300)
      : "");

  if (overallStatus === "sent") {
    patchPrivateProps.bookingConfirmationEmailSentAt =
      cleanText(privateProps.bookingConfirmationEmailSentAt, 80) || new Date().toISOString();
  }

  const shouldPatch = Object.keys(patchPrivateProps).length > 0;
  return buildEmailPatchResult(overallStatus, shouldPatch ? patchPrivateProps : null, shouldPatch);
}

export async function maybeSendAdminBookingNotificationEmail(env, event, paymentData = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  const adminNotificationAlreadySentAt = cleanText(
    privateProps.adminBookingNotificationEmailSentAt,
    80
  );
  const model = buildBookingEmailModel(env, event, paymentData);
  const patchPrivateProps = {};

  if (!model.bookingNotificationEmail) {
    return buildEmailPatchResult("missing_recipient", null, false);
  }

  if (adminNotificationAlreadySentAt) {
    return buildEmailPatchResult("already_sent", null, false);
  }

  try {
    const adminResult = await sendBookingEmail(
      env,
      buildSendPayload(model, buildAdminNotificationPayload(model), {
        to: model.bookingNotificationEmail
      })
    );

    patchPrivateProps.adminBookingNotificationEmailStatus = "sent";
    patchPrivateProps.adminBookingNotificationEmailSentAt = new Date().toISOString();
    patchPrivateProps.adminBookingNotificationEmailError = "";
    patchPrivateProps.adminBookingNotificationEmailMessageId = cleanText(adminResult?.messageId, 200);

    return buildEmailPatchResult("sent", patchPrivateProps, true);
  } catch (error) {
    patchPrivateProps.adminBookingNotificationEmailStatus = "failed";
    patchPrivateProps.adminBookingNotificationEmailError = cleanText(
      error?.message || "Unknown email error",
      300
    );

    return buildEmailPatchResult("failed", patchPrivateProps, true);
  }
}

async function sendBookingEmail(env, sendPayload) {
  if (hasGmailCredentials(env)) {
    return sendBookingEmailWithGmail(env, sendPayload);
  }

  if (env.BOOKING_EMAIL && typeof env.BOOKING_EMAIL.send === "function") {
    return env.BOOKING_EMAIL.send(sendPayload);
  }

  const accountId = cleanText(
    env.CLOUDFLARE_EMAIL_ACCOUNT_ID ||
    env.CLOUDFLARE_ACCOUNT_ID ||
    env.CF_ACCOUNT_ID,
    80
  );
  const apiToken = cleanText(env.CLOUDFLARE_EMAIL_API_TOKEN, 400);

  if (!accountId || !apiToken) {
    throw new Error("Missing Gmail API credentials or fallback email credentials.");
  }

  const restPayload = {
    to: sendPayload.to,
    from:
      typeof sendPayload.from === "string"
        ? sendPayload.from
        : {
            address: sendPayload.from?.email || sendPayload.from?.address || "",
            name: sendPayload.from?.name || ""
          },
    subject: sendPayload.subject,
    html: sendPayload.html,
    text: sendPayload.text
  };

  if (sendPayload.replyTo) {
    restPayload.reply_to =
      typeof sendPayload.replyTo === "string"
        ? sendPayload.replyTo
        : {
            address: sendPayload.replyTo?.email || sendPayload.replyTo?.address || "",
            name: sendPayload.replyTo?.name || ""
          };
  }

  if (sendPayload.bcc) {
    restPayload.bcc = sendPayload.bcc;
  }

  const response = await fetch(
    `${CLOUDFLARE_EMAIL_API_BASE}/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(restPayload)
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.success) {
    const errorMessage =
      data?.errors?.[0]?.message ||
      data?.messages?.[0]?.message ||
      "Cloudflare Email API request failed.";
    throw new Error(errorMessage);
  }

  return {
    messageId: cleanText(data?.result?.queued?.[0] || data?.result?.delivered?.[0] || "", 200)
  };
}

export async function sendSystemEmail(env, sendPayload) {
  return sendBookingEmail(env, sendPayload);
}

async function sendBookingEmailWithGmail(env, sendPayload) {
  const { accessToken, fromEmail } = await getGmailAccessToken(env);
  const gmailPayload = {
    ...sendPayload,
    from: {
      email: fromEmail,
      name: sendPayload.from?.name || "Boat4Two Reservations"
    }
  };
  const rawMessage = utf8ToBase64Url(buildMimeMessage(gmailPayload));
  const response = await fetch(GMAIL_API_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      raw: rawMessage
    })
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.id) {
    const gmailError = cleanText(
      data?.error?.message || data?.error_description || "Gmail API request failed.",
      260
    );
    throw new Error(gmailError);
  }

  return {
    messageId: cleanText(data.id, 200)
  };
}

// Pure builders are exported so referral visibility boundaries can be regression-tested.
export {
  buildAdminNotificationPayload,
  buildBookingEmailModel,
  buildPartnerReferralNotificationPayload,
  buildPaymentConfirmationPayload,
  buildTourDetailsPayload,
  calculatePartnerCommission
};
