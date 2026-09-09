import type { DailyBar, IndexLevel, MarketDataProvider, Quote } from "../../types.js";

const BASE = "https://api.twelvedata.com";

/**
 * Symbol overrides for cases where the plain EGX ticker isn't what Twelve Data
 * expects. Extend as you discover mismatches (check with:
 *   curl "https://api.twelvedata.com/symbol_search?symbol=XXXX&apikey=KEY"
 * ). Keys are our universe tickers; values are the Twelve Data `symbol`.
 */
const SYMBOL_OVERRIDES: Record<string, string> = {
  // e.g. RMDA: "RMDA" — kept explicit here so the map is easy to find/edit.
};

/** Candidate index symbols to try for EGX30 before falling back to synthetic. */
const INDEX_SYMBOL_CANDIDATES = ["EGX30", "EGX 30", "CASE30", "^CASE30"];

interface TdError {
  code?: number;
  message?: string;
  status?: string;
}

interface TdTimeSeriesValue {
  datetime: string;
  close: string;
  volume?: string;
}

interface TdTimeSeriesResponse extends TdError {
  values?: TdTimeSeriesValue[];
}

interface TdPriceResponse extends TdError {
  price?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = "twelvedata";
  private readonly apiKey: string;
  private lastRequestAt = 0;
  /** Free tier: 8 requests/minute. Stay a touch under that. */
  private readonly minGapMs = 8_100;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("TwelveDataProvider: missing TWELVEDATA_API_KEY");
    this.apiKey = apiKey;
  }

  private async throttle(): Promise<void> {
    const wait = this.minGapMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async get<T extends TdError>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, apikey: this.apiKey }).toString();
    const url = `${BASE}/${path}?${qs}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.throttle();
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = (await res.json()) as T;

      const rateLimited =
        res.status === 429 || body.code === 429 || (body.message ?? "").includes("run out of API credits");
      if (rateLimited && attempt < 2) {
        await sleep(60_000);
        continue;
      }
      if (body.status === "error") {
        throw new Error(`twelvedata ${path} error ${body.code ?? "?"}: ${body.message ?? "unknown"}`);
      }
      return body;
    }
    throw new Error(`twelvedata ${path}: rate limited after retries`);
  }

  private tdSymbol(ticker: string): string {
    return SYMBOL_OVERRIDES[ticker] ?? ticker;
  }

  async getHistoricalDaily(ticker: string, days: number): Promise<DailyBar[]> {
    const body = await this.get<TdTimeSeriesResponse>("time_series", {
      symbol: this.tdSymbol(ticker),
      exchange: "EGX",
      interval: "1day",
      outputsize: String(Math.max(1, Math.min(days, 5000))),
      order: "ASC",
      timezone: "Africa/Cairo",
    });
    const values = body.values ?? [];
    return values
      .map((v) => ({
        date: v.datetime,
        close: Number(v.close),
        volume: v.volume !== undefined ? Number(v.volume) : undefined,
      }))
      .filter((b) => Number.isFinite(b.close));
  }

  async getQuote(ticker: string): Promise<Quote> {
    const body = await this.get<TdPriceResponse>("price", {
      symbol: this.tdSymbol(ticker),
      exchange: "EGX",
    });
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`twelvedata: no price for ${ticker}`);
    }
    return { ticker, price, asOf: new Date().toISOString(), delayedMinutes: 15 };
  }

  async getIndexLevel(indexSymbol: string): Promise<IndexLevel> {
    const candidates = [indexSymbol, ...INDEX_SYMBOL_CANDIDATES];
    for (const sym of candidates) {
      try {
        const body = await this.get<TdTimeSeriesResponse>("time_series", {
          symbol: sym,
          interval: "1day",
          outputsize: "1",
          order: "DESC",
        });
        const v = body.values?.[0];
        if (v && Number.isFinite(Number(v.close))) {
          return { level: Number(v.close), asOf: v.datetime, synthetic: false };
        }
      } catch {
        // try next candidate
      }
    }
    throw new Error("twelvedata: EGX30 index level unavailable");
  }
}
