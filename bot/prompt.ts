import type {
  DecisionEntry,
  LlmDecision,
  MarketSnapshot,
  Policy,
  Portfolio,
} from "./types.js";

/** JSON schema handed to the LLM for structured output (Gemini responseSchema / Groq json mode hint). */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    marketRead: {
      type: "string",
      description: "2-4 sentence overall read of EGX conditions right now.",
    },
    actions: {
      type: "array",
      description: "One entry per ticker you want to act on or explicitly hold. Omit tickers you have no view on.",
      items: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          action: { type: "string", enum: ["buy", "sell", "hold"] },
          quantity: {
            type: "integer",
            description: "Whole shares. 0 for hold. Positive for buy/sell (direction comes from `action`).",
          },
          rationale: { type: "string", description: "Why. Required even for hold." },
        },
        required: ["ticker", "action", "quantity", "rationale"],
      },
    },
  },
  required: ["marketRead", "actions"],
} as const;

const POLICY_BLURB = (p: Policy): string =>
  [
    `- Starting capital: ${p.startingCashEgp.toLocaleString()} EGP (paper).`,
    `- Max single position: ${(p.maxPositionPct * 100).toFixed(0)}% of NAV after a buy.`,
    `- Max sector exposure: ${(p.maxSectorPct * 100).toFixed(0)}% of NAV.`,
    `- Minimum holding period: ${p.minHoldingDays} trading days (you cannot sell a position younger than this; the guardrail will reject such sells).`,
    `- Max ${p.maxTradesPerCycle} executed trades per cycle.`,
    `- Always keep >= ${(p.minCashBufferPct * 100).toFixed(0)}% of NAV in cash.`,
    `- Transaction cost ~${((p.costs.commissionPct + p.costs.levyPct) * 100).toFixed(2)}% per fill (both sides).`,
  ].join("\n");

function fmtHoldings(portfolio: Portfolio, snapshot: MarketSnapshot): string {
  if (portfolio.holdings.length === 0) return "  (none — all cash)";
  return portfolio.holdings
    .map((h) => {
      const px = snapshot.tickers.find((t) => t.ticker === h.ticker)?.quote?.price;
      const mv = px ? px * h.qty : null;
      return `  ${h.ticker}: qty ${h.qty}, avgCost ${h.avgCost.toFixed(3)}, opened ${h.openedAt.slice(0, 10)}${
        mv !== null ? `, mkt value ~${mv.toFixed(0)} EGP` : ""
      }`;
    })
    .join("\n");
}

function fmtTickers(snapshot: MarketSnapshot): string {
  return snapshot.tickers
    .map((t) => {
      const q = t.quote ? `${t.quote.price.toFixed(3)} EGP` : "no quote";
      const closes = t.history.slice(-10).map((b) => b.close.toFixed(2)).join(", ");
      const ch5 = t.change5dPct === null ? "n/a" : `${t.change5dPct >= 0 ? "+" : ""}${t.change5dPct.toFixed(1)}%`;
      const ch20 = t.change20dPct === null ? "n/a" : `${t.change20dPct >= 0 ? "+" : ""}${t.change20dPct.toFixed(1)}%`;
      return `  ${t.ticker} (${t.sector}) — ${q} | 5d ${ch5}, 20d ${ch20} | last closes: ${closes}`;
    })
    .join("\n");
}

function fmtSectors(snapshot: MarketSnapshot): string {
  return snapshot.sectors
    .map((s) => {
      const a5 = s.avgChange5dPct === null ? "n/a" : `${s.avgChange5dPct.toFixed(1)}%`;
      const a20 = s.avgChange20dPct === null ? "n/a" : `${s.avgChange20dPct.toFixed(1)}%`;
      return `  ${s.sector}: avg 5d ${a5}, avg 20d ${a20} (${s.tickerCount} names)`;
    })
    .join("\n");
}

function fmtHistory(recent: DecisionEntry[]): string {
  if (recent.length === 0) return "  (no prior cycles)";
  return recent
    .map((d) => {
      const acts = d.executedActions.length
        ? d.executedActions.map((a) => `${a.action} ${a.qty} ${a.ticker} @ ${a.price.toFixed(2)}`).join("; ")
        : "no trades";
      return `  ${d.timestamp.slice(0, 16)} — read: ${d.marketRead.slice(0, 180)} | executed: ${acts}`;
    })
    .join("\n");
}

export function buildPrompt(args: {
  policy: Policy;
  portfolio: Portfolio;
  snapshot: MarketSnapshot;
  recentDecisions: DecisionEntry[];
}): string {
  const { policy, portfolio, snapshot, recentDecisions } = args;
  const totalReturnPct = ((portfolio.nav - policy.startingCashEgp) / policy.startingCashEgp) * 100;

  return `You are a disciplined portfolio manager running a SEMI-LONG-TERM paper strategy on the Egyptian Exchange (EGX). You trade a fixed universe of EGX30 common stocks. Real money is never involved. Prices are delayed (~15 min) and that is acceptable.

Your job each cycle: read the state below and return structured JSON with an overall market read and a list of proposed actions. A deterministic code layer prices, validates and books every fill — you never do the money math. Propose intent; the guardrail clamps or rejects anything that breaks policy, so stay well inside the limits.

PHILOSOPHY
- Semi-long-term. Do not churn. Most cycles should be mostly "hold". Only act on a real, stated thesis.
- You are polled roughly every 30 minutes during market hours. Frequent polling is NOT a reason to trade frequently.
- Diversify. Respect the concentration limits. Keep a cash buffer.
- Prefer a small number of higher-conviction positions over many tiny ones.

INVESTMENT POLICY (enforced in code — proposals that violate get clamped/rejected)
${POLICY_BLURB(policy)}

PORTFOLIO STATE
  Cash: ${portfolio.cash.toFixed(0)} EGP
  NAV: ${portfolio.nav.toFixed(0)} EGP
  Total return since inception: ${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%
  Holdings:
${fmtHoldings(portfolio, snapshot)}

MARKET SNAPSHOT (as of ${snapshot.asOf}, data provider: ${snapshot.provider})
  EGX30 index: ${snapshot.index ? snapshot.index.level.toFixed(0) : "n/a"}${
    snapshot.index?.synthetic ? " (synthetic proxy)" : ""
  } | 5d ${snapshot.indexChange5dPct?.toFixed(1) ?? "n/a"}%, 20d ${snapshot.indexChange20dPct?.toFixed(1) ?? "n/a"}%

  Per ticker (price | trailing returns | recent daily closes):
${fmtTickers(snapshot)}

  Sector aggregates (equal-weight across tracked names):
${fmtSectors(snapshot)}

YOUR RECENT CYCLES (for continuity — do not contradict yourself without a reason)
${fmtHistory(recentDecisions)}

Return JSON matching this shape exactly:
{
  "marketRead": "string",
  "actions": [ { "ticker": "COMI", "action": "buy" | "sell" | "hold", "quantity": <whole shares, 0 for hold>, "rationale": "string" } ]
}
Every action needs a rationale, including holds. If you propose nothing, return an empty actions array with a marketRead explaining why you are standing pat.`;
}

/** Tolerant parse of an LLM JSON payload into an LlmDecision. Throws on unrecoverable shape. */
export function parseLlmJson(text: string): LlmDecision {
  let jsonText = text.trim();
  // strip markdown fences if a model wrapped the JSON
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) jsonText = fence[1]!.trim();
  // if there is leading/trailing prose, grab the outermost braces
  if (!jsonText.startsWith("{")) {
    const first = jsonText.indexOf("{");
    const last = jsonText.lastIndexOf("}");
    if (first >= 0 && last > first) jsonText = jsonText.slice(first, last + 1);
  }

  const obj = JSON.parse(jsonText) as Record<string, unknown>;
  const marketRead = typeof obj.marketRead === "string" ? obj.marketRead : "";
  const rawActions = Array.isArray(obj.actions) ? obj.actions : [];

  const actions = rawActions
    .map((a): LlmDecision["actions"][number] | null => {
      if (typeof a !== "object" || a === null) return null;
      const rec = a as Record<string, unknown>;
      const ticker = typeof rec.ticker === "string" ? rec.ticker.toUpperCase().trim() : "";
      const actionRaw = typeof rec.action === "string" ? rec.action.toLowerCase().trim() : "hold";
      const action = (["buy", "sell", "hold"].includes(actionRaw) ? actionRaw : "hold") as
        | "buy"
        | "sell"
        | "hold";
      const quantity = Math.max(0, Math.floor(Number(rec.quantity) || 0));
      const rationale = typeof rec.rationale === "string" ? rec.rationale : "";
      if (!ticker) return null;
      return { ticker, action, quantity, rationale };
    })
    .filter((a): a is LlmDecision["actions"][number] => a !== null);

  return { marketRead, actions };
}
