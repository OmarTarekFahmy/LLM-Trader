import { config } from "../../config.js";
import type { MarketDataProvider } from "../../types.js";
import { MockMarketProvider } from "./mock.js";
import { TwelveDataProvider } from "./twelvedata.js";
// import { EgxApiProvider } from "./egxapi.js"; // offline as of 2026-09-09, see egxapi.ts

/**
 * Provider selection for the MVP.
 *
 * Spec §4 named EGXAPI primary / Twelve Data fallback, but a build-time check
 * found EGXAPI's data endpoints offline (Cloudflare 1033) and the product is an
 * order API, not a price feed. Per the user's instruction, Twelve Data is the
 * primary provider. The Resilience phase can add a second real provider to
 * `chain` and the fallback logic below already handles it.
 */
export function getMarketProviderChain(): MarketDataProvider[] {
  if (config.mockMarket) return [new MockMarketProvider()];
  const chain: MarketDataProvider[] = [];
  if (config.twelveData.apiKey) chain.push(new TwelveDataProvider(config.twelveData.apiKey));
  // chain.push(new EgxApiProvider(config.egxapi.apiKey)); // enable when EGXAPI data endpoints work
  if (chain.length === 0) {
    throw new Error("No market data provider configured. Set TWELVEDATA_API_KEY (or MOCK_MARKET=1).");
  }
  return chain;
}
