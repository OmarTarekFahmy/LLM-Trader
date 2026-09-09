import type { Holding, Policy, Portfolio, TradeRecord } from "./types.js";

export type PriceLookup = (ticker: string) => number | null;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function feeFor(tradeValue: number, policy: Policy): number {
  return round2(tradeValue * (policy.costs.commissionPct + policy.costs.levyPct));
}

/** NAV = cash + marked-to-market value of holdings. Falls back to avgCost when a price is missing. */
export function computeNav(portfolio: Portfolio, priceOf: PriceLookup): number {
  let nav = portfolio.cash;
  for (const h of portfolio.holdings) {
    const px = priceOf(h.ticker) ?? h.avgCost;
    nav += px * h.qty;
  }
  return round2(nav);
}

export function positionValue(portfolio: Portfolio, ticker: string, priceOf: PriceLookup): number {
  const h = portfolio.holdings.find((x) => x.ticker === ticker);
  if (!h) return 0;
  const px = priceOf(ticker) ?? h.avgCost;
  return px * h.qty;
}

export interface BookInput {
  ticker: string;
  action: "buy" | "sell";
  qty: number;
  price: number;
  sector: string;
  cycleId: string;
  timestamp: string;
}

export interface BookResult {
  portfolio: Portfolio;
  trade: TradeRecord;
}

/**
 * Deterministically book one fill into a copy of the portfolio. Assumes the
 * caller (policy layer) has already validated affordability / limits and clamped
 * qty. Still guards against nonsense (qty <= 0, overselling).
 */
export function bookFill(portfolio: Portfolio, input: BookInput, policy: Policy, priceOf: PriceLookup): BookResult {
  const qty = Math.floor(input.qty);
  if (qty <= 0) throw new Error(`bookFill: non-positive qty for ${input.ticker}`);

  const grossValue = round2(qty * input.price);
  const fees = feeFor(grossValue, policy);
  const holdings: Holding[] = portfolio.holdings.map((h) => ({ ...h }));
  let cash = portfolio.cash;
  let netCashDelta: number;

  if (input.action === "buy") {
    netCashDelta = -round2(grossValue + fees);
    cash = round2(cash + netCashDelta);
    if (cash < -0.01) throw new Error(`bookFill: buy ${input.ticker} overdraws cash`);
    const existing = holdings.find((h) => h.ticker === input.ticker);
    if (existing) {
      const totalCost = existing.avgCost * existing.qty + grossValue + fees;
      existing.qty += qty;
      existing.avgCost = round2(totalCost / existing.qty);
    } else {
      holdings.push({
        ticker: input.ticker,
        qty,
        avgCost: round2((grossValue + fees) / qty),
        openedAt: input.timestamp,
      });
    }
  } else {
    const existing = holdings.find((h) => h.ticker === input.ticker);
    if (!existing || existing.qty < qty) throw new Error(`bookFill: sell ${input.ticker} exceeds position`);
    netCashDelta = round2(grossValue - fees);
    cash = round2(cash + netCashDelta);
    existing.qty -= qty;
    if (existing.qty === 0) {
      const idx = holdings.indexOf(existing);
      holdings.splice(idx, 1);
    }
  }

  const next: Portfolio = { ...portfolio, cash, holdings };
  const resultingNav = computeNav(next, priceOf);
  next.nav = resultingNav;

  const trade: TradeRecord = {
    timestamp: input.timestamp,
    ticker: input.ticker,
    action: input.action,
    qty,
    price: input.price,
    fees,
    grossValue,
    netCashDelta,
    resultingCash: cash,
    resultingNav,
    cycleId: input.cycleId,
  };

  return { portfolio: next, trade };
}
