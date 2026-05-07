import {
  getBookingEmailDiagnostics,
  testBookingEmailConnection
} from "./_booking-email.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  const diagnostics = getBookingEmailDiagnostics(env);

  try {
    const connection = await testBookingEmailConnection(env);

    return json({
      ok: true,
      ...diagnostics,
      connection
    });
  } catch (error) {
    return json({
      ok: false,
      ...diagnostics,
      error: error?.message || "Email connection test failed."
    }, 500);
  }
}
