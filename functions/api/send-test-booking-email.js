import { maybeSendBookingConfirmationEmail } from "./_booking-email.js";

const TEST_KEY = "b4t_email_test_20260515_c8f4e7e24b0c";
const TEST_EMAIL = "iftimie2002@gmail.com";
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

function buildTestEvent() {
  return {
    id: `manual-email-test-${Date.now()}`,
    summary: "PAID - Amor Tour - Email Test",
    start: {
      dateTime: "2026-05-20T10:00:00+01:00",
      timeZone: TEST_TIMEZONE
    },
    end: {
      dateTime: "2026-05-20T13:30:00+01:00",
      timeZone: TEST_TIMEZONE
    },
    extendedProperties: {
      private: {
        bookingType: "paid",
        paymentStatus: "paid",
        tour: "amor",
        tourLabel: "Private Sailing Tour for Couples",
        date: "2026-05-20",
        time: "10:00",
        customerName: "Boat4Two Email Test",
        customerEmail: TEST_EMAIL,
        customerPhone: "+351000000000",
        customerCountry: "Portugal",
        customerOccasion: "Email delivery test",
        customerMessage: "Triggered manually for booking confirmation test.",
        paymentAmount: "170.00",
        paymentCurrency: "EUR",
        paymentReference: "B4T-EMAIL-TEST-001",
        paymentTransactionRef: "B4T-TXN-EMAIL-TEST-001",
        paymentOrderId: "B4T-ORDER-EMAIL-TEST-001"
      }
    }
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.searchParams.get("key") !== TEST_KEY) {
    return json({
      ok: false,
      error: "Unauthorized."
    }, 403);
  }

  const event = buildTestEvent();
  const paymentData = {
    amount: "170.00",
    currency: "EUR",
    paymentReference: "B4T-EMAIL-TEST-001",
    paymentTransactionRef: "B4T-TXN-EMAIL-TEST-001"
  };

  try {
    const result = await maybeSendBookingConfirmationEmail(env, event, paymentData);
    return json({
      ok: true,
      testEmail: TEST_EMAIL,
      result
    });
  } catch (error) {
    return json({
      ok: false,
      testEmail: TEST_EMAIL,
      error: error?.message || "Could not send test booking emails."
    }, 500);
  }
}
