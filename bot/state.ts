import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.js";
import type {
  DecisionEntry,
  EquityPoint,
  Portfolio,
  PriceSnapshot,
  TradeRecord,
} from "./types.js";

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(STATE_DIR, file), "utf8")) as T;
}

function writeJson(file: string, data: unknown): void {
  writeFileSync(join(STATE_DIR, file), JSON.stringify(data, null, 2) + "\n", "utf8");
}

export const readPortfolio = (): Portfolio => readJson<Portfolio>("portfolio.json");
export const writePortfolio = (p: Portfolio): void => writeJson("portfolio.json", p);

export const readTrades = (): { trades: TradeRecord[] } => readJson("trades.json");
export const appendTrades = (records: TradeRecord[]): void => {
  const cur = readTrades();
  writeJson("trades.json", { trades: [...cur.trades, ...records] });
};

export const readDecisions = (): { decisions: DecisionEntry[] } => readJson("decisions.json");
export const appendDecision = (entry: DecisionEntry): void => {
  const cur = readDecisions();
  writeJson("decisions.json", { decisions: [...cur.decisions, entry] });
};
export const recentDecisions = (n: number): DecisionEntry[] => {
  const all = readDecisions().decisions;
  return all.slice(Math.max(0, all.length - n));
};

export const writePrices = (snap: PriceSnapshot): void => writeJson("prices.json", snap);

export const readEquityCurve = (): { points: EquityPoint[] } => readJson("equity_curve.json");
export const appendEquityPoint = (point: EquityPoint): void => {
  const cur = readEquityCurve();
  writeJson("equity_curve.json", { points: [...cur.points, point] });
};
