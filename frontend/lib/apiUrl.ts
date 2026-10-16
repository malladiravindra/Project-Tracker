// URL handling for the Django API, kept free of side effects so it can be unit-tested (tests/apiUrl.test.mjs).
// NEXT_PUBLIC_API_URL is the backend ORIGIN (https://django-ten-ruby.vercel.app); the "/api" prefix is added here.

export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigError";
  }
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const DEV_FALLBACK = "http://127.0.0.1:8000";

/** Validates NEXT_PUBLIC_API_URL and returns the API base including "/api", without a trailing slash. */
export function resolveApiBase(raw: string | undefined, production: boolean): string {
  const value = raw?.trim();
  if (!value) {
    // The localhost fallback exists for `next dev` only; a production bundle must never silently use it.
    if (!production) return `${DEV_FALLBACK}/api`;
    throw new ApiConfigError("Configuration error: NEXT_PUBLIC_API_URL is not set (e.g. https://django-ten-ruby.vercel.app).");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiConfigError(`Configuration error: NEXT_PUBLIC_API_URL is not a valid absolute URL (got "${value}").`);
  }
  // One origin only: a comma list or stray whitespace would otherwise be parsed as part of the URL path and
  // every request would go to a non-existent route (this shipped once as "https://api.example.org/,https://127.0.0.1:8000").
  if (/[,\s]/.test(value)) {
    throw new ApiConfigError("Configuration error: NEXT_PUBLIC_API_URL must be a single URL with no commas or spaces.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiConfigError("Configuration error: NEXT_PUBLIC_API_URL must start with https:// (or http://).");
  }
  if (production && (url.protocol === "http:" || LOCAL_HOSTS.includes(url.hostname))) {
    throw new ApiConfigError("Configuration error: NEXT_PUBLIC_API_URL must be an https:// URL that is not localhost in production.");
  }
  // Tolerate a value that already ends in /api so the prefix is never doubled.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}/api`;
}

/** Joins base + endpoint with exactly one slash; the endpoint's own trailing slash (required by Django) is kept. */
export function joinApiUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
