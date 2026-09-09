// Subset of bot/types.ts — the shapes the dashboard reads from state/*.json.

export interface Holding {
  ticker: string;
  qty: number;
  avgCost: number;
  openedAt: string;
}

export interface Portfolio {
  cash: number;
  holdings: Holding[];
  nav: number;
  inceptionDate: string | null;
  inceptionBenchmarkIndexLevel: number | null;
  lastUpdated: string | null;
}

export interface TradeRecord {
  timestamp: string;
  ticker: string;
  action: "buy" | "sell";
  qty: number;
  price: number;
  fees: number;
  grossValue: number;
  netCashDelta: number;
  resultingCash: number;
  resultingNav: number;
  cycleId: string;
}

export type Action = "buy" | "sell" | "hold";

export interface ProposedAction {
  ticker: string;
  action: Action;
  quantity: number;
  rationale: string;
}

export interface GuardrailAdjustment {
  ticker: string;
  action: Action;
  proposedQty: number;
  finalQty: number;
  kind: "accepted" | "clamped" | "rejected";
  reason: string;
}

export interface DecisionEntry {
  cycleId: string;
  timestamp: string;
  mode: "trade" | "eod";
  session: string;
  marketSummary: string;
  llmProvider: string | null;
  dataProvider: string;
  marketRead: string;
  llmRaw: string | null;
  proposedActions: ProposedAction[];
  guardrailAdjustments: GuardrailAdjustment[];
  executedActions: { ticker: string; action: "buy" | "sell"; qty: number; price: number; fees: number }[];
  navBefore: number;
  navAfter: number;
  cash: number;
  error: string | null;
}

export interface PriceSnapshot {
  asOf: string | null;
  provider: string | null;
  index: { level: number; synthetic: boolean } | null;
  indexChange5dPct: number | null;
  indexChange20dPct: number | null;
  quotes: Record<
    string,
    { price: number; asOf: string; change5dPct: number | null; change20dPct: number | null }
  >;
}

export interface EquityPoint {
  timestamp: string;
  cycleId: string;
  nav: number;
  cash: number;
  benchmarkNav: number | null;
  indexLevel: number | null;
}

export interface UniverseEntry {
  ticker: string;
  name: string;
  sector: string;
}

export interface Universe {
  source: string;
  asOf: string;
  indexSymbol: string;
  constituents: UniverseEntry[];
}

export interface StrategyDef {
  id: string;
  label: string;
  blurb: string;
  universe: string;
  profile: "core" | "swing";
  startingCashEgp: number;
  policy: Record<string, unknown>;
}

export interface StrategyRegistry {
  cadenceMinutes: number;
  strategies: StrategyDef[];
}

/** Everything the dashboard needs to render one strategy tab. */
export interface StrategyData {
  def: StrategyDef;
  portfolio: Portfolio;
  trades: TradeRecord[];
  decisions: DecisionEntry[];
  equity: EquityPoint[];
  prices: PriceSnapshot;
  universeCount: number;
}
