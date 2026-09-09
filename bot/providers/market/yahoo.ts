import type { DailyBar, IndexLevel, MarketDataProvider, Quote } from "../../types.js";

/**
 * Yahoo Finance chart API — the working free EGX source.
 *
 * Build-time check (2026-09-09): the two spec-named providers both failed —
 * EGXAPI's API host is offline (Cloudflare 1033) and Twelve Data gates EGX
 * ("XCAI") behind the paid Pro plan, which breaks the zero-cost constraint.
 * Yahoo's `chart` endpoint serves EGX equities under the `.CA` suffix (Cairo)
 * and the index as `^CASE30`, in EGP, with no API key.
 *
 * Notes:
 *  - `meta.regularMarketPrice` is stale/unreliable for EGX; we use the last
 *    non-null daily close from the series as the (delayed / EOD) quote. The spec
 *    explicitly accepts delayed data.
 *  - `meta.instrumentType` sometimes says MUTUALFUND for real common equities —
 *    ignore it; the tracked universe is curated by hand.
 *  - Unofficial API: it can rate-limit (429). We throttle and retry.
 */
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** universe ticker -> Yahoo symbol override (default is `${ticker}.CA`). */
const SYMBOL_OVERRIDES: Record<string, string> = {};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface YahooResult {
  meta: { currency?: string; regularMarketPrice?: number };
  timestamp?: number[];
  indicators: {
    quote?: { close?: (number | null)[]; volume?: (number | null)[] }[];
    adjclose?: { adjclose?: (number | null)[] }[];
  };
}

interface YahooChart {
  chart: {
    result?: YahooResult[];
    error?: { code?: string; description?: string } | null;
  };
}

export class YahooProvider implements MarketDataProvider {
  readonly name = "yahoo";
  private lastRequestAt = 0;
  private readonly minGapMs = 350;

  private symbolFor(ticker: string): string {
    if (ticker.startsWith("^")) return ticker;
    return SYMBOL_OVERRIDES[ticker] ?? `${ticker}.CA`;
  }

  private rangeFor(days: number): string {
    if (days <= 25) return "1mo";
    if (days <= 65) return "3mo";
    if (days <= 130) return "6mo";
    if (days <= 260) return "1y";
    return "2y";
  }

  private async fetchChart(symbol: string, range: string): Promise<YahooResult> {
    const url = `${BASE}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = this.minGapMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();

      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt < 3) {
          await sleep(2_000 * (attempt + 1));
          continue;
        }
        throw new Error(`yahoo ${symbol}: HTTP ${res.status}`);
      }
      const body = (await res.json()) as YahooChart;
      const result = body.chart.result?.[0];
      if (!result) {
        throw new Error(`yahoo ${symbol}: ${body.chart.error?.description ?? "no data"}`);
      }
      return result;
    }
    throw new Error(`yahoo ${symbol}: exhausted retries`);
  }

  private toBars(result: YahooResult): DailyBar[] {
    const ts = result.timestamp ?? [];
    const q = result.indicators.quote?.[0];
    // Use raw close (the actual traded price) so quotes, history and fills agree.
    const closes = q?.close ?? [];
    const vols = q?.volume ?? [];
    const bars: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c)) continue;
      bars.push({
        date: new Date(ts[i]! * 1000).toISOString().slice(0, 10),
        close: Number(c),
        volume: vols[i] != null ? Number(vols[i]) : undefined,
      });
    }
    return bars;
  }

  async getHistoricalDaily(ticker: string, days: number): Promise<DailyBar[]> {
    const result = await this.fetchChart(this.symbolFor(ticker), this.rangeFor(days));
    const bars = this.toBars(result);
    return bars.slice(-days);
  }

  async getQuote(ticker: string): Promise<Quote> {
    const result = await this.fetchChart(this.symbolFor(ticker), "5d");
    const bars = this.toBars(result);
    const last = bars[bars.length - 1];
    if (!last) throw new Error(`yahoo: no recent close for ${ticker}`);
    return { ticker, price: last.close, asOf: last.date, delayedMinutes: 15 };
  }

  async getIndexLevel(_indexSymbol: string): Promise<IndexLevel> {
    const result = await this.fetchChart("^CASE30", "1mo");
    const bars = this.toBars(result);
    const last = bars[bars.length - 1];
    if (!last) throw new Error("yahoo: no EGX30 (^CASE30) level");
    return { level: last.close, asOf: last.date, synthetic: false };
  }
}
