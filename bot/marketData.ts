import type {
  DailyBar,
  IndexLevel,
  MarketDataProvider,
  MarketSnapshot,
  SectorAggregate,
  TickerData,
  UniverseEntry,
} from "./types.js";

function pctChange(bars: DailyBar[], lookback: number): number | null {
  if (bars.length < lookback + 1) return null;
  const latest = bars[bars.length - 1]!.close;
  const past = bars[bars.length - 1 - lookback]!.close;
  if (!past) return null;
  return ((latest - past) / past) * 100;
}

/** stdev of daily % returns over the last `n` sessions. */
function volatilityPct(bars: DailyBar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  const rets: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const prev = bars[i - 1]!.close;
    const cur = bars[i]!.close;
    if (prev > 0) rets.push(((cur - prev) / prev) * 100);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

function pctFromExtreme(bars: DailyBar[], n: number, kind: "high" | "low"): number | null {
  if (bars.length < 2) return null;
  const window = bars.slice(-n).map((b) => b.close);
  if (window.length === 0) return null;
  const latest = window[window.length - 1]!;
  const ref = kind === "high" ? Math.max(...window) : Math.min(...window);
  if (ref <= 0) return null;
  return ((latest - ref) / ref) * 100;
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

/**
 * Fetch one shared snapshot for the union of every strategy's universe. Each
 * strategy then narrows it with `filterSnapshot`.
 */
export async function gatherMarketData(
  constituents: UniverseEntry[],
  indexSymbol: string,
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

  for (const c of constituents) {
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

    tickers.push(buildTickerData(c, quote, history));
  }

  let index: IndexLevel | null = null;
  const idxRes = await withFallback(chain, (p) => p.getIndexLevel(indexSymbol), logErr);
  if (idxRes) index = idxRes.value;
  else index = syntheticIndex(tickers);

  const snapshot = assembleSnapshot(tickers, index, providerName);
  return { snapshot, errors, missing };
}

function buildTickerData(
  c: UniverseEntry,
  quote: TickerData["quote"],
  history: DailyBar[],
): TickerData {
  return {
    ticker: c.ticker,
    name: c.name,
    sector: c.sector,
    quote,
    history,
    change1dPct: pctChange(history, 1),
    change3dPct: pctChange(history, 3),
    change5dPct: pctChange(history, 5),
    change10dPct: pctChange(history, 10),
    change20dPct: pctChange(history, 20),
    volatility10dPct: volatilityPct(history, 10),
    pctFrom20dHigh: pctFromExtreme(history, 20, "high"),
    pctFrom20dLow: pctFromExtreme(history, 20, "low"),
  };
}

/** Narrow a shared snapshot to one strategy's universe, recomputing aggregates. */
export function filterSnapshot(snapshot: MarketSnapshot, tickers: Set<string>): MarketSnapshot {
  const subset = snapshot.tickers.filter((t) => tickers.has(t.ticker));
  const index = snapshot.index?.synthetic ? syntheticIndex(subset) : snapshot.index;
  return assembleSnapshot(subset, index ?? snapshot.index, snapshot.provider, snapshot.asOf);
}

function assembleSnapshot(
  tickers: TickerData[],
  index: IndexLevel | null,
  provider: string,
  asOf?: string,
): MarketSnapshot {
  const { index5d, index20d } = universeAvgTrend(tickers);
  return {
    asOf: asOf ?? new Date().toISOString(),
    tickers,
    index,
    indexChange5dPct: index5d,
    indexChange20dPct: index20d,
    sectors: sectorAggregates(tickers),
    provider,
  };
}

/** Equal-weight normalized proxy: average of each ticker's close / its first close, x 10000. */
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

/** Approximate index trend from the universe's average trailing return (we lack an index series). */
function universeAvgTrend(tickers: TickerData[]): { index5d: number | null; index20d: number | null } {
  const avg = (pick: (t: TickerData) => number | null): number | null => {
    const vals = tickers.map(pick).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return { index5d: avg((t) => t.change5dPct), index20d: avg((t) => t.change20dPct) };
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
