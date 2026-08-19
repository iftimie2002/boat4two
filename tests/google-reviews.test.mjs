import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchGoogleBusinessReviews,
  getGoogleBusinessReviewsConfig,
  normalizeGoogleBusinessReview
} from "../functions/api/_google-business-reviews.js";

test("Google Business Profile config requires separate review access and can auto-discover location", () => {
  assert.equal(getGoogleBusinessReviewsConfig({}).configured, false);
  const autoDiscoveryConfig = getGoogleBusinessReviewsConfig({
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_BUSINESS_REFRESH_TOKEN: "refresh",
    GOOGLE_BUSINESS_LOCATION: "bad-location"
  });
  assert.equal(autoDiscoveryConfig.configured, true);
  assert.equal(autoDiscoveryConfig.locationParent, "");
  assert.equal(getGoogleBusinessReviewsConfig({
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_BUSINESS_REFRESH_TOKEN: "refresh",
    GOOGLE_BUSINESS_LOCATION: "accounts/123/locations/456"
  }).configured, true);
  assert.equal(getGoogleBusinessReviewsConfig({
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "existing-google-refresh"
  }).configured, true);
});

test("Google reviews keep text and associated images while dropping rating-only reviews", () => {
  assert.equal(normalizeGoogleBusinessReview({
    reviewer: { displayName: "No comment" },
    starRating: "FIVE"
  }), null);

  assert.deepEqual(normalizeGoogleBusinessReview({
    reviewId: "review-1",
    reviewer: {
      displayName: "Ana",
      profilePhotoUrl: "https://lh3.googleusercontent.com/avatar"
    },
    starRating: "FIVE",
    comment: "A wonderful private tour!",
    createTime: "2026-08-18T12:00:00Z",
    reviewMediaItems: [
      {
        thumbnailUrl: "https://lh3.googleusercontent.com/review-photo",
        thumbnailLabel: "Sunset on the boat"
      },
      {
        thumbnailUrl: "javascript:alert(1)"
      }
    ]
  }, "https://share.google/3qhqDb2NgTLbERTUA"), {
    id: "review-1",
    author: "Ana",
    authorPhotoUrl: "https://lh3.googleusercontent.com/avatar",
    authorProfileUrl: "",
    location: "",
    date: "2026-08-18",
    rating: 5,
    quote: "A wonderful private tour!",
    images: [
      {
        url: "https://lh3.googleusercontent.com/review-photo",
        alt: "Sunset on the boat",
        videoUrl: ""
      }
    ],
    sourceUrl: "https://share.google/3qhqDb2NgTLbERTUA"
  });
});

test("Google review sync paginates and exposes only normalized text reviews", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-token" });
    }

    const requestUrl = new URL(url);
    const secondPage = requestUrl.searchParams.get("pageToken") === "next";

    return Response.json(secondPage ? {
      averageRating: 4.9,
      totalReviewCount: 3,
      reviews: [
        {
          reviewId: "2",
          reviewer: { displayName: "Second" },
          starRating: "FOUR",
          comment: "Second written review",
          createTime: "2026-08-17T10:00:00Z"
        }
      ]
    } : {
      averageRating: 4.9,
      totalReviewCount: 3,
      nextPageToken: "next",
      reviews: [
        {
          reviewId: "1",
          reviewer: { displayName: "First" },
          starRating: "FIVE",
          comment: "Newest written review",
          createTime: "2026-08-18T10:00:00Z"
        },
        {
          reviewId: "rating-only",
          reviewer: { displayName: "Hidden" },
          starRating: "FIVE"
        }
      ]
    });
  };

  const provider = await fetchGoogleBusinessReviews({
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_BUSINESS_REFRESH_TOKEN: "refresh",
    GOOGLE_BUSINESS_LOCATION: "accounts/123/locations/456"
  }, { fetchImpl });

  assert.equal(calls.length, 3);
  assert.equal(provider.rating, 4.9);
  assert.equal(provider.reviewCount, 3);
  assert.deepEqual(provider.reviews.map((review) => review.id), ["1", "2"]);
  assert.match(calls[1].options.headers.Authorization, /^Bearer /);
});

test("Google review sync discovers the Boat4Two location when no resource ID is configured", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);

    if (requestUrl === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-token" });
    }

    if (requestUrl === "https://mybusinessaccountmanagement.googleapis.com/v1/accounts") {
      return Response.json({ accounts: [{ name: "accounts/123" }] });
    }

    if (requestUrl.startsWith("https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations")) {
      return Response.json({
        locations: [
          { name: "locations/456", title: "Boat4Two" },
          { name: "locations/789", title: "Another business" }
        ]
      });
    }

    return Response.json({
      averageRating: 5,
      totalReviewCount: 1,
      reviews: [
        {
          reviewId: "review-1",
          reviewer: { displayName: "Guest" },
          starRating: "FIVE",
          comment: "Perfect!",
          createTime: "2026-08-19T10:00:00Z"
        }
      ]
    });
  };

  const provider = await fetchGoogleBusinessReviews({
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_BUSINESS_REFRESH_TOKEN: "refresh"
  }, { fetchImpl });

  assert.equal(provider.reviews.length, 1);
  assert.ok(calls.some((url) => url.includes("accounts/123/locations/456/reviews")));
});
