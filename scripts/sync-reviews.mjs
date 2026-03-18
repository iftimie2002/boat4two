#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const sourcesPath = path.join(projectDir, 'review-sources.json');
const outputPath = path.join(projectDir, 'reviews-feed.json');

if (typeof fetch !== 'function') {
  throw new Error('Node 18+ is required to run the review sync.');
}

function toArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function dedupeReviews(reviews) {
  const seen = new Set();
  return reviews.filter(function(review) {
    const key = [
      review.author || '',
      review.date || '',
      review.quote || ''
    ].join('|').toLowerCase();
    if (!key.trim() || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().slice(0, 10);
}

function normalizeReview(review, fallbackTour, sourceUrl) {
  if (!review || typeof review !== 'object') {
    return null;
  }
  const author = typeof review.author === 'string'
    ? review.author
    : review.author && typeof review.author.name === 'string'
      ? review.author.name
      : '';
  const quote = review.reviewBody || review.description || review.text || '';
  if (!author || !quote) {
    return null;
  }
  const location = review.author && review.author.address && typeof review.author.address.addressCountry === 'string'
    ? review.author.address.addressCountry
    : review.authorLocation || review.location || '';
  const ratingValue = Number(
    review.reviewRating && review.reviewRating.ratingValue !== undefined
      ? review.reviewRating.ratingValue
      : review.ratingValue
  );
  return {
    author: author.trim(),
    location: String(location || '').trim(),
    date: normalizeDate(review.datePublished || review.publishedAt || review.dateCreated || ''),
    rating: Number.isFinite(ratingValue) ? ratingValue : null,
    quote: String(quote).trim(),
    tour: fallbackTour || '',
    sourceUrl: sourceUrl || ''
  };
}

function normalizeAggregateRating(rating) {
  if (!rating || typeof rating !== 'object') {
    return null;
  }
  const ratingValue = Number(rating.ratingValue);
  const reviewCount = Number(rating.reviewCount || rating.ratingCount);
  if (!Number.isFinite(ratingValue)) {
    return null;
  }
  return {
    ratingValue: ratingValue,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : 0
  };
}

function parseJsonBlock(block) {
  const normalized = block.trim().replace(/^<!--|-->$/g, '');
  if (!normalized) {
    return [];
  }
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    return [];
  }
}

function extractJsonLdObjects(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  return blocks.flatMap(function(match) {
    return parseJsonBlock(match[1]);
  });
}

function collectStructuredData(node, bucket) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach(function(item) {
      collectStructuredData(item, bucket);
    });
    return;
  }
  if (typeof node !== 'object') {
    return;
  }

  const typeList = toArray(node['@type']).map(function(value) {
    return String(value);
  });
  if (typeList.includes('Review')) {
    bucket.reviews.push(node);
  }
  if (node.aggregateRating && typeof node.aggregateRating === 'object') {
    bucket.aggregateRatings.push(node.aggregateRating);
  }
  if (typeof node.name === 'string') {
    bucket.names.push(node.name);
  }

  Object.values(node).forEach(function(value) {
    collectStructuredData(value, bucket);
  });
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Boat4TwoReviewSync/1.0 (+https://boat4two.com)'
    },
    redirect: 'follow'
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.text();
}

function buildProviderBase(providerId, providerConfig, existingProvider) {
  return {
    enabled: providerConfig.enabled !== false,
    public: Boolean(providerConfig.public),
    name: providerConfig.name || existingProvider.name || providerId,
    url: providerConfig.url || providerConfig.shareUrl || existingProvider.url || '',
    rating: existingProvider.rating ?? null,
    reviewCount: existingProvider.reviewCount || 0,
    reviews: Array.isArray(existingProvider.reviews) ? existingProvider.reviews : []
  };
}

async function syncJsonLdProvider(providerId, providerConfig, existingProvider) {
  const base = buildProviderBase(providerId, providerConfig, existingProvider);
  const products = Array.isArray(providerConfig.products) ? providerConfig.products : [];
  if (!products.length) {
    return base;
  }

  const mergedReviews = [];
  const ratingSamples = [];

  for (const product of products) {
    if (!product || !product.url) continue;
    const html = await fetchText(product.url);
    const jsonLdObjects = extractJsonLdObjects(html);
    const bucket = {
      reviews: [],
      aggregateRatings: [],
      names: []
    };
    jsonLdObjects.forEach(function(object) {
      collectStructuredData(object, bucket);
    });

    bucket.reviews.forEach(function(review) {
      const normalized = normalizeReview(review, product.label || bucket.names[0] || '', product.url);
      if (normalized) {
        mergedReviews.push(normalized);
      }
    });

    bucket.aggregateRatings.forEach(function(rating) {
      const normalized = normalizeAggregateRating(rating);
      if (normalized) {
        ratingSamples.push(normalized);
      }
    });
  }

  const reviews = dedupeReviews(mergedReviews).sort(function(a, b) {
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  if (!reviews.length && !ratingSamples.length) {
    return base;
  }

  const totalWeightedRatings = ratingSamples.reduce(function(sum, sample) {
    const weight = sample.reviewCount || 1;
    return sum + (sample.ratingValue * weight);
  }, 0);
  const totalReviewCount = ratingSamples.reduce(function(sum, sample) {
    return sum + (sample.reviewCount || 0);
  }, 0);
  const fallbackReviewCount = reviews.length;

  return {
    ...base,
    url: products[0].url,
    rating: ratingSamples.length ? Number((totalWeightedRatings / (totalReviewCount || ratingSamples.length)).toFixed(1)) : base.rating,
    reviewCount: totalReviewCount || fallbackReviewCount,
    reviews: reviews
  };
}

async function syncGooglePlacesProvider(providerId, providerConfig, existingProvider) {
  const base = buildProviderBase(providerId, providerConfig, existingProvider);
  const apiKey = process.env[providerConfig.apiKeyEnv || 'GOOGLE_MAPS_API_KEY'];
  if (!providerConfig.placeId || !apiKey) {
    return base;
  }

  const detailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  detailsUrl.searchParams.set('place_id', providerConfig.placeId);
  detailsUrl.searchParams.set('fields', 'name,rating,user_ratings_total,url,reviews');
  detailsUrl.searchParams.set('reviews_sort', 'newest');
  detailsUrl.searchParams.set('key', apiKey);

  const response = await fetch(detailsUrl, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Google Places request failed: ${response.status}`);
  }
  const payload = await response.json();
  const result = payload.result || {};
  const reviews = toArray(result.reviews).map(function(review) {
    return {
      author: review.author_name || '',
      location: '',
      date: review.time ? normalizeDate(new Date(review.time * 1000).toISOString()) : '',
      rating: Number.isFinite(review.rating) ? review.rating : null,
      quote: review.text || '',
      sourceUrl: result.url || providerConfig.shareUrl || ''
    };
  }).filter(function(review) {
    return review.author && review.quote;
  });

  return {
    ...base,
    url: result.url || providerConfig.shareUrl || base.url,
    rating: Number.isFinite(result.rating) ? result.rating : base.rating,
    reviewCount: Number.isFinite(result.user_ratings_total) ? result.user_ratings_total : reviews.length,
    reviews: reviews
  };
}

async function syncProvider(providerId, providerConfig, existingProvider) {
  const handlers = {
    json_ld_page: syncJsonLdProvider,
    google_places_api: syncGooglePlacesProvider
  };
  const handler = handlers[providerConfig.mode] || syncJsonLdProvider;
  try {
    const synced = await handler(providerId, providerConfig, existingProvider);
    return {
      ...synced,
      name: providerConfig.name || synced.name,
      enabled: providerConfig.enabled !== false,
      public: Boolean(providerConfig.public)
    };
  } catch (error) {
    console.error(`[reviews] ${providerId} sync failed: ${error.message}`);
    return buildProviderBase(providerId, providerConfig, existingProvider);
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

async function main() {
  const sources = await readJson(sourcesPath, { providers: {} });
  const existingFeed = await readJson(outputPath, { updatedAt: '', providers: {} });
  const providerEntries = Object.entries(sources.providers || {});
  const nextProviders = {};

  for (const [providerId, providerConfig] of providerEntries) {
    nextProviders[providerId] = await syncProvider(
      providerId,
      providerConfig,
      existingFeed.providers && existingFeed.providers[providerId] ? existingFeed.providers[providerId] : {}
    );
  }

  const nextFeed = {
    updatedAt: new Date().toISOString(),
    providers: nextProviders
  };

  await fs.writeFile(outputPath, `${JSON.stringify(nextFeed, null, 2)}\n`);
  console.log(`Updated ${outputPath}`);
}

main().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
