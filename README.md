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

## Live Google reviews

`GET /api/google-reviews` reads reviews from the official Google Business
Profile API, keeps only reviews containing text, and includes associated review
images when Google provides them. Responses are cached at the edge for six
hours. The browser first renders `reviews-feed.json`, so missing credentials or
a temporary Google failure never leaves the reviews section empty.

Configure these Cloudflare Pages secrets/variables in Production and Preview:

- `GOOGLE_BUSINESS_REFRESH_TOKEN`: a separate OAuth refresh token authorized
  with `https://www.googleapis.com/auth/business.manage`.
  Until it is configured, the integration safely tries the existing
  `GOOGLE_REFRESH_TOKEN`; this works only if that token already includes the
  Business Profile scope.
- `GOOGLE_BUSINESS_LOCATION` is optional. When omitted, the integration looks
  for the location titled `Boat4Two`; set the variable explicitly in the format
  `accounts/{accountId}/locations/{locationId}` only if the account contains
  ambiguous locations.
- `GOOGLE_BUSINESS_CLIENT_ID` and `GOOGLE_BUSINESS_CLIENT_SECRET` are optional
  when the existing `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` belong to the
  OAuth client used to issue the Business Profile refresh token.
- `GOOGLE_BUSINESS_SHARE_URL` is optional and defaults to Boat4Two's configured
  Google profile share link.

The Google Business Profile integration is read-only. It is deliberately
separate from the Google Calendar credentials and booking flow.
