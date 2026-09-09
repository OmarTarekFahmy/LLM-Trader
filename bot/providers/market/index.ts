import { config } from "../../config.js";
import type { MarketDataProvider } from "../../types.js";
import { MockMarketProvider } from "./mock.js";
import { YahooProvider } from "./yahoo.js";
import { TwelveDataProvider } from "./twelvedata.js";
// import { EgxApiProvider } from "./egxapi.js"; // API host offline as of 2026-09-09, see egxapi.ts

/**
 * Market data provider chain.
 *
 * Spec §4 named EGXAPI primary / Twelve Data fallback. Build-time checks
 * (2026-09-09) killed both: EGXAPI's API host is offline (Cloudflare 1033), and
 * Twelve Data's free plan returns "available starting with the Pro plan" for
 * every EGX symbol — a paid upgrade, which breaks the zero-cost constraint.
 *
 * Working choice: **Yahoo Finance** (`.CA` symbols, `^CASE30` index, EGP, no
 * key). Twelve Data stays as an optional fallback that only does anything if the
 * account is later upgraded to Pro. The fallback plumbing in marketData.ts
 * handles any number of providers in order.
 */
export function getMarketProviderChain(): MarketDataProvider[] {
  if (config.mockMarket) return [new MockMarketProvider()];

  const chain: MarketDataProvider[] = [new YahooProvider()];
  // Twelve Data only helps on a paid (Pro+) plan; opt in explicitly to avoid
  // noisy "available on the Pro plan" errors on the free tier.
  if (config.twelveData.apiKey && config.useTwelveData) {
    chain.push(new TwelveDataProvider(config.twelveData.apiKey));
  }
  return chain;
}
