const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_BUSINESS_REVIEWS_BASE_URL = "https://mybusiness.googleapis.com/v4";
const GOOGLE_BUSINESS_ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const GOOGLE_BUSINESS_INFORMATION_BASE_URL = "https://mybusinessbusinessinformation.googleapis.com/v1";
const GOOGLE_REVIEWS_PAGE_SIZE = 50;
const MAX_GOOGLE_REVIEW_PAGES = 10;

function cleanText(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeHttpsUrl(value) {
  const candidate = cleanText(value, 3000);

  if (!candidate) return "";

  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizeLocationParent(value) {
  const parent = cleanText(value, 240).replace(/^\/+|\/+$/g, "");
  return /^accounts\/[^/]+\/locations\/[^/]+$/.test(parent) ? parent : "";
}

function normalizeStarRating(value) {
  const numeric = Number(value);

  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 5) {
    return numeric;
  }

  const ratings = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5
  };

  return ratings[cleanText(value, 20).toUpperCase()] || null;
}

function normalizeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function normalizeGoogleBusinessReview(review, providerUrl = "") {
  const quote = cleanText(review?.comment, 12000);
  const author = cleanText(review?.reviewer?.displayName, 240) || "Google user";

  if (!quote) return null;

  const images = Array.isArray(review?.reviewMediaItems)
    ? review.reviewMediaItems
        .map((media) => ({
          url: normalizeHttpsUrl(media?.thumbnailUrl),
          alt: cleanText(media?.thumbnailLabel, 300) || `Photo shared by ${author}`,
          videoUrl: normalizeHttpsUrl(media?.videoUrl)
        }))
        .filter((media) => media.url)
        .slice(0, 4)
    : [];

  return {
    id: cleanText(review?.reviewId || review?.name, 500),
    author,
    authorPhotoUrl: normalizeHttpsUrl(review?.reviewer?.profilePhotoUrl),
    authorProfileUrl: "",
    location: "",
    date: normalizeDate(review?.createTime || review?.updateTime),
    rating: normalizeStarRating(review?.starRating),
    quote,
    images,
    sourceUrl: normalizeHttpsUrl(providerUrl)
  };
}

export function getGoogleBusinessReviewsConfig(env = {}) {
  const clientId = cleanText(env.GOOGLE_BUSINESS_CLIENT_ID || env.GOOGLE_CLIENT_ID, 500);
  const clientSecret = cleanText(env.GOOGLE_BUSINESS_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET, 1000);
  const refreshToken = cleanText(env.GOOGLE_BUSINESS_REFRESH_TOKEN, 3000);
  const locationParent = normalizeLocationParent(env.GOOGLE_BUSINESS_LOCATION);
  const shareUrl = normalizeHttpsUrl(
    env.GOOGLE_BUSINESS_SHARE_URL || "https://share.google/3qhqDb2NgTLbERTUA"
  );
  const locationTitle = cleanText(env.GOOGLE_BUSINESS_LOCATION_TITLE || "Boat4Two", 240);

  return {
    clientId,
    clientSecret,
    refreshToken,
    locationParent,
    locationTitle,
    shareUrl,
    configured: Boolean(clientId && clientSecret && refreshToken)
  };
}

async function getAccessToken(config, fetchImpl) {
  const response = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token"
    })
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.access_token) {
    throw new Error("Google Business Profile authentication failed.");
  }

  return payload.access_token;
}

async function discoverLocationParent(config, accessToken, fetchImpl) {
  const accountsResponse = await fetchImpl(GOOGLE_BUSINESS_ACCOUNTS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
  const accountsPayload = await accountsResponse.json().catch(() => null);

  if (!accountsResponse.ok || !accountsPayload) {
    throw new Error("Google Business Profile account discovery failed.");
  }

  const candidates = [];

  for (const account of Array.isArray(accountsPayload.accounts) ? accountsPayload.accounts : []) {
    const accountName = cleanText(account?.name, 240);
    if (!/^accounts\/[^/]+$/.test(accountName)) continue;

    const locationsUrl = new URL(`${GOOGLE_BUSINESS_INFORMATION_BASE_URL}/${accountName}/locations`);
    locationsUrl.searchParams.set("pageSize", "100");
    locationsUrl.searchParams.set("readMask", "name,title");

    const locationsResponse = await fetchImpl(locationsUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });
    const locationsPayload = await locationsResponse.json().catch(() => null);

    if (!locationsResponse.ok || !locationsPayload) continue;

    for (const location of Array.isArray(locationsPayload.locations) ? locationsPayload.locations : []) {
      const locationName = cleanText(location?.name, 240);
      const title = cleanText(location?.title, 240);

      if (!/^locations\/[^/]+$/.test(locationName)) continue;
      candidates.push({
        parent: `${accountName}/${locationName}`,
        title
      });
    }
  }

  const expectedTitle = config.locationTitle.toLocaleLowerCase("en");
  const exactMatch = candidates.find((candidate) => (
    candidate.title.toLocaleLowerCase("en") === expectedTitle
  ));

  if (exactMatch) return exactMatch.parent;
  if (candidates.length === 1) return candidates[0].parent;

  throw new Error("Boat4Two could not be uniquely identified in Google Business Profile.");
}

export async function fetchGoogleBusinessReviews(env, options = {}) {
  const config = getGoogleBusinessReviewsConfig(env);
  const fetchImpl = options.fetchImpl || fetch;

  if (!config.configured) {
    const error = new Error("Google Business Profile reviews are not configured.");
    error.code = "google_business_reviews_not_configured";
    throw error;
  }

  const accessToken = await getAccessToken(config, fetchImpl);
  const locationParent = config.locationParent || await discoverLocationParent(
    config,
    accessToken,
    fetchImpl
  );
  const reviews = [];
  let averageRating = null;
  let totalReviewCount = 0;
  let pageToken = "";

  for (let page = 0; page < MAX_GOOGLE_REVIEW_PAGES; page += 1) {
    const url = new URL(
      `${GOOGLE_BUSINESS_REVIEWS_BASE_URL}/${locationParent}/reviews`
    );
    url.searchParams.set("pageSize", String(GOOGLE_REVIEWS_PAGE_SIZE));
    url.searchParams.set("orderBy", "updateTime desc");

    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      throw new Error(`Google Business Profile reviews request failed with HTTP ${response.status}.`);
    }

    if (Number.isFinite(Number(payload.averageRating))) {
      averageRating = Number(payload.averageRating);
    }

    if (Number.isFinite(Number(payload.totalReviewCount))) {
      totalReviewCount = Number(payload.totalReviewCount);
    }

    for (const review of Array.isArray(payload.reviews) ? payload.reviews : []) {
      const normalized = normalizeGoogleBusinessReview(review, config.shareUrl);
      if (normalized) reviews.push(normalized);
    }

    pageToken = cleanText(payload.nextPageToken, 1000);
    if (!pageToken) break;
  }

  reviews.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  return {
    enabled: true,
    public: true,
    name: "Google",
    url: config.shareUrl,
    rating: averageRating,
    reviewCount: totalReviewCount || reviews.length,
    reviews
  };
}
