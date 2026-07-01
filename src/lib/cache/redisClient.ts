import "server-only";
import { Redis } from "@upstash/redis";

/**
 * Shared Upstash Redis client.
 *
 * Returns null when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are
 * not set, so all callers can fall back to in-process Map caching gracefully.
 *
 * Set these in Vercel → Settings → Environment Variables (or .env.local for dev):
 *   UPSTASH_REDIS_REST_URL=https://...upstash.io
 *   UPSTASH_REDIS_REST_TOKEN=...
 */

let _redis: Redis | null = null;
let _initialized = false;

export function getRedisClient(): Redis | null {
  if (_initialized) return _redis;
  _initialized = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // Redis not configured — callers will use in-process fallback
    _redis = null;
    return null;
  }

  try {
    _redis = new Redis({ url, token });
  } catch {
    _redis = null;
  }
  return _redis;
}

export function isRedisEnabled(): boolean {
  return getRedisClient() !== null;
}
