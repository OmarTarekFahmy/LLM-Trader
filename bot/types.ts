// Shared domain types for the EGX LLM paper trader.

export type Action = "buy" | "sell" | "hold";

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

export interface Policy {
  startingCashEgp: number;
  maxPositionPct: number;
  maxSectorPct: number;
  minHoldingDays: number;
  maxTradesPerCycle: number;
  minCashBufferPct: number;
  costs: {
    commissionPct: number;
    levyPct: number;
  };
}

export interface Holding {
  ticker: string;
  qty: number;
  avgCost: number;
  /** ISO timestamp when the position was first opened (used for minHoldingDays). */
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
  action: Exclude<Action, "hold">;
  qty: number;
  price: number;
  fees: number;
  grossValue: number;
  netCashDelta: number;
  resultingCash: number;
  resultingNav: number;
  cycleId: string;
}

/** A single quote for one ticker. */
export interface Quote {
  ticker: string;
  price: number;
  asOf: string;
  delayedMinutes?: number;
}

export interface DailyBar {
  date: string;
  close: number;
  volume?: number;
}

export interface IndexLevel {
  level: number;
  asOf: string;
  /** true when the level is a synthetic equal-weight proxy computed from the universe. */
  synthetic?: boolean;
}

/** Per-ticker bundle handed to the prompt builder. */
export interface TickerData {
  ticker: string;
  name: string;
  sector: string;
  quote: Quote | null;
  history: DailyBar[];
  /** % change over the trailing window, computed from history. */
  change5dPct: number | null;
  change20dPct: number | null;
}

export interface SectorAggregate {
  sector: string;
  avgChange5dPct: number | null;
  avgChange20dPct: number | null;
  tickerCount: number;
}

export interface MarketSnapshot {
  asOf: string;
  tickers: TickerData[];
  index: IndexLevel | null;
  indexChange5dPct: number | null;
  indexChange20dPct: number | null;
  sectors: SectorAggregate[];
  /** which provider served this cycle */
  provider: string;
}

/** One proposed action from the LLM. */
export interface ProposedAction {
  ticker: string;
  action: Action;
  quantity: number;
  rationale: string;
}

export interface LlmDecision {
  marketRead: string;
  actions: ProposedAction[];
}

export interface LlmResult extends LlmDecision {
  provider: string;
  model: string;
  raw: string;
}

export type AdjustmentKind = "accepted" | "clamped" | "rejected";

export interface GuardrailAdjustment {
  ticker: string;
  action: Action;
  proposedQty: number;
  finalQty: number;
  kind: AdjustmentKind;
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
  executedActions: {
    ticker: string;
    action: Exclude<Action, "hold">;
    qty: number;
    price: number;
    fees: number;
  }[];
  navBefore: number;
  navAfter: number;
  cash: number;
  error: string | null;
}

export interface PriceSnapshot {
  asOf: string;
  provider: string;
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

export interface MarketDataProvider {
  readonly name: string;
  getQuote(ticker: string): Promise<Quote>;
  getHistoricalDaily(ticker: string, days: number): Promise<DailyBar[]>;
  getIndexLevel(indexSymbol: string): Promise<IndexLevel>;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  decide(promptText: string): Promise<LlmResult>;
}
