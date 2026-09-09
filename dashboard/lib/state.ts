import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DecisionEntry,
  EquityPoint,
  Portfolio,
  PriceSnapshot,
  TradeRecord,
  Universe,
} from "./types";

const BASE = process.env.STATE_BASE_URL?.replace(/\/$/, "");

/** Revalidate window (seconds) for ISR — dashboard shows fresh state within ~this. */
export const REVALIDATE = 60;

async function loadJson<T>(name: string, fallback: T): Promise<T> {
  try {
    if (BASE) {
      const res = await fetch(`${BASE}/${name}`, { next: { revalidate: REVALIDATE } });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      return (await res.json()) as T;
    }
    // dev / repo-root build: read from disk
    const raw = await readFile(join(process.cwd(), "..", "state", name), "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`state load failed for ${name}:`, err);
    return fallback;
  }
}

export const getPortfolio = (): Promise<Portfolio> =>
  loadJson<Portfolio>("portfolio.json", {
    cash: 0,
    holdings: [],
    nav: 0,
    inceptionDate: null,
    inceptionBenchmarkIndexLevel: null,
    lastUpdated: null,
  });

export const getTrades = async (): Promise<TradeRecord[]> =>
  (await loadJson<{ trades: TradeRecord[] }>("trades.json", { trades: [] })).trades;

export const getDecisions = async (): Promise<DecisionEntry[]> =>
  (await loadJson<{ decisions: DecisionEntry[] }>("decisions.json", { decisions: [] })).decisions;

export const getEquityCurve = async (): Promise<EquityPoint[]> =>
  (await loadJson<{ points: EquityPoint[] }>("equity_curve.json", { points: [] })).points;

export const getPrices = (): Promise<PriceSnapshot> =>
  loadJson<PriceSnapshot>("prices.json", {
    asOf: null,
    provider: null,
    index: null,
    indexChange5dPct: null,
    indexChange20dPct: null,
    quotes: {},
  });

export const getUniverse = (): Promise<Universe> =>
  loadJson<Universe>("universe.json", {
    source: "",
    asOf: "",
    indexSymbol: "EGX30",
    constituents: [],
  });
