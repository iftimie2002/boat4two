const BOOKING_TIMEZONE = "Europe/Lisbon";
const DEFAULT_FROM_EMAIL = "reservas@boat4two.com";
const DEFAULT_REPLY_TO_EMAIL = "reservas.boat4two@gmail.com";
const DEFAULT_SUPPORT_EMAIL = "reservas.boat4two@gmail.com";
const DEFAULT_SUPPORT_PHONE = "+351932015013";
const DEFAULT_SITE_URL = "https://boat4two.com";
const CLOUDFLARE_EMAIL_API_BASE = "https://api.cloudflare.com/client/v4";
const TOUR_LABELS = {
  amor: "Private Sailing Tour for Couples",
  sunset: "Sunset Private Sailing Tour for Couples",
  custom: "Custom Private Tour"
};

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

function buildBookingEmailModel(env, event, paymentData = {}) {
  const privateProps = event?.extendedProperties?.private || {};
  const customerName = cleanText(privateProps.customerName, 120);
  const customerEmail = cleanText(privateProps.customerEmail, 200);
  const rawTour = cleanText(privateProps.tour, 80).toLowerCase();
  const tourLabel = cleanText(
    privateProps.tourLabel || privateProps.tourName || privateProps.tourDisplayName,
    160
  ) || TOUR_LABELS[rawTour] || cleanText(privateProps.tour, 80);
  const dateLabel = formatDate(privateProps.date || event?.start?.dateTime || event?.start?.date);
  const timeLabel = formatTime(privateProps.time);
  const amountLabel = formatMoney(
    paymentData.amount || privateProps.paymentAmount,
    paymentData.currency || privateProps.paymentCurrency || "EUR"
  );
  const paymentReference = cleanText(
    paymentData.paymentReference || privateProps.paymentReference,
    120
  );
  const transactionReference = cleanText(
    paymentData.paymentTransactionRef || privateProps.paymentTransactionRef,
    120
  );

  return {
    customerName,
    customerEmail,
    tourLabel: tourLabel || "Boat4Two booking",
    dateLabel,
    timeLabel,
    amountLabel,
    paymentReference,
    transactionReference,
    siteUrl: cleanText(env.BOOKING_CONFIRMATION_SITE_URL, 200) || DEFAULT_SITE_URL,
    supportEmail: cleanText(env.BOOKING_CONFIRMATION_SUPPORT_EMAIL, 200) || DEFAULT_SUPPORT_EMAIL,
    supportPhone: cleanText(env.BOOKING_CONFIRMATION_SUPPORT_PHONE, 40) || DEFAULT_SUPPORT_PHONE,
    replyToEmail: cleanText(env.BOOKING_CONFIRMATION_REPLY_TO_EMAIL, 200) || DEFAULT_REPLY_TO_EMAIL,
    fromEmail: cleanText(env.BOOKING_CONFIRMATION_FROM_EMAIL, 200) || DEFAULT_FROM_EMAIL,
    bccEmail: cleanText(env.BOOKING_CONFIRMATION_BCC_EMAIL, 200)
  };
}

function buildEmailSubject(model) {
  return `Boat4Two booking confirmed - ${model.tourLabel}`;
}

function buildPlainText(model) {
  return [
    `Hello ${model.customerName || "there"},`,
    "",
    "Your Boat4Two booking has been confirmed.",
    "",
    `Tour: ${model.tourLabel}`,
    model.dateLabel ? `Date: ${model.dateLabel}` : "",
    model.timeLabel ? `Time: ${model.timeLabel}` : "",
    model.amountLabel ? `Paid: ${model.amountLabel}` : "",
    model.paymentReference ? `Payment reference: ${model.paymentReference}` : "",
    model.transactionReference ? `Transaction reference: ${model.transactionReference}` : "",
    "",
    "What happens next:",
    "- We will contact you with the final meeting details before your tour.",
    "- If you need to request a cancellation or refund, email us with your booking name, tour date, and payment reference.",
    "",
    `Support email: ${model.supportEmail}`,
    `Phone / WhatsApp: ${model.supportPhone}`,
    `Website: ${model.siteUrl}`,
    "",
    "Cancellation policy:",
    "Full refund for cancellations at least 48 hours before the activity.",
    "50% refund for cancellations between 24 and 48 hours before the activity.",
    "Less than 24 hours before the activity or no-show is non-refundable.",
    "",
    "Thank you,",
    "Boat4Two"
  ].filter(Boolean).join("\n");
}

function buildHtml(model) {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f8f6f6;color:#211611;font-family:Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border:1px solid #eadfd9;border-radius:24px;padding:32px;">
      <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#e65e19;">Boat4Two</p>
      <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#211611;">Your booking is confirmed</h1>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#4a3b34;">
        Hello ${escapeHtml(model.customerName || "there")}, your payment was received and your Boat4Two booking is now confirmed.
      </p>

      <div style="border:1px solid #f1d9cc;background:#fff7f3;border-radius:20px;padding:20px 22px;margin:0 0 24px;">
        <p style="margin:0 0 10px;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#e65e19;">Booking details</p>
        <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#211611;">${escapeHtml(model.tourLabel)}</p>
        ${model.dateLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Date:</strong> ${escapeHtml(model.dateLabel)}</p>` : ""}
        ${model.timeLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Time:</strong> ${escapeHtml(model.timeLabel)}</p>` : ""}
        ${model.amountLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Paid:</strong> ${escapeHtml(model.amountLabel)}</p>` : ""}
        ${model.paymentReference ? `<p style="margin:0 0 6px;font-size:14px;color:#4a3b34;"><strong>Payment reference:</strong> ${escapeHtml(model.paymentReference)}</p>` : ""}
        ${model.transactionReference ? `<p style="margin:0;font-size:14px;color:#4a3b34;"><strong>Transaction reference:</strong> ${escapeHtml(model.transactionReference)}</p>` : ""}
      </div>

      <div style="margin:0 0 24px;">
        <p style="margin:0 0 10px;font-size:16px;font-weight:700;color:#211611;">What happens next</p>
        <ul style="margin:0;padding-left:20px;color:#4a3b34;font-size:14px;line-height:1.7;">
          <li>We will contact you with the final meeting details before your tour.</li>
          <li>Need to request a cancellation or refund? Email us with your booking name, tour date, and payment reference.</li>
        </ul>
      </div>

      <div style="border-top:1px solid #eadfd9;padding-top:20px;color:#4a3b34;font-size:14px;line-height:1.7;">
        <p style="margin:0 0 8px;"><strong>Support email:</strong> <a href="mailto:${escapeHtml(model.supportEmail)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.supportEmail)}</a></p>
        <p style="margin:0 0 8px;"><strong>Phone / WhatsApp:</strong> <a href="tel:${escapeHtml(model.supportPhone)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.supportPhone)}</a></p>
        <p style="margin:0;"><strong>Website:</strong> <a href="${escapeHtml(model.siteUrl)}" style="color:#e65e19;text-decoration:none;">${escapeHtml(model.siteUrl)}</a></p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export async function maybeSendBookingConfirmationEmail(env, event, paymentData = {}) {
  const privateProps = event?.extendedProperties?.private || {};

  if (privateProps.bookingConfirmationEmailSentAt) {
    return { status: "already_sent", shouldPatch: false };
  }

  const model = buildBookingEmailModel(env, event, paymentData);

  if (!model.customerEmail) {
    return { status: "missing_recipient", shouldPatch: false };
  }

  const sendPayload = {
    to: model.customerEmail,
    from: {
      email: model.fromEmail,
      name: "Boat4Two Reservations"
    },
    replyTo: {
      email: model.replyToEmail,
      name: "Boat4Two Reservations"
    },
    subject: buildEmailSubject(model),
    html: buildHtml(model),
    text: buildPlainText(model)
  };

  if (model.bccEmail) {
    sendPayload.bcc = model.bccEmail;
  }

  try {
    const result = await sendBookingEmail(env, sendPayload);

    return {
      status: "sent",
      shouldPatch: true,
      patchPrivateProps: {
        bookingConfirmationEmailStatus: "sent",
        bookingConfirmationEmailSentAt: new Date().toISOString(),
        bookingConfirmationEmailError: "",
        bookingConfirmationEmailMessageId: cleanText(result?.messageId, 200)
      }
    };
  } catch (error) {
    return {
      status: "failed",
      shouldPatch: true,
      patchPrivateProps: {
        bookingConfirmationEmailStatus: "failed",
        bookingConfirmationEmailError: cleanText(error?.message || "Unknown email error", 300)
      }
    };
  }
}

async function sendBookingEmail(env, sendPayload) {
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
    throw new Error("Missing BOOKING_EMAIL binding or Cloudflare Email API credentials.");
  }

  const restPayload = {
    to: sendPayload.to,
    from: typeof sendPayload.from === "string"
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
    restPayload.reply_to = typeof sendPayload.replyTo === "string"
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
    const errorMessage = data?.errors?.[0]?.message || data?.messages?.[0]?.message || "Cloudflare Email API request failed.";
    throw new Error(errorMessage);
  }

  return {
    messageId: cleanText(data?.result?.queued?.[0] || data?.result?.delivered?.[0] || "", 200)
  };
}
