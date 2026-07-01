import "server-only";

/**
 * A short random ID generated once per Node.js process lifetime.
 *
 * On Vercel Serverless Functions, a cold start creates a new process and
 * therefore a new ID. If two sequential requests show different IDs,
 * in-process caching is ineffective (each request hits a fresh instance).
 *
 * On a long-lived server (local dev, container) the ID stays constant.
 */
export const CACHE_INSTANCE_ID: string = Math.random().toString(36).slice(2, 8).toUpperCase();
