import type {
  DailyBar,
  IndexLevel,
  MarketDataProvider,
  MarketSnapshot,
  SectorAggregate,
  TickerData,
  Universe,
} from "./types.js";

function pctChange(bars: DailyBar[], lookback: number): number | null {
  if (bars.length < lookback + 1) return null;
  const latest = bars[bars.length - 1]!.close;
  const past = bars[bars.length - 1 - lookback]!.close;
  if (!past) return null;
  return ((latest - past) / past) * 100;
}

/** Try each provider in order for a single call; return the first success. */
async function withFallback<T>(
  chain: MarketDataProvider[],
  fn: (p: MarketDataProvider) => Promise<T>,
  onError: (name: string, err: unknown) => void,
): Promise<{ value: T; provider: string } | null> {
  for (const p of chain) {
    try {
      const value = await fn(p);
      return { value, provider: p.name };
    } catch (err) {
      onError(p.name, err);
    }
  }
  return null;
}

export interface GatherResult {
  snapshot: MarketSnapshot;
  errors: string[];
  /** tickers we got no usable quote for this cycle */
  missing: string[];
}

export async function gatherMarketData(
  universe: Universe,
  chain: MarketDataProvider[],
  historyDays: number,
): Promise<GatherResult> {
  const errors: string[] = [];
  const missing: string[] = [];
  const logErr = (name: string, err: unknown): void => {
    errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const providerName = chain[0]?.name ?? "none";
  const tickers: TickerData[] = [];

  for (const c of universe.constituents) {
    const histRes = await withFallback(chain, (p) => p.getHistoricalDaily(c.ticker, historyDays), logErr);
    const history = histRes?.value ?? [];

    let quote: TickerData["quote"] = null;
    if (history.length > 0) {
      const last = history[history.length - 1]!;
      quote = { ticker: c.ticker, price: last.close, asOf: last.date, delayedMinutes: 15 };
    } else {
      const qRes = await withFallback(chain, (p) => p.getQuote(c.ticker), logErr);
      quote = qRes?.value ?? null;
    }

    if (!quote) missing.push(c.ticker);

    tickers.push({
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      quote,
      history,
      change5dPct: pctChange(history, 5),
      change20dPct: pctChange(history, 20),
    });
  }

  // Index level: try providers, else synthesize an equal-weight proxy from the universe.
  let index: IndexLevel | null = null;
  const idxRes = await withFallback(chain, (p) => p.getIndexLevel(universe.indexSymbol), logErr);
  if (idxRes) {
    index = idxRes.value;
  } else {
    const synth = syntheticIndex(tickers);
    if (synth) index = synth;
  }

  const { index5d, index20d } = indexTrend(tickers, index);

  const snapshot: MarketSnapshot = {
    asOf: new Date().toISOString(),
    tickers,
    index,
    indexChange5dPct: index5d,
    indexChange20dPct: index20d,
    sectors: sectorAggregates(tickers),
    provider: providerName,
  };

  return { snapshot, errors, missing };
}

/** Equal-weight normalized proxy: average of each ticker's close / its 60-bar-ago close, x 10000. */
function syntheticIndex(tickers: TickerData[]): IndexLevel | null {
  const ratios: number[] = [];
  for (const t of tickers) {
    if (t.history.length >= 2) {
      const first = t.history[0]!.close;
      const last = t.history[t.history.length - 1]!.close;
      if (first > 0) ratios.push(last / first);
    }
  }
  if (ratios.length === 0) return null;
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return { level: Number((avg * 10000).toFixed(2)), asOf: new Date().toISOString(), synthetic: true };
}

function indexTrend(
  tickers: TickerData[],
  index: IndexLevel | null,
): { index5d: number | null; index20d: number | null } {
  // If we only have a synthetic proxy we approximate its trend from the universe's average trailing return.
  if (index?.synthetic || !index) {
    const avg = (lb: 5 | 20): number | null => {
      const vals = tickers
        .map((t) => (lb === 5 ? t.change5dPct : t.change20dPct))
        .filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    return { index5d: avg(5), index20d: avg(20) };
  }
  // Real index without its own history series here — approximate with universe average too.
  const avg = (lb: 5 | 20): number | null => {
    const vals = tickers
      .map((t) => (lb === 5 ? t.change5dPct : t.change20dPct))
      .filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return { index5d: avg(5), index20d: avg(20) };
}

function sectorAggregates(tickers: TickerData[]): SectorAggregate[] {
  const bySector = new Map<string, TickerData[]>();
  for (const t of tickers) {
    const arr = bySector.get(t.sector) ?? [];
    arr.push(t);
    bySector.set(t.sector, arr);
  }
  const mean = (vals: (number | null)[]): number | null => {
    const nums = vals.filter((v): v is number => v !== null);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  return [...bySector.entries()]
    .map(([sector, arr]) => ({
      sector,
      avgChange5dPct: mean(arr.map((t) => t.change5dPct)),
      avgChange20dPct: mean(arr.map((t) => t.change20dPct)),
      tickerCount: arr.length,
    }))
    .sort((a, b) => a.sector.localeCompare(b.sector));
}
