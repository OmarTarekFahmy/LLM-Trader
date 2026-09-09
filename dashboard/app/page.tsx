import {
  getDecisions,
  getEquityCurve,
  getPortfolio,
  getPrices,
  getTrades,
  getUniverse,
  REVALIDATE,
} from "@/lib/state";
import type { DecisionEntry } from "@/lib/types";

export const revalidate = 60;

const egp = (n: number) =>
  new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(n) + " EGP";
const egp2 = (n: number) => new Intl.NumberFormat("en-EG", { maximumFractionDigits: 2 }).format(n);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const sign = (n: number) => (n >= 0 ? "pos" : "neg");

function cairoSessionState(): { open: boolean; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const mins = hour * 60 + minute;
  const tradingDay = !["Fri", "Sat"].includes(wd);
  const open = tradingDay && mins >= 600 && mins <= 855; // 10:00 - 14:15
  return {
    open,
    label: !tradingDay ? "Market closed (weekend)" : open ? "Market open" : "Market closed",
  };
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function ActionList({ d }: { d: DecisionEntry }) {
  return (
    <>
      {d.proposedActions.length > 0 && (
        <div className="small">
          <strong className="muted">Proposed:</strong>
          {d.proposedActions.map((a, i) => (
            <div className="action-line" key={i}>
              <span className={`tag ${a.action}`}>{a.action}</span>{" "}
              {a.action !== "hold" ? `${a.quantity} ` : ""}
              {a.ticker} — {a.rationale}
            </div>
          ))}
        </div>
      )}
      {d.guardrailAdjustments.some((g) => g.kind !== "accepted") && (
        <div className="small" style={{ marginTop: 6 }}>
          <strong className="muted">Guardrail:</strong>
          {d.guardrailAdjustments
            .filter((g) => g.kind !== "accepted")
            .map((g, i) => (
              <div className="action-line" key={i}>
                <span className={`tag ${g.kind}`}>{g.kind}</span> {g.ticker} — {g.reason}
              </div>
            ))}
        </div>
      )}
      <div className="small" style={{ marginTop: 6 }}>
        <strong className="muted">Executed:</strong>{" "}
        {d.executedActions.length === 0
          ? "no trades"
          : d.executedActions
              .map((a) => `${a.action} ${a.qty} ${a.ticker} @ ${egp2(a.price)} (fee ${egp2(a.fees)})`)
              .join("; ")}
      </div>
    </>
  );
}

export default async function Page() {
  const [portfolio, trades, decisions, equity, prices, universe] = await Promise.all([
    getPortfolio(),
    getTrades(),
    getDecisions(),
    getEquityCurve(),
    getPrices(),
    getUniverse(),
  ]);

  const startingCash = 100000;
  const priceOf = (t: string) => prices.quotes[t]?.price ?? null;
  const nav =
    portfolio.cash +
    portfolio.holdings.reduce((s, h) => s + (priceOf(h.ticker) ?? h.avgCost) * h.qty, 0);
  const totalReturn = ((nav - startingCash) / startingCash) * 100;

  const lastEquity = equity[equity.length - 1];
  const benchReturn =
    lastEquity?.benchmarkNav != null
      ? ((lastEquity.benchmarkNav - startingCash) / startingCash) * 100
      : null;

  const session = cairoSessionState();
  const feed = [...decisions].reverse().slice(0, 40);
  const tradeLog = [...trades].reverse().slice(0, 50);

  return (
    <main>
      <div className="header">
        <div className="stat">
          <span className="label">NAV</span>
          <span className="value">{egp(nav)}</span>
        </div>
        <div className="stat">
          <span className="label">Total return</span>
          <span className={`value ${sign(totalReturn)}`}>{pct(totalReturn)}</span>
        </div>
        <div className="stat">
          <span className="label">Cash</span>
          <span className="value">{egp(portfolio.cash)}</span>
        </div>
        <div className="stat">
          <span className="label">EGX30 buy &amp; hold</span>
          <span className={`value ${benchReturn == null ? "" : sign(benchReturn)}`}>
            {benchReturn == null ? "—" : pct(benchReturn)}
          </span>
        </div>
        <div className="stat">
          <span className="label">Since</span>
          <span className="value small">{fmtTime(portfolio.inceptionDate)}</span>
        </div>
        <div className="stat">
          <span className="label">Status</span>
          <span className={`pill ${session.open ? "open" : "closed"}`}>{session.label}</span>
        </div>
        <div className="stat">
          <span className="label">Last poll</span>
          <span className="value small">{fmtTime(portfolio.lastUpdated)}</span>
        </div>
      </div>

      <p className="small muted" style={{ marginTop: 12 }}>
        Hands-off LLM paper-trading experiment on the Egyptian Exchange — fake money, real (delayed)
        prices. Universe: {universe.constituents.length} EGX30 names. Data refreshes ~every{" "}
        {REVALIDATE}s. This is a research project, not investment advice.
      </p>

      <h2>Holdings</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Qty</th>
              <th>Avg cost</th>
              <th>Price</th>
              <th>Mkt value</th>
              <th>Unrealized P&amp;L</th>
              <th>Weight</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.holdings.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No open positions — 100% cash.
                </td>
              </tr>
            )}
            {portfolio.holdings.map((h) => {
              const px = priceOf(h.ticker);
              const mv = (px ?? h.avgCost) * h.qty;
              const pnl = px == null ? null : (px - h.avgCost) * h.qty;
              const pnlPct = px == null ? null : ((px - h.avgCost) / h.avgCost) * 100;
              return (
                <tr key={h.ticker}>
                  <td>{h.ticker}</td>
                  <td>{h.qty}</td>
                  <td>{egp2(h.avgCost)}</td>
                  <td>{px == null ? "—" : egp2(px)}</td>
                  <td>{egp(mv)}</td>
                  <td className={pnl == null ? "" : sign(pnl)}>
                    {pnl == null ? "—" : `${egp(pnl)} (${pnlPct!.toFixed(1)}%)`}
                  </td>
                  <td>{((mv / nav) * 100).toFixed(1)}%</td>
                  <td className="small">{fmtTime(h.openedAt).split(",")[0]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Reasoning feed</h2>
      {feed.length === 0 && <p className="muted">No cycles recorded yet.</p>}
      {feed.map((d) => (
        <div className="card" key={d.cycleId}>
          <div className="meta">
            <span>{fmtTime(d.timestamp)}</span>
            <span>{d.session}</span>
            <span>data: {d.dataProvider}</span>
            <span>llm: {d.llmProvider ?? "—"}</span>
            <span>
              NAV {egp(d.navBefore)} → {egp(d.navAfter)}
            </span>
            {d.error && <span className="neg">error: {d.error}</span>}
          </div>
          <p className="read">{d.marketRead}</p>
          <ActionList d={d} />
        </div>
      ))}

      <h2>Trade log</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Ticker</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Fees</th>
              <th>Cash after</th>
              <th>NAV after</th>
            </tr>
          </thead>
          <tbody>
            {tradeLog.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No trades executed yet.
                </td>
              </tr>
            )}
            {tradeLog.map((t, i) => (
              <tr key={i}>
                <td className="small">{fmtTime(t.timestamp)}</td>
                <td>{t.ticker}</td>
                <td className={t.action === "buy" ? "pos" : "neg"}>{t.action}</td>
                <td>{t.qty}</td>
                <td>{egp2(t.price)}</td>
                <td>{egp2(t.fees)}</td>
                <td>{egp(t.resultingCash)}</td>
                <td>{egp(t.resultingNav)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Health</h2>
      <div className="card small">
        <div>
          Last cycle: {feed[0] ? `${feed[0].cycleId} — ${fmtTime(feed[0].timestamp)}` : "—"}
        </div>
        <div>Data provider (last): {prices.provider ?? "—"}</div>
        <div>
          LLM provider (last): {feed[0]?.llmProvider ?? "—"}
        </div>
        <div>
          EGX30 level:{" "}
          {prices.index ? `${prices.index.level.toFixed(0)}${prices.index.synthetic ? " (synthetic proxy)" : ""}` : "—"}
        </div>
        <div>Last error: {feed.find((d) => d.error)?.error ?? "none"}</div>
        <div className="muted">
          Scheduler: GitHub Actions cron, every 30 min during the wide UTC window covering EGX hours.
        </div>
      </div>
    </main>
  );
}
