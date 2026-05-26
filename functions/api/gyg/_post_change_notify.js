import { notifyGyGAvailabilityForTourDate } from "./_notify_outbound.js";

export function queueGyGAvailabilityNotify(
  context,
  env,
  accessToken,
  { tour, date, reason = "GYG booking change" }
) {
  if (!tour || !date) {
    return;
  }

  const notifyPromise = notifyGyGAvailabilityForTourDate(env, {
    accessToken,
    tour,
    date
  }).catch((error) => {
    console.warn(`${reason}: availability notify failed`, error);
  });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(notifyPromise);
  }
}
