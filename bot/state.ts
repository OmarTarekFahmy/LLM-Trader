import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DecisionEntry,
  EquityPoint,
  Portfolio,
  PriceSnapshot,
  TradeRecord,
} from "./types.js";

function readJson<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
}

function writeJson(dir: string, file: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2) + "\n", "utf8");
}

export const EMPTY_PORTFOLIO = (): Portfolio => ({
  cash: 0,
  holdings: [],
  nav: 0,
  inceptionDate: null,
  inceptionBenchmarkIndexLevel: null,
  lastUpdated: null,
});

export const readPortfolio = (dir: string): Portfolio => readJson<Portfolio>(dir, "portfolio.json");
export const writePortfolio = (dir: string, p: Portfolio): void => writeJson(dir, "portfolio.json", p);

export const readTrades = (dir: string): { trades: TradeRecord[] } => readJson(dir, "trades.json");
export const appendTrades = (dir: string, records: TradeRecord[]): void => {
  const cur = readTrades(dir);
  writeJson(dir, "trades.json", { trades: [...cur.trades, ...records] });
};

export const readDecisions = (dir: string): { decisions: DecisionEntry[] } =>
  readJson(dir, "decisions.json");
export const appendDecision = (dir: string, entry: DecisionEntry): void => {
  const cur = readDecisions(dir);
  writeJson(dir, "decisions.json", { decisions: [...cur.decisions, entry] });
};
export const recentDecisions = (dir: string, n: number): DecisionEntry[] => {
  const all = readDecisions(dir).decisions;
  return all.slice(Math.max(0, all.length - n));
};

export const writePrices = (dir: string, snap: PriceSnapshot): void =>
  writeJson(dir, "prices.json", snap);

export const readEquityCurve = (dir: string): { points: EquityPoint[] } =>
  readJson(dir, "equity_curve.json");
export const appendEquityPoint = (dir: string, point: EquityPoint): void => {
  const cur = readEquityCurve(dir);
  writeJson(dir, "equity_curve.json", { points: [...cur.points, point] });
};
