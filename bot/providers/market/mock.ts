import type { DailyBar, IndexLevel, MarketDataProvider, Quote } from "../../types.js";

/**
 * Deterministic offline market data. Enabled with MOCK_MARKET=1 for local
 * end-to-end testing without any network or API key. Prices are a smooth
 * pseudo-random walk seeded by the ticker so runs are reproducible.
 */
export class MockMarketProvider implements MarketDataProvider {
  readonly name = "mock-market";

  private seed(ticker: string): number {
    let h = 2166136261;
    for (const ch of ticker) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 2 ** 32;
  }

  private basePrice(ticker: string): number {
    return 5 + this.seed(ticker) * 300;
  }

  async getHistoricalDaily(ticker: string, days: number): Promise<DailyBar[]> {
    const base = this.basePrice(ticker);
    const s = this.seed(ticker);
    const bars: DailyBar[] = [];
    const today = new Date();
    let price = base * 0.9;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const wobble = Math.sin((i + s * 20) / 3) * 0.02 + (this.seed(ticker + i) - 0.5) * 0.015;
      price = Math.max(0.5, price * (1 + wobble + 0.0008));
      bars.push({
        date: d.toISOString().slice(0, 10),
        close: Number(price.toFixed(3)),
        volume: Math.round(100000 + this.seed(ticker + "v" + i) * 900000),
      });
    }
    return bars;
  }

  async getQuote(ticker: string): Promise<Quote> {
    const bars = await this.getHistoricalDaily(ticker, 2);
    return {
      ticker,
      price: bars[bars.length - 1]!.close,
      asOf: new Date().toISOString(),
      delayedMinutes: 0,
    };
  }

  async getIndexLevel(_indexSymbol: string): Promise<IndexLevel> {
    return { level: 30000 + this.seed("EGX30") * 5000, asOf: new Date().toISOString(), synthetic: false };
  }
}
