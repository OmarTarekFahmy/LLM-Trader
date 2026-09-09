import type { DailyBar, IndexLevel, MarketDataProvider, Quote } from "../../types.js";

/**
 * EGXAPI (egxapi.com) provider — STUB, not wired into the cycle.
 *
 * Build-time check (2026-09-09): api.egxapi.com returns Cloudflare error 1033
 * (no origin) on every endpoint, and the product is actually an order-execution
 * API rather than a read-only price feed. It is therefore not usable as a market
 * data source right now. Twelve Data is the primary provider instead (see
 * providers/market/index.ts).
 *
 * This file is kept as a placeholder so that, if EGXAPI's data endpoints ever
 * come online, wiring it in is a one-file change: implement the three methods
 * against https://api.egxapi.com/v2/market-data/* and add it to the provider
 * chain in providers/market/index.ts.
 */
export class EgxApiProvider implements MarketDataProvider {
  readonly name = "egxapi";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_apiKey: string) {}

  private unavailable(): never {
    throw new Error("EgxApiProvider: not implemented — EGXAPI data endpoints are offline (build-time check 2026-09-09)");
  }

  async getQuote(_ticker: string): Promise<Quote> {
    return this.unavailable();
  }

  async getHistoricalDaily(_ticker: string, _days: number): Promise<DailyBar[]> {
    return this.unavailable();
  }

  async getIndexLevel(_indexSymbol: string): Promise<IndexLevel> {
    return this.unavailable();
  }
}
