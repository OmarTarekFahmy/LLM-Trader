import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFill, computeNav, feeFor } from "./ledger.js";
import { applyGuardrails } from "./policy.js";
import { tradingDaysBetween } from "./session.js";
import { parseLlmJson } from "./prompt.js";
import type { MarketSnapshot, Policy, Portfolio } from "./types.js";

const policy: Policy = {
  startingCashEgp: 100000,
  maxPositionPct: 0.15,
  maxSectorPct: 0.35,
  minHoldingDays: 5,
  maxTradesPerCycle: 2,
  minCashBufferPct: 0.05,
  costs: { commissionPct: 0.0005, levyPct: 0.0005 },
};

const snapshot = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  asOf: "2026-09-09T10:00:00+03:00",
  provider: "test",
  index: { level: 30000, asOf: "x" },
  indexChange5dPct: 1,
  indexChange20dPct: 2,
  sectors: [],
  tickers: [
    { ticker: "COMI", name: "CIB", sector: "Financials", quote: { ticker: "COMI", price: 100, asOf: "x" }, history: [], change5dPct: 1, change20dPct: 5 },
    { ticker: "HRHO", name: "EFG", sector: "Financials", quote: { ticker: "HRHO", price: 25, asOf: "x" }, history: [], change5dPct: -1, change20dPct: -3 },
    { ticker: "TMGH", name: "TMG", sector: "Real Estate", quote: { ticker: "TMGH", price: 50, asOf: "x" }, history: [], change5dPct: 2, change20dPct: 4 },
  ],
  ...over,
});

const freshPortfolio = (): Portfolio => ({
  cash: 100000,
  holdings: [],
  nav: 100000,
  inceptionDate: "2026-09-01T10:00:00+03:00",
  inceptionBenchmarkIndexLevel: 29000,
  lastUpdated: null,
});

test("feeFor applies combined commission + levy", () => {
  assert.equal(feeFor(10000, policy), 10); // 0.1%
});

test("bookFill buy: cash, avgCost, NAV", () => {
  const p = freshPortfolio();
  const { portfolio, trade } = bookFill(
    p,
    { ticker: "COMI", action: "buy", qty: 100, price: 100, sector: "Financials", cycleId: "c1", timestamp: "t" },
    policy,
    () => 100,
  );
  assert.equal(trade.grossValue, 10000);
  assert.equal(trade.fees, 10);
  assert.equal(portfolio.cash, 89990);
  assert.equal(portfolio.holdings[0]!.qty, 100);
  assert.equal(portfolio.holdings[0]!.avgCost, 100.1);
  assert.equal(computeNav(portfolio, () => 100), 99990);
});

test("bookFill sell reduces position and adds proceeds net of fees", () => {
  let p = freshPortfolio();
  p = bookFill(p, { ticker: "COMI", action: "buy", qty: 100, price: 100, sector: "Financials", cycleId: "c1", timestamp: "t" }, policy, () => 100).portfolio;
  const { portfolio, trade } = bookFill(
    p,
    { ticker: "COMI", action: "sell", qty: 40, price: 110, sector: "Financials", cycleId: "c2", timestamp: "t2" },
    policy,
    () => 110,
  );
  assert.equal(trade.grossValue, 4400);
  assert.equal(trade.fees, 4.4);
  assert.equal(portfolio.holdings[0]!.qty, 60);
  assert.equal(portfolio.cash, 89990 + 4400 - 4.4);
});

test("guardrail clamps a buy that exceeds maxPositionPct", () => {
  const out = applyGuardrails({
    portfolio: freshPortfolio(),
    proposals: [{ ticker: "COMI", action: "buy", quantity: 1000, rationale: "big" }],
    snapshot: snapshot(),
    policy,
    nowIso: "2026-09-09T10:00:00+03:00",
    cycleId: "c1",
  });
  // 15% of 100k NAV / 100 price = 150 shares max
  assert.equal(out.trades.length, 1);
  assert.equal(out.trades[0]!.qty, 150);
  assert.equal(out.adjustments[0]!.kind, "clamped");
});

test("guardrail rejects a sell inside the minimum holding period", () => {
  const p = freshPortfolio();
  p.holdings.push({ ticker: "COMI", qty: 100, avgCost: 100, openedAt: "2026-09-08T10:00:00+03:00" });
  const out = applyGuardrails({
    portfolio: p,
    proposals: [{ ticker: "COMI", action: "sell", quantity: 100, rationale: "exit" }],
    snapshot: snapshot(),
    policy,
    nowIso: "2026-09-09T10:00:00+03:00",
    cycleId: "c1",
  });
  assert.equal(out.trades.length, 0);
  assert.equal(out.adjustments[0]!.kind, "rejected");
});

test("guardrail enforces maxTradesPerCycle", () => {
  const out = applyGuardrails({
    portfolio: freshPortfolio(),
    proposals: [
      { ticker: "COMI", action: "buy", quantity: 10, rationale: "a" },
      { ticker: "HRHO", action: "buy", quantity: 10, rationale: "b" },
      { ticker: "TMGH", action: "buy", quantity: 10, rationale: "c" },
    ],
    snapshot: snapshot(),
    policy,
    nowIso: "2026-09-09T10:00:00+03:00",
    cycleId: "c1",
  });
  assert.equal(out.trades.length, 2);
  assert.ok(out.adjustments.some((a) => a.kind === "rejected" && a.reason.includes("maxTradesPerCycle")));
});

test("tradingDaysBetween counts Sun-Thu only", () => {
  // 2026-09-09 is a Wednesday. Thu-10, Fri-11(skip), Sat-12(skip), Sun-13, Mon-14
  assert.equal(tradingDaysBetween("2026-09-09T10:00:00+03:00", "2026-09-14T10:00:00+03:00"), 3);
});

test("parseLlmJson tolerates markdown fences and prose", () => {
  const d = parseLlmJson('Here you go:\n```json\n{"marketRead":"ok","actions":[{"ticker":"comi","action":"BUY","quantity":"5","rationale":"x"}]}\n```');
  assert.equal(d.marketRead, "ok");
  assert.equal(d.actions[0]!.ticker, "COMI");
  assert.equal(d.actions[0]!.action, "buy");
  assert.equal(d.actions[0]!.quantity, 5);
});
