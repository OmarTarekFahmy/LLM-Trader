import type { LlmProvider, LlmResult, MarketSnapshot, Portfolio } from "../../types.js";

/**
 * Deterministic offline "LLM". Enabled with MOCK_LLM=1. It runs a trivial
 * momentum rule so a full cycle produces real proposed actions, guardrail
 * activity and fills without any network call or API key.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock-llm";
  readonly model = "mock-momentum-v1";

  constructor(
    private readonly getContext: () => { portfolio: Portfolio; snapshot: MarketSnapshot },
  ) {}

  async decide(_promptText: string): Promise<LlmResult> {
    const { portfolio, snapshot } = this.getContext();
    const actions: LlmResult["actions"] = [];

    const ranked = [...snapshot.tickers]
      .filter((t) => t.quote && t.change20dPct !== null)
      .sort((a, b) => (b.change20dPct ?? 0) - (a.change20dPct ?? 0));

    const top = ranked[0];
    if (top && (top.change20dPct ?? 0) > 1 && !portfolio.holdings.some((h) => h.ticker === top.ticker)) {
      const budget = portfolio.nav * 0.1;
      const qty = Math.max(1, Math.floor(budget / (top.quote!.price || 1)));
      actions.push({
        ticker: top.ticker,
        action: "buy",
        quantity: qty,
        rationale: `Mock momentum: strongest 20d trend (${top.change20dPct!.toFixed(1)}%) in the universe; open a ~10% NAV starter position.`,
      });
    }

    const worstHeld = portfolio.holdings
      .map((h) => ({ h, t: snapshot.tickers.find((x) => x.ticker === h.ticker) }))
      .filter((x) => x.t && (x.t.change20dPct ?? 0) < -8)
      .sort((a, b) => (a.t!.change20dPct ?? 0) - (b.t!.change20dPct ?? 0))[0];
    if (worstHeld) {
      actions.push({
        ticker: worstHeld.h.ticker,
        action: "sell",
        quantity: worstHeld.h.qty,
        rationale: `Mock momentum: 20d trend broke down (${worstHeld.t!.change20dPct!.toFixed(1)}%); exit.`,
      });
    }

    if (actions.length === 0) {
      const anchor = ranked[0]?.ticker ?? snapshot.tickers[0]?.ticker ?? "COMI";
      actions.push({
        ticker: anchor,
        action: "hold",
        quantity: 0,
        rationale: "Mock momentum: no signal strong enough to act on this cycle; standing pat.",
      });
    }

    const marketRead = `Mock LLM read: EGX30 ${
      snapshot.indexChange20dPct !== null
        ? (snapshot.indexChange20dPct >= 0 ? "up" : "down") + ` ${Math.abs(snapshot.indexChange20dPct).toFixed(1)}% over 20d`
        : "trend unknown"
    }. Deterministic momentum heuristic, no real analysis.`;

    return {
      marketRead,
      actions,
      provider: this.name,
      model: this.model,
      raw: JSON.stringify({ marketRead, actions }, null, 2),
    };
  }
}
