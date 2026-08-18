import {
  applyAnalyticsRetention,
  buildDailyConversionReport,
  formatReportMoney
} from "./_analytics-report.js";
import {
  getBookingEmailDiagnostics,
  sendSystemEmail
} from "./_booking-email.js";

const DEFAULT_REPORT_TO_EMAIL = "info.boat4two@gmail.com";

function cleanText(value, max = 400) {
  return String(value || "").trim().slice(0, max);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function secretsMatch(supplied, expected) {
  const left = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(supplied || "")));
  const right = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(expected || "")));
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;

  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }

  return difference === 0 && Boolean(supplied) && Boolean(expected);
}

async function isAuthorized(request, env) {
  const expected = cleanText(env.DAILY_SYSTEM_CHECK_KEY, 400);
  const authorization = cleanText(request.headers.get("authorization"), 600);
  const supplied = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : cleanText(new URL(request.url).searchParams.get("key"), 600);
  return secretsMatch(supplied, expected);
}

function reportText(report) {
  const totals = report.totals;
  const lines = [
    `Boat4Two daily conversion logbook — ${report.date}`,
    "Test bookings and personal customer details are excluded.",
    "",
    `Visitors: ${totals.sessions}`,
    `Page views: ${totals.pageViews}`,
    `Opened booking: ${totals.bookingOpened}`,
    `Viewed availability: ${totals.availabilityViewed}`,
    `Created hold: ${totals.holds}`,
    `Started checkout: ${totals.checkouts}`,
    `Clicked payment: ${totals.paymentSubmitted}`,
    `Paid bookings: ${totals.paidBookings}`,
    `Revenue: ${formatReportMoney(totals.revenueCents)}`,
    `Visitor → paid: ${totals.visitorToPaidRate}%`,
    `Checkout → paid: ${totals.checkoutToPaidRate}%`,
    "",
    `Almost conversions (review, no checkout): ${totals.reviewDropoffs}`,
    `Declined payments: ${totals.declinedPayments}`,
    `Cancelled payments: ${totals.cancelledPayments}`,
    `Pending > 2 hours: ${totals.unresolvedPendingPayments} (${formatReportMoney(totals.unresolvedPendingAmountCents)})`,
    "",
    "Traffic sources:"
  ];

  for (const source of report.sources) {
    lines.push(
      `- ${source.sourceType} / ${source.sourceName}: ${source.sessions} visitors, ${source.paid} paid, ${source.conversionRate}% conversion, ${formatReportMoney(source.revenueCents)}`
    );
  }

  return lines.join("\n");
}

function metric(label, value, tone = "#211611") {
  return `<td style="padding:14px;border:1px solid #eadfd9;text-align:center;"><div style="font-size:24px;font-weight:800;color:${tone};">${escapeHtml(value)}</div><div style="margin-top:5px;font-size:12px;color:#6b5a52;">${escapeHtml(label)}</div></td>`;
}

function reportHtml(report) {
  const totals = report.totals;
  const sourceRows = report.sources.length
    ? report.sources.map((source) => `<tr>
        <td style="padding:9px;border:1px solid #eadfd9;">${escapeHtml(source.sourceType)}</td>
        <td style="padding:9px;border:1px solid #eadfd9;">${escapeHtml(source.sourceName)}</td>
        <td style="padding:9px;border:1px solid #eadfd9;text-align:right;">${source.sessions}</td>
        <td style="padding:9px;border:1px solid #eadfd9;text-align:right;">${source.paid}</td>
        <td style="padding:9px;border:1px solid #eadfd9;text-align:right;">${source.conversionRate}%</td>
        <td style="padding:9px;border:1px solid #eadfd9;text-align:right;">${escapeHtml(formatReportMoney(source.revenueCents))}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" style="padding:12px;border:1px solid #eadfd9;color:#6b5a52;">No visitor activity recorded.</td></tr>`;

  return `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f8f6f6;color:#211611;font-family:Arial,sans-serif;">
  <div style="max-width:900px;margin:0 auto;background:#fff;border:1px solid #eadfd9;border-radius:20px;padding:24px;">
    <p style="margin:0 0 8px;color:#e65e19;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;">Boat4Two</p>
    <h1 style="margin:0 0 8px;font-size:28px;">Daily conversion logbook</h1>
    <p style="margin:0 0 20px;color:#6b5a52;">${escapeHtml(report.date)} · Europe/Lisbon · test bookings and customer personal details excluded</p>
    <table style="width:100%;border-collapse:collapse;"><tr>
      ${metric("Visitors", totals.sessions)}
      ${metric("Checkout started", totals.checkouts)}
      ${metric("Paid bookings", totals.paidBookings, "#1f6f43")}
      ${metric("Revenue", formatReportMoney(totals.revenueCents), "#1f6f43")}
    </tr></table>
    <h2 style="margin:24px 0 10px;font-size:20px;">Funnel</h2>
    <p style="line-height:1.7;color:#4a3b34;">Opened booking <b>${totals.bookingOpened}</b> → viewed availability <b>${totals.availabilityViewed}</b> → holds <b>${totals.holds}</b> → checkout <b>${totals.checkouts}</b> → clicked payment <b>${totals.paymentSubmitted}</b> → paid <b>${totals.paidBookings}</b>.</p>
    <p style="line-height:1.7;color:#4a3b34;">Visitor → paid: <b>${totals.visitorToPaidRate}%</b>. Checkout → paid: <b>${totals.checkoutToPaidRate}%</b>.</p>
    <h2 style="margin:24px 0 10px;font-size:20px;">Almost conversions</h2>
    <p style="line-height:1.7;color:#4a3b34;">Review reached but checkout not started: <b>${totals.reviewDropoffs}</b>. Declined: <b>${totals.declinedPayments}</b>. Cancelled: <b>${totals.cancelledPayments}</b>. Pending longer than 2 hours: <b>${totals.unresolvedPendingPayments}</b>, worth <b>${escapeHtml(formatReportMoney(totals.unresolvedPendingAmountCents))}</b>.</p>
    <h2 style="margin:24px 0 10px;font-size:20px;">Where visitors came from</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr>
      <th style="padding:9px;border:1px solid #eadfd9;text-align:left;">Type</th><th style="padding:9px;border:1px solid #eadfd9;text-align:left;">Source</th><th style="padding:9px;border:1px solid #eadfd9;">Visitors</th><th style="padding:9px;border:1px solid #eadfd9;">Paid</th><th style="padding:9px;border:1px solid #eadfd9;">Rate</th><th style="padding:9px;border:1px solid #eadfd9;">Revenue</th>
    </tr></thead><tbody>${sourceRows}</tbody></table>
    <p style="margin:22px 0 0;color:#6b5a52;font-size:12px;line-height:1.6;">Raw anonymous events are retained for ${report.retentionDays} days. No card data, names, emails, phone numbers, messages, or IP addresses are stored.</p>
  </div>
</body></html>`;
}

async function sendReport(env, report) {
  const diagnostics = getBookingEmailDiagnostics(env);
  const to = cleanText(env.DAILY_CONVERSION_REPORT_TO_EMAIL, 200) || DEFAULT_REPORT_TO_EMAIL;
  return sendSystemEmail(env, {
    to,
    from: { email: diagnostics.fromEmail, name: "Boat4Two Analytics" },
    replyTo: { email: diagnostics.replyToEmail, name: "Boat4Two" },
    subject: `Boat4Two Daily Conversion Logbook - ${report.date}`,
    text: reportText(report),
    html: reportHtml(report)
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!await isAuthorized(request, env)) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  try {
    const report = await buildDailyConversionReport(env);
    if (!report.ok) return json(report, 503);

    const emailResult = await sendReport(env, report);
    const retention = await applyAnalyticsRetention(env).catch((error) => ({
      deleted: 0,
      error: cleanText(error?.message, 240)
    }));

    return json({
      ...report,
      emailDelivery: { ok: true, messageId: cleanText(emailResult?.messageId, 200) },
      retention
    });
  } catch (error) {
    return json({ ok: false, error: cleanText(error?.message || "Conversion report failed.", 320) }, 500);
  }
}

export const onRequestPost = onRequestGet;
