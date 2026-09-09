"use client";

import { useEffect, useState } from "react";
import type { StrategyData } from "@/lib/types";
import Sparkline from "./Sparkline";
import StrategyView from "./StrategyView";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function navOf(d: StrategyData): number {
  const priceOf = (t: string) => d.prices.quotes[t]?.price ?? null;
  return (
    d.portfolio.cash +
    d.portfolio.holdings.reduce((s, h) => s + (priceOf(h.ticker) ?? h.avgCost) * h.qty, 0)
  );
}
function returnPct(d: StrategyData): number {
  return ((navOf(d) - d.def.startingCashEgp) / d.def.startingCashEgp) * 100;
}

function cairoClock(): { open: boolean; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const mins = h * 60 + m;
  const tradingDay = !["Fri", "Sat"].includes(wd);
  const open = tradingDay && mins >= 600 && mins <= 855;
  return {
    open,
    label: !tradingDay ? "closed, weekend" : open ? "session open" : "session closed",
  };
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
  const [clock, setClock] = useState<{ open: boolean; label: string }>({
    open: false,
    label: "session closed",
  });

  useEffect(() => {
    setClock(cairoClock());
    const t = setInterval(() => setClock(cairoClock()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      const fromUrl = new URL(window.location.href).searchParams.get("s");
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
  if (!current) return <p className="dim">No strategies configured.</p>;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>EGX LLM Paper Trader</h1>
          <div className="sub">
            {strategies.length} independent simulations, polled every {cadenceMinutes} min during EGX
            hours. Fake money, real delayed prices.
          </div>
        </div>
        <div className="status">
          <span className={`dot ${clock.open ? "live" : ""}`} />
          {clock.label}
        </div>
      </header>

      <div className="switch" role="tablist" aria-label="Strategy">
        {strategies.map((s) => {
          const r = returnPct(s);
          const nav = navOf(s);
          const curve = s.equity.map((p) => p.nav);
          return (
            <button
              key={s.def.id}
              role="tab"
              aria-selected={s.def.id === current.def.id}
              onClick={() => choose(s.def.id)}
            >
              <div className="s-top">
                <span className="s-name">{s.def.label}</span>
                <span className={`s-ret ${r >= 0 ? "pos" : "neg"}`}>
                  {r >= 0 ? "+" : ""}
                  {r.toFixed(2)}%
                </span>
              </div>
              <div className="s-bot">
                <span className="s-nav">{nf0.format(nav)} EGP</span>
                <Sparkline values={curve} color={r >= 0 ? "var(--gain)" : "var(--loss)"} />
              </div>
            </button>
          );
        })}
      </div>

      <StrategyView key={current.def.id} data={current} />

      <p className="foot">
        Research and learning project, not investment advice. Each simulation is fully independent:
        separate cash, ledger and decision history under <code>state/{current.def.id}/</code>. Prices
        are delayed and sourced from a single free feed. Nothing here implies anything about
        real-money results.
      </p>
    </>
  );
}
