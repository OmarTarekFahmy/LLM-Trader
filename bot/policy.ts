import { bookFill, computeNav, feeFor, positionValue, type PriceLookup } from "./ledger.js";
import { tradingDaysBetween } from "./session.js";
import type {
  GuardrailAdjustment,
  MarketSnapshot,
  Policy,
  Portfolio,
  ProposedAction,
  TradeRecord,
} from "./types.js";

export interface GuardrailOutcome {
  finalPortfolio: Portfolio;
  trades: TradeRecord[];
  adjustments: GuardrailAdjustment[];
}

const clampReason = (proposed: number, final: number, limit: string): string =>
  `clamped ${proposed} -> ${final} to respect ${limit}`;

export function applyGuardrails(args: {
  portfolio: Portfolio;
  proposals: ProposedAction[];
  snapshot: MarketSnapshot;
  policy: Policy;
  nowIso: string;
  cycleId: string;
}): GuardrailOutcome {
  const { proposals, snapshot, policy, nowIso, cycleId } = args;

  const priceMap = new Map<string, number>();
  const sectorMap = new Map<string, string>();
  for (const t of snapshot.tickers) {
    if (t.quote) priceMap.set(t.ticker, t.quote.price);
    sectorMap.set(t.ticker, t.sector);
  }
  const priceOf: PriceLookup = (tk) => priceMap.get(tk) ?? null;
  const universeTickers = new Set(snapshot.tickers.map((t) => t.ticker));

  let portfolio: Portfolio = {
    ...args.portfolio,
    holdings: args.portfolio.holdings.map((h) => ({ ...h })),
  };
  const trades: TradeRecord[] = [];
  const adjustments: GuardrailAdjustment[] = [];

  const reject = (a: ProposedAction, reason: string): void => {
    adjustments.push({
      ticker: a.ticker,
      action: a.action,
      proposedQty: a.quantity,
      finalQty: 0,
      kind: "rejected",
      reason,
    });
  };
  const accept = (a: ProposedAction, finalQty: number, clamped: boolean, reason: string): void => {
    adjustments.push({
      ticker: a.ticker,
      action: a.action,
      proposedQty: a.quantity,
      finalQty,
      kind: clamped ? "clamped" : "accepted",
      reason,
    });
  };

  // Process sells before buys so proceeds are available to buys in the same cycle.
  const order = [...proposals].sort((x, y) => rank(x.action) - rank(y.action));

  let executed = 0;
  for (const a of order) {
    if (a.action === "hold" || a.quantity <= 0) {
      accept(a, 0, false, a.action === "hold" ? "hold — no trade" : "zero quantity — no trade");
      continue;
    }
    if (!universeTickers.has(a.ticker)) {
      reject(a, "ticker not in tracked universe");
      continue;
    }
    if (executed >= policy.maxTradesPerCycle) {
      reject(a, `maxTradesPerCycle (${policy.maxTradesPerCycle}) reached`);
      continue;
    }
    const price = priceOf(a.ticker);
    if (price === null || price <= 0) {
      reject(a, "no quote available this cycle");
      continue;
    }

    if (a.action === "sell") {
      const held = portfolio.holdings.find((h) => h.ticker === a.ticker);
      if (!held || held.qty <= 0) {
        reject(a, "no open position to sell");
        continue;
      }
      const daysHeld = tradingDaysBetween(held.openedAt, nowIso);
      if (daysHeld < policy.minHoldingDays) {
        reject(a, `minHoldingDays not met (${daysHeld}/${policy.minHoldingDays} trading days held)`);
        continue;
      }
      let qty = Math.min(a.quantity, held.qty);
      const clamped = qty !== a.quantity;
      if (qty <= 0) {
        reject(a, "nothing to sell after clamping");
        continue;
      }
      const { portfolio: next, trade } = bookFill(
        portfolio,
        { ticker: a.ticker, action: "sell", qty, price, sector: sectorMap.get(a.ticker) ?? "?", cycleId, timestamp: nowIso },
        policy,
        priceOf,
      );
      portfolio = next;
      trades.push(trade);
      executed += 1;
      accept(a, qty, clamped, clamped ? clampReason(a.quantity, qty, "position size") : "sell booked");
      continue;
    }

    // BUY
    const nav = computeNav(portfolio, priceOf);
    const sector = sectorMap.get(a.ticker) ?? "?";
    let qty = a.quantity;
    const reasons: string[] = [];

    // maxPositionPct
    const maxPosVal = policy.maxPositionPct * nav;
    const curPosVal = positionValue(portfolio, a.ticker, priceOf);
    const posRoom = Math.max(0, maxPosVal - curPosVal);
    const qtyByPos = Math.floor(posRoom / price);
    if (qtyByPos < qty) {
      qty = qtyByPos;
      reasons.push(`maxPositionPct ${(policy.maxPositionPct * 100).toFixed(0)}%`);
    }

    // maxSectorPct
    let sectorVal = 0;
    for (const h of portfolio.holdings) {
      if ((sectorMap.get(h.ticker) ?? "?") === sector) sectorVal += positionValue(portfolio, h.ticker, priceOf);
    }
    const sectorRoom = Math.max(0, policy.maxSectorPct * nav - sectorVal);
    const qtyBySector = Math.floor(sectorRoom / price);
    if (qtyBySector < qty) {
      qty = qtyBySector;
      reasons.push(`maxSectorPct ${(policy.maxSectorPct * 100).toFixed(0)}%`);
    }

    // minCashBufferPct (account for fees)
    const minCash = policy.minCashBufferPct * nav;
    const spendable = Math.max(0, portfolio.cash - minCash);
    // qty * price * (1 + feeRate) <= spendable
    const feeRate = policy.costs.commissionPct + policy.costs.levyPct;
    const qtyByCash = Math.floor(spendable / (price * (1 + feeRate)));
    if (qtyByCash < qty) {
      qty = qtyByCash;
      reasons.push(`minCashBufferPct ${(policy.minCashBufferPct * 100).toFixed(0)}%`);
    }

    qty = Math.max(0, Math.floor(qty));
    if (qty <= 0) {
      reject(a, `buy fully blocked by ${reasons.join(", ") || "limits"}`);
      continue;
    }
    const clamped = qty !== a.quantity;

    // final affordability sanity check
    const cost = qty * price;
    if (cost + feeFor(cost, policy) > portfolio.cash + 0.01) {
      reject(a, "insufficient cash at fill time");
      continue;
    }

    const { portfolio: next, trade } = bookFill(
      portfolio,
      { ticker: a.ticker, action: "buy", qty, price, sector, cycleId, timestamp: nowIso },
      policy,
      priceOf,
    );
    portfolio = next;
    trades.push(trade);
    executed += 1;
    accept(
      a,
      qty,
      clamped,
      clamped ? clampReason(a.quantity, qty, reasons.join(" + ") || "limits") : "buy booked",
    );
  }

  portfolio.nav = computeNav(portfolio, priceOf);
  portfolio.lastUpdated = nowIso;
  return { finalPortfolio: portfolio, trades, adjustments };
}

function rank(action: ProposedAction["action"]): number {
  if (action === "sell") return 0;
  if (action === "buy") return 1;
  return 2;
}
