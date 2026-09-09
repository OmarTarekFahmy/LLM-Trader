"use client";

import { useMemo, useState } from "react";
import type { ShariaRulings, UniverseEntry } from "@/lib/types";

type Filter = "all" | "compliant" | "excluded" | "review" | "changed";

const MANUAL = "Manual override (Settings)";

export default function Settings({
  rulings,
  universe,
}: {
  rulings: ShariaRulings;
  universe: UniverseEntry[];
}) {
  const base = (t: string): boolean => rulings.rulings[t]?.compliant ?? false;
  const baseBasis = (t: string): string =>
    rulings.rulings[t]?.basis ?? "Not in the EGX 33 Shariah Index; not individually screened.";

  const [local, setLocal] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [token, setToken] = useState<string>(() => {
    try {
      return localStorage.getItem("llm-trader:ghtoken") ?? "";
    } catch {
      return "";
    }
  });
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "ok" | "err"; msg?: string }>({
    kind: "idle",
  });

  const eff = (t: string): boolean => local[t] ?? base(t);
  const changed = useMemo(
    () => universe.filter((c) => local[c.ticker] !== undefined && local[c.ticker] !== base(c.ticker)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [local, universe],
  );
  const compliantCount = universe.filter((c) => eff(c.ticker)).length;

  const rows = universe
    .filter((c) => {
      const on = eff(c.ticker);
      if (filter === "compliant") return on;
      if (filter === "excluded") return !on;
      if (filter === "review") return !base(c.ticker) && baseBasis(c.ticker).includes("Review candidate");
      if (filter === "changed") return changed.some((x) => x.ticker === c.ticker);
      return true;
    })
    .sort((a, b) => {
      const d = Number(eff(b.ticker)) - Number(eff(a.ticker));
      return d !== 0 ? d : a.ticker.localeCompare(b.ticker);
    });

  function toggle(t: string) {
    setLocal((p) => ({ ...p, [t]: !eff(t) }));
    setStatus({ kind: "idle" });
  }
  function discard() {
    setLocal({});
    setStatus({ kind: "idle" });
  }

  function fullDoc() {
    const out: Record<string, { compliant: boolean; basis: string }> = {};
    for (const c of universe) {
      const on = eff(c.ticker);
      out[c.ticker] = {
        compliant: on,
        basis: on === base(c.ticker) ? baseBasis(c.ticker) : MANUAL,
      };
    }
    return out;
  }

  async function save() {
    const r = fullDoc();
    setStatus({ kind: "busy" });
    try {
      localStorage.setItem("llm-trader:ghtoken", token.trim());
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch("/api/sharia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), rulings: r }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; compliant?: number };
      if (!res.ok || !data.ok) {
        setStatus({ kind: "err", msg: data.error ?? `save failed (${res.status})` });
        return;
      }
      setStatus({
        kind: "ok",
        msg: `Saved (${data.compliant} compliant). The next bot cycle, within ~10 min, will use it.`,
      });
      // fold the changes into the baseline so "changed" clears
      const merged: Record<string, boolean> = {};
      for (const c of universe) merged[c.ticker] = eff(c.ticker);
      rulings.rulings = Object.fromEntries(
        universe.map((c) => [c.ticker, { compliant: merged[c.ticker]!, basis: baseBasis(c.ticker) }]),
      );
      setLocal({});
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : "network error" });
    }
  }

  async function copyJson() {
    const doc = {
      ...rulings,
      rulings: fullDoc(),
      updatedAt: new Date().toISOString(),
      updatedBy: "manual",
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(doc, null, 2) + "\n");
      setStatus({ kind: "ok", msg: "Copied. Commit it to state/sharia.json." });
    } catch {
      setStatus({ kind: "err", msg: "clipboard blocked" });
    }
  }

  const filters: Filter[] = ["all", "compliant", "excluded", "review", "changed"];

  return (
    <>
      <p className="strat-note">
        Sharia-compliance ruling per EGX100 name. Seed is the official EGX 33 Shariah Index
        (board-screened); everything else is excluded, either a clear business-activity prohibition
        or &quot;not individually screened&quot;. The Sharia strategy trades only the names marked
        compliant. Source: {rulings.source || "n/a"}. Last updated{" "}
        {rulings.updatedAt ? new Date(rulings.updatedAt).toISOString().slice(0, 16).replace("T", " ") : "n/a"}
        {rulings.updatedBy ? ` (${rulings.updatedBy})` : ""}.
      </p>

      <div className="stats" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="cell">
          <div className="k">Compliant</div>
          <div className="v">
            {compliantCount}
            <span className="dim"> / {universe.length}</span>
          </div>
        </div>
        <div className="cell">
          <div className="k">Pending changes</div>
          <div className={`v ${changed.length ? "" : "small"}`}>{changed.length}</div>
        </div>
        <div className="cell">
          <div className="k">Index seed</div>
          <div className="v small">EGX 33 Shariah</div>
        </div>
      </div>

      <div className="seg" style={{ marginTop: 20 }}>
        {filters.map((f) => (
          <button
            key={f}
            className={filter === f ? "on" : ""}
            onClick={() => setFilter(f)}
            type="button"
          >
            {f}
            {f === "changed" && changed.length ? ` ${changed.length}` : ""}
          </button>
        ))}
      </div>

      <div className="tbl-wrap" style={{ marginTop: 12 }}>
        <table className="t-settings">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Name</th>
              <th>Sector</th>
              <th>Ruling</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const on = eff(c.ticker);
              const isChanged = local[c.ticker] !== undefined && local[c.ticker] !== base(c.ticker);
              return (
                <tr key={c.ticker}>
                  <td>{c.ticker}</td>
                  <td className="cell-name">{c.name}</td>
                  <td className="cell-name dim">{c.sector}</td>
                  <td>
                    <button
                      type="button"
                      className={`ruling ${on ? "yes" : "no"}${isChanged ? " chg" : ""}`}
                      onClick={() => toggle(c.ticker)}
                      aria-pressed={on}
                    >
                      {on ? "compliant" : "excluded"}
                    </button>
                  </td>
                  <td className="cell-name dim">{isChanged ? MANUAL : baseBasis(c.ticker)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="save-bar">
        <input
          type="password"
          placeholder="GitHub token (contents:write on this repo)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="button" onClick={save} disabled={!changed.length || status.kind === "busy"}>
          {status.kind === "busy" ? "Saving..." : `Save ${changed.length || ""}`.trim()}
        </button>
        <button type="button" className="ghost" onClick={copyJson} disabled={!changed.length}>
          Copy JSON
        </button>
        <button type="button" className="ghost" onClick={discard} disabled={!changed.length}>
          Discard
        </button>
      </div>
      {status.msg && (
        <p className={`save-msg ${status.kind === "err" ? "neg" : "pos"}`}>{status.msg}</p>
      )}
      <p className="save-note">
        Save commits <code>state/sharia.json</code> using the token you paste (kept only in this
        browser). No token, or prefer to commit yourself: use Copy JSON. Screening here is
        business-activity plus the official index, not a substitute for your own reference or a
        scholar&apos;s ruling.
      </p>
    </>
  );
}
