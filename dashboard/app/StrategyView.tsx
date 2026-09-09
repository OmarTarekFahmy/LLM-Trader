import type { DecisionEntry, StrategyData } from "@/lib/types";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const egp = (n: number) => `${nf0.format(n)} EGP`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const cls = (n: number) => (n >= 0 ? "pos" : "neg");

function fmtTime(iso: string | null): string {
  if (!iso) return "n/a";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
function fmtDay(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
  }).format(new Date(iso));
}

function Entry({ d }: { d: DecisionEntry }) {
  const adj = d.guardrailAdjustments.filter((g) => g.kind !== "accepted");
  const proposals = d.proposedActions.filter((a) => a.action !== "hold" || d.proposedActions.length <= 2);
  return (
    <div className={`entry ${d.executedActions.length ? "traded" : ""}`}>
      <div className="e-meta">
        <span>{fmtTime(d.timestamp)}</span>
        <span>{d.session}</span>
        <span>data: {d.dataProvider}</span>
        <span>{d.llmProvider ? `${d.llmProvider}${d.llmModel ? ` (${d.llmModel})` : ""}` : "no model"}</span>
        <span>
          {nf0.format(d.navBefore)} → {nf0.format(d.navAfter)}
        </span>
      </div>
      <p className="e-read">{d.marketRead}</p>

      {proposals.length > 0 && (
        <div className="e-block">
          <div className="e-line">
            <span className="lbl">proposed</span>
          </div>
          {proposals.map((a, i) => (
            <div className="e-line" key={i}>
              <span className={`pill ${a.action}`}>{a.action}</span>{" "}
              {a.action !== "hold" ? `${a.quantity} ` : ""}
              {a.ticker}. {a.rationale}
            </div>
          ))}
        </div>
      )}

      {adj.length > 0 && (
        <div className="e-block" style={{ marginTop: 6 }}>
          <div className="e-line">
            <span className="lbl">guardrail</span>
          </div>
          {adj.map((g, i) => (
            <div className="e-line" key={i}>
              <span className={`pill ${g.kind}`}>{g.kind}</span> {g.ticker}. {g.reason}
            </div>
          ))}
        </div>
      )}

      <div className="e-block" style={{ marginTop: 6 }}>
        <div className="e-line">
          <span className="lbl">executed</span>
          {d.executedActions.length === 0
            ? "no trades"
            : d.executedActions
                .map(
                  (a) =>
                    `${a.action} ${a.qty} ${a.ticker} at ${nf2.format(a.price)}, fee ${nf2.format(a.fees)}`,
                )
                .join(";  ")}
        </div>
      </div>
    </div>
  );
}

export default function StrategyView({ data }: { data: StrategyData }) {
  const { def, portfolio, trades, decisions, equity, prices, universeCount } = data;
  const startingCash = def.startingCashEgp;

  const priceOf = (t: string) => prices.quotes[t]?.price ?? null;
  const nav =
    portfolio.cash +
    portfolio.holdings.reduce((s, h) => s + (priceOf(h.ticker) ?? h.avgCost) * h.qty, 0);
  const totalReturn = ((nav - startingCash) / startingCash) * 100;

  const last = equity[equity.length - 1];
  const benchReturn =
    last?.benchmarkNav != null ? ((last.benchmarkNav - startingCash) / startingCash) * 100 : null;

  const feed = [...decisions].reverse().slice(0, 40);
  const tradeLog = [...trades].reverse().slice(0, 60);

  return (
    <>
      <p className="strat-note">
        {def.blurb} Tracking {universeCount} names, {egp(startingCash)} of paper capital.
      </p>

      <div className="stats">
        <div className="cell">
          <div className="k">NAV</div>
          <div className="v">{nf0.format(nav)}</div>
        </div>
        <div className="cell">
          <div className="k">Return</div>
          <div className={`v ${cls(totalReturn)}`}>{pct(totalReturn)}</div>
        </div>
        <div className="cell">
          <div className="k">Cash</div>
          <div className="v">{nf0.format(portfolio.cash)}</div>
        </div>
        <div className="cell">
          <div className="k">vs EGX30 hold</div>
          <div className={`v ${benchReturn == null ? "small" : cls(benchReturn)}`}>
            {benchReturn == null ? "n/a" : pct(benchReturn)}
          </div>
        </div>
        <div className="cell">
          <div className="k">Positions</div>
          <div className="v">{portfolio.holdings.length}</div>
        </div>
        <div className="cell">
          <div className="k">Last poll</div>
          <div className="v small">{fmtTime(portfolio.lastUpdated)}</div>
        </div>
      </div>

      <section className="sec">
        <h2>
          Holdings<span className="count">{portfolio.holdings.length}</span>
        </h2>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Qty</th>
                <th>Avg cost</th>
                <th>Price</th>
                <th>Value</th>
                <th>Unrealized</th>
                <th>Weight</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.holdings.length === 0 && (
                <tr>
                  <td className="empty" colSpan={8}>
                    No open positions, fully in cash.
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
                    <td>{nf0.format(h.qty)}</td>
                    <td>{nf2.format(h.avgCost)}</td>
                    <td>{px == null ? "n/a" : nf2.format(px)}</td>
                    <td>{nf0.format(mv)}</td>
                    <td className={pnl == null ? "" : cls(pnl)}>
                      {pnl == null ? "n/a" : `${pnl >= 0 ? "+" : ""}${nf0.format(pnl)} (${pnlPct!.toFixed(1)}%)`}
                    </td>
                    <td>{((mv / nav) * 100).toFixed(1)}%</td>
                    <td>{fmtDay(h.openedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sec">
        <h2>Reasoning</h2>
        {feed.length === 0 ? (
          <p className="dim">No cycles recorded yet.</p>
        ) : (
          <div className="feed">
            {feed.map((d) => (
              <Entry key={d.cycleId} d={d} />
            ))}
          </div>
        )}
      </section>

      <section className="sec">
        <h2>
          Trades<span className="count">{trades.length}</span>
        </h2>
        <div className="tbl-wrap">
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
                  <td className="empty" colSpan={8}>
                    No trades executed yet.
                  </td>
                </tr>
              )}
              {tradeLog.map((t, i) => (
                <tr key={i}>
                  <td>{fmtTime(t.timestamp)}</td>
                  <td>{t.ticker}</td>
                  <td className={t.action === "buy" ? "side-buy" : "side-sell"}>{t.action}</td>
                  <td>{nf0.format(t.qty)}</td>
                  <td>{nf2.format(t.price)}</td>
                  <td>{nf2.format(t.fees)}</td>
                  <td>{nf0.format(t.resultingCash)}</td>
                  <td>{nf0.format(t.resultingNav)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sec">
        <h2>Health</h2>
        <div className="health">
          <div>
            <span className="k">last cycle</span>{" "}
            {feed[0] ? `${feed[0].cycleId}, ${fmtTime(feed[0].timestamp)}` : "n/a"}
          </div>
          <div>
            <span className="k">data feed</span> {prices.provider ?? "n/a"}
          </div>
          <div>
            <span className="k">llm (last trade cycle)</span>{" "}
            {(() => {
              const t = feed.find((d) => d.llmProvider);
              return t ? `${t.llmProvider}${t.llmModel ? ` (${t.llmModel})` : ""}` : "n/a";
            })()}
          </div>
          <div>
            <span className="k">EGX30 level</span>{" "}
            {prices.index
              ? `${nf0.format(prices.index.level)}${prices.index.synthetic ? ", synthetic proxy" : ""}`
              : "n/a"}
          </div>
          <div>
            <span className="k">last error</span> {feed.find((d) => d.error)?.error ?? "none"}
          </div>
        </div>
      </section>
    </>
  );
}
