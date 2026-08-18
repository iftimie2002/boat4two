# boat4two
website in html for boat4two company

## Daily conversion logbook

Boat4Two records anonymous funnel events in the Cloudflare D1 database
`boat4two-analytics`. The Pages binding must be named `ANALYTICS_DB` in both
Production and Preview. Apply `migrations/0001_analytics.sql` when creating a
new database.

The report is emailed each day at 08:10 Europe/Lisbon by
`.github/workflows/daily-conversion-report.yml`. It uses the existing
`DAILY_SYSTEM_CHECK_KEY` GitHub/Cloudflare secret. The default recipient is
`info.boat4two@gmail.com`; set `DAILY_CONVERSION_REPORT_TO_EMAIL` to override it.

The report endpoint is `GET /api/daily-conversion-report` with
`Authorization: Bearer <DAILY_SYSTEM_CHECK_KEY>`. Calling it also sends the
email. Test bookings are excluded, anonymous raw events are retained for 90
days, and customer names, emails, phone numbers, messages, card details, IP
addresses, and raw user-agent strings are not stored.

Analytics is deliberately fail-open and separate from booking, availability,
Google Calendar, myPOS, and GetYourGuide behavior.
