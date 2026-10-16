import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { resolveApiBase } from "./lib/apiUrl";

// NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so a production build with a missing or
// malformed API URL must fail instead of shipping a broken bundle (validation shared with lib/apiUrl.ts).
function assertProductionApiUrl() {
  resolveApiBase(process.env.NEXT_PUBLIC_API_URL, true);
}

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Hide the bottom-left "N" route indicator in development; build/runtime errors still show.
  devIndicators: false,
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) assertProductionApiUrl();
  return nextConfig;
}
