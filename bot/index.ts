import { DateTime } from "luxon";
import { config, loadPolicy, loadUniverse } from "./config.js";
import { gatherMarketData } from "./marketData.js";
import { applyGuardrails } from "./policy.js";
import { computeNav, type PriceLookup } from "./ledger.js";
import { buildPrompt } from "./prompt.js";
import { getLlmProviderChain } from "./providers/llm/index.js";
import { getMarketProviderChain } from "./providers/market/index.js";
import { CAIRO_TZ, checkSession } from "./session.js";
import {
  appendDecision,
  appendEquityPoint,
  appendTrades,
  readPortfolio,
  recentDecisions,
  writePortfolio,
  writePrices,
} from "./state.js";
import type {
  DecisionEntry,
  EquityPoint,
  LlmResult,
  MarketSnapshot,
  Portfolio,
  PriceSnapshot,
} from "./types.js";

const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
const ghError = (msg: string): void => console.log(`::error::${msg}`);

function cycleId(now: DateTime, mode: string): string {
  return `${now.toFormat("yyyyLLdd'T'HHmm")}-${mode}`;
}

function benchmarkNav(portfolio: Portfolio, snapshot: MarketSnapshot, startingCash: number): number | null {
  if (!snapshot.index || !portfolio.inceptionBenchmarkIndexLevel) return null;
  return Number(
    ((snapshot.index.level / portfolio.inceptionBenchmarkIndexLevel) * startingCash).toFixed(2),
  );
}

async function main(): Promise<void> {
  const policy = loadPolicy();
  const universe = loadUniverse();
  const nowCairo = DateTime.now().setZone(CAIRO_TZ);
  const session = checkSession(nowCairo);

  const wantEod = config.mode === "eod";
  const mode: "trade" | "eod" = wantEod ? "eod" : "trade";
  const id = cycleId(nowCairo, mode);

  log(`cycle ${id} — Cairo ${nowCairo.toFormat("ccc yyyy-LL-dd HH:mm")} — ${session.label}`);

  // Session gate (skippable with FORCE_SESSION for testing).
  if (!config.forceSession) {
    if (mode === "trade" && !session.isOpen) {
      if (session.isEodWindow) {
        log("outside trade session but in EOD window — running mark-to-market instead");
        return runEod(id, nowCairo, policy.startingCashEgp, universe);
      }
      log(`no-op: ${session.label}`);
      return;
    }
    if (mode === "eod" && !session.isTradingDay) {
      log(`no-op: ${session.label} (EOD)`);
      return;
    }
  }

  if (mode === "eod") {
    return runEod(id, nowCairo, policy.startingCashEgp, universe);
  }

  // ---- full trade cycle ----
  const marketChain = getMarketProviderChain();
  log(`market data providers: ${marketChain.map((p) => p.name).join(" -> ")}`);
  const { snapshot, errors: dataErrors, missing } = await gatherMarketData(
    universe,
    marketChain,
    config.historyDays,
  );
  if (dataErrors.length) log(`market data warnings (${dataErrors.length}): ${dataErrors.slice(0, 5).join(" | ")}`);
  log(
    `snapshot: ${snapshot.tickers.filter((t) => t.quote).length}/${universe.constituents.length} quoted, ` +
      `index ${snapshot.index ? snapshot.index.level.toFixed(0) + (snapshot.index.synthetic ? " (synthetic)" : "") : "n/a"}`,
  );

  const priceOf: PriceLookup = (tk) => snapshot.tickers.find((t) => t.ticker === tk)?.quote?.price ?? null;
  persistPrices(snapshot);

  let portfolio = readPortfolio();

  // First-ever cycle: stamp inception + benchmark baseline.
  if (!portfolio.inceptionDate) {
    portfolio.inceptionDate = nowCairo.toISO();
    portfolio.inceptionBenchmarkIndexLevel = snapshot.index?.level ?? null;
    log(`inception stamped: ${portfolio.inceptionDate}, benchmark index ${portfolio.inceptionBenchmarkIndexLevel ?? "n/a"}`);
  }

  // Holiday / outage guard: too little data to trade on.
  const quoted = snapshot.tickers.filter((t) => t.quote).length;
  if (quoted < Math.ceil(universe.constituents.length * 0.5)) {
    ghError(`only ${quoted} quotes — treating as market-closed/outage, skipping trade decision`);
    portfolio.nav = computeNav(portfolio, priceOf);
    portfolio.lastUpdated = nowCairo.toISO();
    writePortfolio(portfolio);
    writeSkipDecision(id, nowCairo, mode, session.label, snapshot, portfolio, `insufficient data (${quoted} quotes)`);
    writeEquity(id, nowCairo, portfolio, snapshot, policy.startingCashEgp);
    return;
  }

  const navBefore = computeNav(portfolio, priceOf);
  portfolio.nav = navBefore;

  // ---- LLM ----
  let mockCtx = { portfolio, snapshot };
  const llmChain = getLlmProviderChain(() => mockCtx);
  const promptText = buildPrompt({
    policy,
    portfolio,
    snapshot,
    recentDecisions: recentDecisions(config.decisionContextWindow),
  });

  let llm: LlmResult | null = null;
  const llmErrors: string[] = [];
  for (const provider of llmChain) {
    try {
      log(`calling LLM: ${provider.name} (${provider.model})`);
      llm = await provider.decide(promptText);
      log(`LLM ${provider.name} returned ${llm.actions.length} proposed action(s)`);
      break;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      llmErrors.push(`${provider.name}: ${m}`);
      ghError(`LLM ${provider.name} failed: ${m}`);
    }
  }

  if (!llm) {
    ghError("all LLM providers failed — recording a no-trade cycle");
    portfolio.lastUpdated = nowCairo.toISO();
    writePortfolio(portfolio);
    writeSkipDecision(
      id,
      nowCairo,
      mode,
      session.label,
      snapshot,
      portfolio,
      `LLM unavailable: ${llmErrors.join(" | ")}`,
    );
    writeEquity(id, nowCairo, portfolio, snapshot, policy.startingCashEgp);
    return;
  }

  // ---- guardrails + ledger ----
  const outcome = applyGuardrails({
    portfolio,
    proposals: llm.actions,
    snapshot,
    policy,
    nowIso: nowCairo.toISO() ?? new Date().toISOString(),
    cycleId: id,
  });
  portfolio = outcome.finalPortfolio;
  mockCtx = { portfolio, snapshot };

  const executed = outcome.trades.map((t) => ({
    ticker: t.ticker,
    action: t.action,
    qty: t.qty,
    price: t.price,
    fees: t.fees,
  }));
  log(
    `guardrails: ${outcome.adjustments.filter((a) => a.kind === "accepted").length} accepted, ` +
      `${outcome.adjustments.filter((a) => a.kind === "clamped").length} clamped, ` +
      `${outcome.adjustments.filter((a) => a.kind === "rejected").length} rejected — ${executed.length} fill(s) booked`,
  );

  const navAfter = computeNav(portfolio, priceOf);
  portfolio.nav = navAfter;
  portfolio.lastUpdated = nowCairo.toISO();

  const entry: DecisionEntry = {
    cycleId: id,
    timestamp: nowCairo.toISO() ?? new Date().toISOString(),
    mode,
    session: session.label,
    marketSummary: marketSummary(snapshot),
    llmProvider: llm.provider,
    dataProvider: snapshot.provider,
    marketRead: llm.marketRead,
    llmRaw: llm.raw,
    proposedActions: llm.actions,
    guardrailAdjustments: outcome.adjustments,
    executedActions: executed,
    navBefore,
    navAfter,
    cash: portfolio.cash,
    error: [...dataErrors.slice(0, 3), ...llmErrors].join(" | ") || null,
  };

  if (!config.dryRun) {
    writePortfolio(portfolio);
    if (outcome.trades.length) appendTrades(outcome.trades);
    appendDecision(entry);
    writeEquity(id, nowCairo, portfolio, snapshot, policy.startingCashEgp);
  } else {
    log("DRY_RUN — not writing state files");
  }

  log(
    `done. NAV ${navBefore.toFixed(0)} -> ${navAfter.toFixed(0)} EGP, cash ${portfolio.cash.toFixed(0)}, ` +
      `${portfolio.holdings.length} holding(s), missing quotes: ${missing.join(",") || "none"}`,
  );
}

function persistPrices(s: MarketSnapshot): void {
  if (config.dryRun) return;
  const snap: PriceSnapshot = {
    asOf: s.asOf,
    provider: s.provider,
    index: s.index ? { level: s.index.level, synthetic: s.index.synthetic ?? false } : null,
    indexChange5dPct: s.indexChange5dPct,
    indexChange20dPct: s.indexChange20dPct,
    quotes: {},
  };
  for (const t of s.tickers) {
    if (t.quote) {
      snap.quotes[t.ticker] = {
        price: t.quote.price,
        asOf: t.quote.asOf,
        change5dPct: t.change5dPct,
        change20dPct: t.change20dPct,
      };
    }
  }
  writePrices(snap);
}

function marketSummary(s: MarketSnapshot): string {
  const up = s.tickers.filter((t) => (t.change5dPct ?? 0) > 0).length;
  return `${s.tickers.filter((t) => t.quote).length} quoted; ${up}/${s.tickers.length} up over 5d; EGX30 ${
    s.index ? s.index.level.toFixed(0) : "n/a"
  } (5d ${s.indexChange5dPct?.toFixed(1) ?? "n/a"}%)`;
}

function writeEquity(
  id: string,
  now: DateTime,
  portfolio: Portfolio,
  snapshot: MarketSnapshot,
  startingCash: number,
): void {
  if (config.dryRun) return;
  const point: EquityPoint = {
    timestamp: now.toISO() ?? new Date().toISOString(),
    cycleId: id,
    nav: portfolio.nav,
    cash: portfolio.cash,
    benchmarkNav: benchmarkNav(portfolio, snapshot, startingCash),
    indexLevel: snapshot.index?.level ?? null,
  };
  appendEquityPoint(point);
}

function writeSkipDecision(
  id: string,
  now: DateTime,
  mode: "trade" | "eod",
  session: string,
  snapshot: MarketSnapshot,
  portfolio: Portfolio,
  reason: string,
): void {
  if (config.dryRun) return;
  const entry: DecisionEntry = {
    cycleId: id,
    timestamp: now.toISO() ?? new Date().toISOString(),
    mode,
    session,
    marketSummary: marketSummary(snapshot),
    llmProvider: null,
    dataProvider: snapshot.provider,
    marketRead: `No trade decision this cycle — ${reason}.`,
    llmRaw: null,
    proposedActions: [],
    guardrailAdjustments: [],
    executedActions: [],
    navBefore: portfolio.nav,
    navAfter: portfolio.nav,
    cash: portfolio.cash,
    error: reason,
  };
  appendDecision(entry);
}

async function runEod(
  id: string,
  now: DateTime,
  startingCash: number,
  universe: ReturnType<typeof loadUniverse>,
): Promise<void> {
  log("EOD mark-to-market snapshot");
  const marketChain = getMarketProviderChain();
  const { snapshot } = await gatherMarketData(universe, marketChain, config.historyDays);
  const priceOf: PriceLookup = (tk) => snapshot.tickers.find((t) => t.ticker === tk)?.quote?.price ?? null;
  persistPrices(snapshot);

  let portfolio = readPortfolio();
  if (!portfolio.inceptionDate) {
    log("no inception yet — nothing to mark. exiting.");
    return;
  }
  portfolio.nav = computeNav(portfolio, priceOf);
  portfolio.lastUpdated = now.toISO();

  const totalReturnPct = ((portfolio.nav - startingCash) / startingCash) * 100;
  const entry: DecisionEntry = {
    cycleId: id,
    timestamp: now.toISO() ?? new Date().toISOString(),
    mode: "eod",
    session: "end-of-day wrap-up",
    marketSummary: marketSummary(snapshot),
    llmProvider: null,
    dataProvider: snapshot.provider,
    marketRead:
      `End of day. NAV ${portfolio.nav.toFixed(0)} EGP (${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}% since inception), ` +
      `cash ${portfolio.cash.toFixed(0)}, ${portfolio.holdings.length} holding(s). No trade decision in the EOD cycle.`,
    llmRaw: null,
    proposedActions: [],
    guardrailAdjustments: [],
    executedActions: [],
    navBefore: portfolio.nav,
    navAfter: portfolio.nav,
    cash: portfolio.cash,
    error: null,
  };

  if (!config.dryRun) {
    writePortfolio(portfolio);
    appendDecision(entry);
    writeEquity(id, now, portfolio, snapshot, startingCash);
  }
  log(`EOD done. NAV ${portfolio.nav.toFixed(0)} EGP, ${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%`);
}

main().catch((err) => {
  ghError(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
