import {
  fetchGoogleBusinessReviews,
  getGoogleBusinessReviewsConfig
} from "./_google-business-reviews.js";

const CACHE_SECONDS = 6 * 60 * 60;

function responseHeaders(cacheStatus) {
  return {
    "Cache-Control": `public, max-age=300, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
    "Content-Type": "application/json; charset=utf-8",
    "X-Boat4Two-Reviews-Cache": cacheStatus
  };
}

export async function onRequestGet(context) {
  const config = getGoogleBusinessReviewsConfig(context.env);

  if (!config.configured) {
    return Response.json(
      {
        ok: false,
        error: "Google reviews are not configured."
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  }

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/api/google-reviews", context.request.url), {
    method: "GET"
  });

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  try {
    const provider = await fetchGoogleBusinessReviews(context.env);
    const response = new Response(JSON.stringify({ ok: true, provider }), {
      status: 200,
      headers: responseHeaders("MISS")
    });

    if (cache) {
      context.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  } catch (error) {
    console.error("[reviews] Google Business Profile sync failed", {
      message: error?.message || "Unknown error"
    });

    return Response.json(
      {
        ok: false,
        error: "Google reviews are temporarily unavailable."
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  }
}
