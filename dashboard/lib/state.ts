import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DecisionEntry,
  EquityPoint,
  Portfolio,
  PriceSnapshot,
  StrategyData,
  StrategyRegistry,
  Universe,
} from "./types";

const BASE = process.env.STATE_BASE_URL?.replace(/\/$/, "");

/** Revalidate window (seconds) for ISR — dashboard shows fresh state within ~this. */
export const REVALIDATE = 60;

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    if (BASE) {
      const res = await fetch(`${BASE}/${path}`, { next: { revalidate: REVALIDATE } });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return (await res.json()) as T;
    }
    const raw = await readFile(join(process.cwd(), "..", "state", path), "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`state load failed for ${path}:`, err);
    return fallback;
  }
}

const EMPTY_PORTFOLIO: Portfolio = {
  cash: 0,
  holdings: [],
  nav: 0,
  inceptionDate: null,
  inceptionBenchmarkIndexLevel: null,
  lastUpdated: null,
};
const EMPTY_PRICES: PriceSnapshot = {
  asOf: null,
  provider: null,
  index: null,
  indexChange5dPct: null,
  indexChange20dPct: null,
  quotes: {},
};

export async function getRegistry(): Promise<StrategyRegistry> {
  return loadJson<StrategyRegistry>("strategies.json", { cadenceMinutes: 10, strategies: [] });
}

export async function getStrategyData(id: string, universe: string): Promise<Omit<StrategyData, "def">> {
  const [portfolio, tradesW, decisionsW, equityW, prices, uni] = await Promise.all([
    loadJson<Portfolio>(`${id}/portfolio.json`, EMPTY_PORTFOLIO),
    loadJson<{ trades: unknown[] }>(`${id}/trades.json`, { trades: [] }),
    loadJson<{ decisions: unknown[] }>(`${id}/decisions.json`, { decisions: [] }),
    loadJson<{ points: unknown[] }>(`${id}/equity_curve.json`, { points: [] }),
    loadJson<PriceSnapshot>(`${id}/prices.json`, EMPTY_PRICES),
    loadJson<Universe>(`universes/${universe}.json`, {
      source: "",
      asOf: "",
      indexSymbol: "EGX30",
      constituents: [],
    }),
  ]);
  return {
    portfolio,
    trades: tradesW.trades as StrategyData["trades"],
    decisions: decisionsW.decisions as DecisionEntry[],
    equity: equityW.points as EquityPoint[],
    prices,
    universeCount: uni.constituents.length,
  };
}

export async function getAllStrategyData(): Promise<StrategyData[]> {
  const registry = await getRegistry();
  return Promise.all(
    registry.strategies.map(async (def) => {
      const data = await getStrategyData(def.id, def.universe);
      return { def, ...data };
    }),
  );
}
