import { DateTime } from "luxon";
import { config, loadStrategies, loadUniverse, policyFor, strategyDir } from "./config.js";
import { filterSnapshot, gatherMarketData } from "./marketData.js";
import { applyGuardrails } from "./policy.js";
import { computeNav, type PriceLookup } from "./ledger.js";
import { buildPrompt } from "./prompt.js";
import { getLlmProviderChain } from "./providers/llm/index.js";
import { getMarketProviderChain } from "./providers/market/index.js";
import { CAIRO_TZ, checkSession, tradingDaysBetween } from "./session.js";
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
  Policy,
  Portfolio,
  PriceSnapshot,
  StrategyDef,
  UniverseEntry,
} from "./types.js";

const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
const ghError = (msg: string): void => console.log(`::error::${msg}`);

function cycleId(now: DateTime, id: string, mode: string): string {
  return `${now.toFormat("yyyyLLdd'T'HHmm")}-${id}-${mode}`;
}

function nowIso(now: DateTime): string {
  return now.toISO() ?? new Date().toISOString();
}

async function main(): Promise<void> {
  const registry = loadStrategies();
  if (registry.strategies.length === 0) {
    ghError("no strategies to run (check state/strategies.json / STRATEGY filter)");
    return;
  }

  const nowCairo = DateTime.now().setZone(CAIRO_TZ);
  const session = checkSession(nowCairo);
  const mode: "trade" | "eod" = config.mode;

  log(
    `run — Cairo ${nowCairo.toFormat("ccc yyyy-LL-dd HH:mm")} — ${session.label} — ` +
      `strategies: ${registry.strategies.map((s) => s.id).join(", ")} — mode ${mode}`,
  );

  let effectiveMode: "trade" | "eod" = mode;
  if (!config.forceSession) {
    if (mode === "trade" && !session.isOpen) {
      if (session.isEodWindow) {
        log("outside trade session but in EOD window — switching to mark-to-market");
        effectiveMode = "eod";
      } else {
        log(`no-op: ${session.label}`);
        return;
      }
    }
    if (mode === "eod" && !session.isTradingDay) {
      log(`no-op: ${session.label} (EOD)`);
      return;
    }
  }

  // ---- one shared market snapshot for the union of all strategy universes ----
  const universes = new Map(registry.strategies.map((s) => [s.universe, loadUniverse(s.universe)]));
  const unionByTicker = new Map<string, UniverseEntry>();
  for (const u of universes.values()) {
    for (const c of u.constituents) if (!unionByTicker.has(c.ticker)) unionByTicker.set(c.ticker, c);
  }
  const indexSymbol = [...universes.values()][0]?.indexSymbol ?? "EGX30";

  const marketChain = getMarketProviderChain();
  log(
    `market providers: ${marketChain.map((p) => p.name).join(" -> ")} — fetching ${unionByTicker.size} tickers`,
  );
  const { snapshot: unionSnapshot, errors: dataErrors, missing } = await gatherMarketData(
    [...unionByTicker.values()],
    indexSymbol,
    marketChain,
    config.historyDays,
  );
  if (dataErrors.length) log(`market data warnings (${dataErrors.length}): ${dataErrors.slice(0, 4).join(" | ")}`);
  log(
    `snapshot: ${unionSnapshot.tickers.filter((t) => t.quote).length}/${unionByTicker.size} quoted, ` +
      `index ${unionSnapshot.index ? unionSnapshot.index.level.toFixed(0) + (unionSnapshot.index.synthetic ? " (synthetic)" : "") : "n/a"}` +
      (missing.length ? `, missing: ${missing.slice(0, 8).join(",")}${missing.length > 8 ? "…" : ""}` : ""),
  );

  for (const def of registry.strategies) {
    const uni = universes.get(def.universe)!;
    try {
      if (effectiveMode === "eod") {
        await runEod(def, uni.constituents, unionSnapshot, nowCairo, dataErrors);
      } else {
        await runCycle(def, uni.constituents, unionSnapshot, nowCairo, session.label, dataErrors);
      }
    } catch (err) {
      ghError(`strategy ${def.id} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }

  log("run complete");
}

interface StrategyCtx {
  def: StrategyDef;
  dir: string;
  policy: Policy;
  snapshot: MarketSnapshot;
  priceOf: PriceLookup;
  now: DateTime;
}

function prepare(
  def: StrategyDef,
  constituents: UniverseEntry[],
  unionSnapshot: MarketSnapshot,
  now: DateTime,
): StrategyCtx {
  const tickerSet = new Set(constituents.map((c) => c.ticker));
  const snapshot = filterSnapshot(unionSnapshot, tickerSet);
  const priceOf: PriceLookup = (tk) => snapshot.tickers.find((t) => t.ticker === tk)?.quote?.price ?? null;
  return { def, dir: strategyDir(def.id), policy: policyFor(def), snapshot, priceOf, now };
}

function persistPrices(dir: string, s: MarketSnapshot): void {
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
  writePrices(dir, snap);
}

function marketSummary(s: MarketSnapshot): string {
  const up = s.tickers.filter((t) => (t.change5dPct ?? 0) > 0).length;
  return `${s.tickers.filter((t) => t.quote).length} quoted; ${up}/${s.tickers.length} up over 5d; EGX30 ${
    s.index ? s.index.level.toFixed(0) : "n/a"
  } (5d ${s.indexChange5dPct?.toFixed(1) ?? "n/a"}%)`;
}

function benchmarkNav(portfolio: Portfolio, s: MarketSnapshot, startingCash: number): number | null {
  if (!s.index || !portfolio.inceptionBenchmarkIndexLevel) return null;
  return Number(((s.index.level / portfolio.inceptionBenchmarkIndexLevel) * startingCash).toFixed(2));
}

function writeEquity(ctx: StrategyCtx, id: string, portfolio: Portfolio): void {
  if (config.dryRun) return;
  const point: EquityPoint = {
    timestamp: nowIso(ctx.now),
    cycleId: id,
    nav: portfolio.nav,
    cash: portfolio.cash,
    benchmarkNav: benchmarkNav(portfolio, ctx.snapshot, ctx.def.startingCashEgp),
    indexLevel: ctx.snapshot.index?.level ?? null,
  };
  appendEquityPoint(ctx.dir, point);
}

function stampInception(portfolio: Portfolio, ctx: StrategyCtx): void {
  if (portfolio.inceptionDate) return;
  portfolio.inceptionDate = nowIso(ctx.now);
  portfolio.inceptionBenchmarkIndexLevel = ctx.snapshot.index?.level ?? null;
  log(
    `[${ctx.def.id}] inception stamped ${portfolio.inceptionDate}, benchmark index ${
      portfolio.inceptionBenchmarkIndexLevel ?? "n/a"
    }`,
  );
}

async function runCycle(
  def: StrategyDef,
  constituents: UniverseEntry[],
  unionSnapshot: MarketSnapshot,
  now: DateTime,
  sessionLabel: string,
  dataErrors: string[],
): Promise<void> {
  const ctx = prepare(def, constituents, unionSnapshot, now);
  const { dir, policy, snapshot, priceOf } = ctx;
  const id = cycleId(now, def.id, "trade");

  let portfolio = readPortfolio(dir);
  stampInception(portfolio, ctx);

  const quoted = snapshot.tickers.filter((t) => t.quote).length;
  if (quoted < Math.ceil(constituents.length * 0.5)) {
    ghError(`[${def.id}] only ${quoted}/${constituents.length} quotes — skipping trade decision`);
    portfolio.nav = computeNav(portfolio, priceOf);
    portfolio.lastUpdated = nowIso(now);
    if (!config.dryRun) {
      persistPrices(dir, snapshot);
      writePortfolio(dir, portfolio);
      appendDecision(dir, skipEntry(id, now, sessionLabel, snapshot, portfolio, `insufficient data (${quoted} quotes)`));
      writeEquity(ctx, id, portfolio);
    }
    return;
  }

  persistPrices(dir, snapshot);
  const navBefore = computeNav(portfolio, priceOf);
  portfolio.nav = navBefore;

  let mockCtx = { portfolio, snapshot };
  const llmChain = getLlmProviderChain(() => mockCtx);
  const promptText = buildPrompt({
    profile: def.profile,
    universeLabel: def.universe.toUpperCase(),
    policy,
    portfolio,
    snapshot,
    recentDecisions: recentDecisions(dir, config.decisionContextWindow),
    daysHeld: (openedAt) => tradingDaysBetween(openedAt, nowIso(now)),
  });

  let llm: LlmResult | null = null;
  const llmErrors: string[] = [];
  for (const provider of llmChain) {
    try {
      log(`[${def.id}] calling LLM: ${provider.name} (${provider.model})`);
      llm = await provider.decide(promptText);
      log(`[${def.id}] LLM ${provider.name} → ${llm.actions.length} proposed action(s)`);
      break;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      llmErrors.push(`${provider.name}: ${m}`);
      ghError(`[${def.id}] LLM ${provider.name} failed: ${m}`);
    }
  }

  if (!llm) {
    ghError(`[${def.id}] all LLM providers failed — no-trade cycle`);
    portfolio.lastUpdated = nowIso(now);
    if (!config.dryRun) {
      writePortfolio(dir, portfolio);
      appendDecision(dir, skipEntry(id, now, sessionLabel, snapshot, portfolio, `LLM unavailable: ${llmErrors.join(" | ")}`));
      writeEquity(ctx, id, portfolio);
    }
    return;
  }

  const outcome = applyGuardrails({
    portfolio,
    proposals: llm.actions,
    snapshot,
    policy,
    nowIso: nowIso(now),
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
    `[${def.id}] guardrails: ${outcome.adjustments.filter((a) => a.kind === "accepted").length} ok, ` +
      `${outcome.adjustments.filter((a) => a.kind === "clamped").length} clamped, ` +
      `${outcome.adjustments.filter((a) => a.kind === "rejected").length} rejected — ${executed.length} fill(s)`,
  );

  const navAfter = computeNav(portfolio, priceOf);
  portfolio.nav = navAfter;
  portfolio.lastUpdated = nowIso(now);

  const entry: DecisionEntry = {
    cycleId: id,
    timestamp: nowIso(now),
    mode: "trade",
    session: sessionLabel,
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
    error: [...dataErrors.slice(0, 2), ...llmErrors].join(" | ") || null,
  };

  if (!config.dryRun) {
    writePortfolio(dir, portfolio);
    if (outcome.trades.length) appendTrades(dir, outcome.trades);
    appendDecision(dir, entry);
    writeEquity(ctx, id, portfolio);
  } else {
    log(`[${def.id}] DRY_RUN — not writing state`);
  }

  log(
    `[${def.id}] done. NAV ${navBefore.toFixed(0)} → ${navAfter.toFixed(0)} EGP, cash ${portfolio.cash.toFixed(0)}, ${portfolio.holdings.length} holding(s)`,
  );
}

async function runEod(
  def: StrategyDef,
  constituents: UniverseEntry[],
  unionSnapshot: MarketSnapshot,
  now: DateTime,
  _dataErrors: string[],
): Promise<void> {
  const ctx = prepare(def, constituents, unionSnapshot, now);
  const { dir, snapshot, priceOf } = ctx;
  const id = cycleId(now, def.id, "eod");

  const portfolio = readPortfolio(dir);
  if (!portfolio.inceptionDate) {
    log(`[${def.id}] EOD: no inception yet — skipping`);
    return;
  }
  portfolio.nav = computeNav(portfolio, priceOf);
  portfolio.lastUpdated = nowIso(now);

  const totalReturnPct = ((portfolio.nav - def.startingCashEgp) / def.startingCashEgp) * 100;
  const entry: DecisionEntry = {
    cycleId: id,
    timestamp: nowIso(now),
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
    persistPrices(dir, snapshot);
    writePortfolio(dir, portfolio);
    appendDecision(dir, entry);
    writeEquity(ctx, id, portfolio);
  }
  log(`[${def.id}] EOD done. NAV ${portfolio.nav.toFixed(0)} EGP (${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%)`);
}

function skipEntry(
  id: string,
  now: DateTime,
  session: string,
  snapshot: MarketSnapshot,
  portfolio: Portfolio,
  reason: string,
): DecisionEntry {
  return {
    cycleId: id,
    timestamp: nowIso(now),
    mode: "trade",
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
}

main().catch((err) => {
  ghError(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
