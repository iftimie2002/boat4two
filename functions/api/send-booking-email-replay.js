import { maybeSendBookingConfirmationEmail } from "./_booking-email.js";

const REPLAY_KEY = "b4t_mark_email_replay_20260515_6f8d4b2e";
const ALLOWED_RECIPIENTS = new Set([
  "iftimie2002@gmail.com",
  "mcguires4@virginmedia.com"
]);
const TEST_TIMEZONE = "Europe/Lisbon";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function cleanText(value, max = 320) {
  return String(value || "").trim().slice(0, max);
}

function buildMarkBookingEvent(recipientEmail) {
  return {
    id: "replay-mark-mcguire-booking-20260624",
    summary: "PAID - Amor Tour - Mark McGuire",
    start: {
      dateTime: "2026-06-24T10:00:00+01:00",
      timeZone: TEST_TIMEZONE
    },
    end: {
      dateTime: "2026-06-24T13:30:00+01:00",
      timeZone: TEST_TIMEZONE
    },
    extendedProperties: {
      private: {
        bookingType: "paid",
        paymentStatus: "paid",
        tour: "amor",
        tourLabel: "Private Sailing Tour for Couples",
        date: "2026-06-24",
        time: "10:00",
        customerName: "Mark McGuire",
        customerEmail: recipientEmail,
        customerPhone: "07377089361",
        customerCountry: "United Kingdom",
        customerMessage:
          "We got your details from your Dad at Touriga in Carvoeiro just looking forward to a sail along the coast hope ok thanks",
        paymentAmount: "170.00",
        paymentCurrency: "EUR",
        paymentReference: "MTCOR05263RR8XOO",
        paymentTransactionRef: "38979684",
        paymentOrderId: "B4T-53799657-d02a-41a8-a3ef-1356754f3ec2",
        holdId: "53799657-d02a-41a8-a3ef-1356754f3ec2",
        adminBookingNotificationEmailSentAt: "2026-05-15T15:47:10.000Z"
      }
    }
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.searchParams.get("key") !== REPLAY_KEY) {
    return json({
      ok: false,
      error: "Unauthorized."
    }, 403);
  }

  const recipientEmail = cleanText(url.searchParams.get("to"), 200).toLowerCase();

  if (!ALLOWED_RECIPIENTS.has(recipientEmail)) {
    return json({
      ok: false,
      error: "Recipient not allowed."
    }, 400);
  }

  const event = buildMarkBookingEvent(recipientEmail);
  const paymentData = {
    amount: "170.00",
    currency: "EUR",
    paymentReference: "MTCOR05263RR8XOO",
    paymentTransactionRef: "38979684"
  };

  try {
    const result = await maybeSendBookingConfirmationEmail(env, event, paymentData);
    return json({
      ok: true,
      recipientEmail,
      bookingName: "Mark McGuire",
      result
    });
  } catch (error) {
    return json({
      ok: false,
      recipientEmail,
      bookingName: "Mark McGuire",
      error: error?.message || "Could not replay booking confirmation emails."
    }, 500);
  }
}
