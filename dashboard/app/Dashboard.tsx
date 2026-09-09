"use client";

import { useEffect, useState } from "react";
import type { StrategyData } from "@/lib/types";
import StrategyView from "./StrategyView";

const egp0 = (n: number) => new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(n);

function returnPct(d: StrategyData): number {
  const priceOf = (t: string) => d.prices.quotes[t]?.price ?? null;
  const nav =
    d.portfolio.cash +
    d.portfolio.holdings.reduce((s, h) => s + (priceOf(h.ticker) ?? h.avgCost) * h.qty, 0);
  return ((nav - d.def.startingCashEgp) / d.def.startingCashEgp) * 100;
}

export default function Dashboard({
  strategies,
  cadenceMinutes,
}: {
  strategies: StrategyData[];
  cadenceMinutes: number;
}) {
  const ids = strategies.map((s) => s.def.id);
  const [active, setActive] = useState(ids[0] ?? "");

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get("s");
      const fromLs = localStorage.getItem("llm-trader:strategy");
      const pick = [fromUrl, fromLs].find((v) => v && ids.includes(v));
      if (pick) setActive(pick);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choose(id: string) {
    setActive(id);
    try {
      localStorage.setItem("llm-trader:strategy", id);
      const url = new URL(window.location.href);
      url.searchParams.set("s", id);
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* ignore */
    }
  }

  const current = strategies.find((s) => s.def.id === active) ?? strategies[0];
  if (!current) return <p className="muted">No strategies configured.</p>;

  return (
    <>
      <div className="topbar">
        <h1>EGX LLM Paper Trader</h1>
        <span className="small muted">
          {strategies.length} independent simulations · polled every ~{cadenceMinutes} min during EGX
          hours · fake money, real delayed prices
        </span>
      </div>

      <div className="tabs" role="tablist">
        {strategies.map((s) => {
          const r = returnPct(s);
          return (
            <button
              key={s.def.id}
              role="tab"
              aria-selected={s.def.id === current.def.id}
              className={`tab ${s.def.id === current.def.id ? "active" : ""}`}
              onClick={() => choose(s.def.id)}
            >
              <span className="tab-label">{s.def.label}</span>
              <span className={`tab-sub ${r >= 0 ? "pos" : "neg"}`}>
                {r >= 0 ? "+" : ""}
                {r.toFixed(2)}% · {egp0(s.portfolio.cash + s.portfolio.holdings.reduce((a, h) => a + (s.prices.quotes[h.ticker]?.price ?? h.avgCost) * h.qty, 0))} EGP
              </span>
            </button>
          );
        })}
      </div>

      <StrategyView key={current.def.id} data={current} />

      <p className="small muted" style={{ marginTop: 32 }}>
        Research/learning project — not investment advice. Each simulation is fully independent:
        separate cash, ledger, and decision history under <code>state/{current.def.id}/</code>.
      </p>
    </>
  );
}
