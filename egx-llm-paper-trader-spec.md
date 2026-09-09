# EGX LLM Paper Trader — Build Spec

**Purpose of this document:** hand this to a coding agent (Claude Code, Copilot, etc.) as the complete brief for building the project end to end. It covers architecture, exact tech choices, every external account/API key needed and where to get it, data models, prompt design, scheduling, guardrails, and the dashboard. No execution/brokerage integration is in scope — this is a fully simulated (paper) trader, never touches real money.

---

## 0. What this is, in one paragraph

A small automated system that, on a schedule during EGX trading hours, feeds an LLM the current paper portfolio state plus recent price/sector/market history for a fixed universe of EGX-listed stocks, asks it to decide whether to buy/sell/hold anything under a written investment policy, executes those decisions against an in-memory *paper* ledger (fake money, real prices), and publishes everything — reasoning included — to a single-page dashboard the owner can check anytime. No human interaction is required after initial setup. Everything runs on free tiers.

## 1. Hard constraints (do not deviate without flagging back)

- **Paper trading only.** No brokerage, no execution API, no real funds ever. A JSON ledger simulates cash and positions.
- **Zero ongoing cost.** LLM calls, market data, compute, hosting, and storage must all stay on free tiers.
- **Fully hands-off.** Once deployed, nothing requires the owner to trigger, approve, or babysit a run. The dashboard is read-only observation.
- **Hosted, not local.** Dashboard lives on Vercel's free tier (or equivalent); the scheduler/compute lives on GitHub Actions' free tier (see §4 for why this split, not a single Vercel cron).
- **Delayed data is fine.** 15–30 minute delayed quotes are explicitly acceptable — this is a research/learning experiment about LLM decision quality, not a low-latency system.
- **Universe = individual EGX-listed common equities only.** No mutual funds, ETFs, or other fund-type instruments, even if a data provider's search/lookup surfaces them.
- **The LLM never does money math.** It proposes actions in structured form; a deterministic code layer validates, clamps, prices, and books every fill. This avoids arithmetic hallucination corrupting the ledger.

## 2. Assumptions made on your behalf (flag any of these back if wrong)

- Starting paper capital: **100,000 EGP** (fictional, configurable via one constant).
- Tracked universe: the current **EGX30 index constituents** (most liquid, best data coverage). Hardcode the list + sector tags at build time from EGX's own site, with a comment noting it should be refreshed periodically since index composition changes.
- Trading cadence target: **"semi-long-term"** — the policy enforces a minimum holding period so the bot can't churn positions daily just because it's polled frequently (see §7).
- Poll cadence: **every 30 minutes during EGX trading hours** (see §5) — frequent enough to feel "alive" on the dashboard, far inside every free-tier rate limit, and infrequent enough not to trade on noise.

## 3. Architecture overview

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│   GitHub Actions cron    │  runs  │  bot/ (Node/TypeScript)       │
│  (every 30 min, wide UTC │───────▶│  1. check if EGX session open │
│   window, Sun–Thu)        │        │  2. pull state JSON from repo │
└─────────────────────────┘        │  3. fetch market data (+fallback)
                                     │  4. build prompt, call LLM     │
                                     │     (+ fallback provider)      │
                                     │  5. validate/clamp via policy  │
                                     │  6. book fills into ledger     │
                                     │  7. write updated JSON files   │
                                     │  8. git commit + push          │
                                     └───────────────┬────────────────┘
                                                      │ commits JSON to
                                                      ▼
                                        state/*.json in the same repo
                                                      │ read at request time
                                                      ▼
                                     ┌────────────────────────────────┐
                                     │  Next.js dashboard on Vercel    │
                                     │  fetches raw.githubusercontent  │
                                     │  .com JSON (ISR, ~60s revalidate)│
                                     │  renders NAV chart, holdings,   │
                                     │  decision/reasoning feed, trades│
                                     └────────────────────────────────┘
```

**Why GitHub Actions as the scheduler instead of Vercel Cron:** Vercel's free (Hobby) tier restricts cron job frequency; GitHub Actions has no such restriction and is free and unlimited on **public** repos. **Why JSON-files-in-git as the "database" instead of a hosted DB:** it's genuinely free with no pause/cold-start/quota surprises (unlike free-tier Postgres/Redis services), gives you a free audit trail via git history, and the dashboard can read it with zero backend of its own via `raw.githubusercontent.com` + Next.js ISR — no redeploy needed after every trade cycle. If this later feels limiting, swap `state/` reads/writes for Upstash Redis (generous free tier) without changing anything else in the design.

**Make the repo public.** Nothing sensitive lives in code — all keys are GitHub Actions Secrets, never committed. Public repos get unlimited free Actions minutes; private repos are capped at 2,000 min/month on the free plan, which this project doesn't need but no reason to risk hitting.

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Bot/scheduler runtime | Node.js + TypeScript | One language across bot and dashboard; runs natively in GitHub Actions; trivial `fetch`-based HTTP calls to LLM/data APIs. |
| Scheduler | GitHub Actions (`schedule:` cron trigger) | Free, unlimited on public repos, no separate always-on server needed. |
| State storage | JSON files under `state/` in the repo, committed by the bot | Free, versioned, no external DB service or quotas. |
| Dashboard | Next.js (App Router) + TypeScript, deployed to Vercel free tier | Vercel is built for Next.js; ISR lets it show fresh data without redeploying. |
| Charts | Any lightweight React chart lib (e.g. Recharts) | Keep it simple; one NAV-over-time line chart plus a benchmark line is the main visual. |
| Primary LLM | Google Gemini (`gemini-2.5-flash` or `gemini-2.0-flash`) via Google AI Studio API key | Free tier: 15 requests/min, 1,500 requests/day, 1M tokens/min, no credit card required. At ~10 calls/day this is enormous headroom. Also matches the provider Youssef already uses in his own AiHarness project. |
| Fallback LLM | Groq (`llama-3.3-70b-versatile` or similar) via Groq API key | Free tier: ~30 RPM / 1,000 RPD. Used only if Gemini errors or is rate-limited that cycle. |
| Primary market data | EGXAPI (egxapi.com) — dedicated EGX data/order API, free tier, no card required | Purpose-built for EGX, includes real-time/delayed quotes and historical data. **Verify at build time**: it's a newer, smaller provider — confirm signup works, data is actually live EGX data, and check current documented rate limits before depending on it. Since it's used read-only for prices (no order placement, no funds at risk), the downside of it being unreliable is just "bad data," not lost money — but build the data layer behind an interface (see §6) so swapping providers is a one-file change. |
| Fallback market data | Twelve Data (exchange code `XCAI` for EGX) | Established provider with a free tier; use for historical daily bars and as a backup quote source if EGXAPI is down or doesn't pan out. |

This mirrors a provider-agnostic design on purpose — same idea as keeping wire-format details isolated behind an interface so the core logic never cares which LLM or data vendor is behind it, only cleaner to isolate since free tiers/providers can flake or change.

## 5. Scheduling — exact logic

EGX trading days/hours: **Sunday–Thursday, 10:00–14:15 Cairo local time.** Egypt has reinstated DST in recent years (currently GMT+3 in September; historically GMT+2 in winter), so **never hardcode a fixed UTC offset** — the workflow's cron just needs to fire often enough to cover both possible offsets, and the bot script itself makes the real decision using a timezone-aware check.

- **GitHub Actions cron** (in `.github/workflows/trade-cycle.yml`): fire every 30 minutes across a UTC window wide enough to contain the Cairo session under either offset, every day of the week (cron doesn't need to be clever — the script is):
  ```yaml
  on:
    schedule:
      - cron: '0,30 6-12 * * *'   # every 30 min, 06:00–12:59 UTC, every day
  ```
- **Inside the script**, first thing it does:
  1. Compute current time in `Africa/Cairo` using a timezone-aware library (e.g. `luxon` — `DateTime.now().setZone('Africa/Cairo')`), not a fixed offset.
  2. If weekday is Friday or Saturday → log "market closed (weekend)" and exit cheaply, no LLM/data calls.
  3. If local time is outside 10:00–14:15 → log "market closed (outside session)" and exit cheaply.
  4. Otherwise proceed with the full cycle (§3 steps 2–8).
- Add one extra run ~15 minutes after session close (14:30 Cairo) that does a **mark-to-market snapshot and daily wrap-up** entry (no new trade decision, just records NAV and a short LLM-free summary) so the dashboard has a clean "end of day" marker.
- Skip holiday handling for the MVP — if a data provider returns nothing (market actually closed for a holiday), just log "no data, skipping this cycle" and move on rather than trading on stale numbers. A hardcoded 2026 EGX holiday list is a reasonable v2 addition (pull from egx.com.eg's trading calendar).

At ~9–10 cycles/day, 5 days/week, this is roughly 45–50 LLM calls/week — comfortably inside every free tier above with huge margin for retries.

## 6. Data layer — interface and fields needed

Define one interface, e.g.:

```ts
interface MarketDataProvider {
  getQuote(ticker: string): Promise<{ price: number; asOf: string; delayedMinutes?: number }>;
  getHistoricalDaily(ticker: string, days: number): Promise<{ date: string; close: number; volume?: number }[]>;
  getIndexLevel(indexSymbol: string): Promise<{ level: number; asOf: string }>; // EGX30
}
```

Implement `EgxApiProvider` first (primary), `TwelveDataProvider` second (fallback), both satisfying the same interface. The bot tries primary, falls back on error/timeout to secondary, and logs which one served each cycle (surface this on the dashboard's health panel — it's useful signal).

Per cycle, gather for every tracked ticker: latest (delayed) quote, last ~60 daily closes (for the LLM to reason about trend/momentum), and its sector tag (from the static universe file). Also gather the EGX30 index level and its own recent trend, and compute simple sector-level aggregates (average % change over last 5/20 days per sector) from the tracked tickers themselves — don't depend on a separate sector-index API that may not exist for free.

## 7. Investment policy (the guardrail layer)

Keep this as a small config file (`policy.json`) the code enforces in software — never trust the LLM to self-regulate:

- `startingCashEgp: 100000`
- `maxPositionPct: 0.15` — no single position may exceed 15% of portfolio NAV after a buy.
- `maxSectorPct: 0.35` — no sector may exceed 35% of NAV.
- `minHoldingDays: 5` — a position can't be sold within 5 trading days of being opened (this is what actually enforces "semi-long-term" against a bot that's polled every 30 minutes — without this it will find reasons to churn).
- `maxTradesPerCycle: 2` — caps how many actions get executed in one polling cycle.
- `minCashBufferPct: 0.05` — always keep at least 5% of NAV in cash.
- Simulated transaction costs applied to every fill: a small commission % + a stamp-duty-style levy on trade value (pick small realistic-ish constants, e.g. 0.05–0.15% combined) — without this, paper P&L looks unrealistically clean compared to real trading.

Flow per cycle: LLM proposes actions with reasoning → code validates each proposal against the policy → any that violate get **clamped** (reduce quantity to fit the limit) or **rejected** (with a logged reason) → only what survives gets booked into the ledger at the fetched (delayed) price plus costs. Log all three states — proposed, adjusted, executed — so the dashboard can show "the model wanted X, the guardrail changed it to Y."

## 8. LLM prompt shape

One call per cycle, structured output (use Gemini's JSON mode / function-calling-style schema so parsing is reliable). Feed it:

- Portfolio state: cash, current holdings (ticker, qty, avg cost, days held), NAV.
- Policy limits (so it doesn't propose things certain to be clamped).
- Per tracked ticker: latest delayed quote, recent daily closes, sector.
- EGX30 index level and recent trend.
- Sector aggregates computed in §6.
- A short rolling window of its own last few cycles' decisions/rationale (pull last N entries from `decisions.json`) so it has continuity instead of reasoning from a blank slate every 30 minutes.

Ask for structured JSON back: overall market read (string), and a list of `{ ticker, action: "buy"|"sell"|"hold", quantity, rationale }`. Always require a rationale string even for `hold` — that's what makes the dashboard's "thinking" feed interesting instead of just a trade log.

## 9. State files (`state/` in the repo)

- `universe.json` — static list: ticker, name, sector, for the tracked EGX30 set.
- `portfolio.json` — cash, holdings array (ticker, qty, avgCost, openedAt), NAV, lastUpdated.
- `trades.json` — append-only executed fills: timestamp, ticker, action, qty, price, fees, resultingCash, resultingNav.
- `decisions.json` — append-only full cycle log: timestamp, market snapshot summary, LLM raw reasoning, proposed actions, guardrail adjustments, executed actions, which LLM/data provider served this cycle.
- `equity_curve.json` — one NAV snapshot per cycle (even on `hold`-only cycles) plus a parallel "buy-and-hold EGX30 from day one" benchmark value, for the comparison chart.

## 10. Dashboard (single page)

- Header strip: current NAV, total return %, cash, since-inception date, market open/closed indicator, last poll time.
- NAV-over-time chart with the EGX30 buy-and-hold benchmark overlaid.
- Holdings table: ticker, qty, avg cost, current delayed price, unrealized P&L, weight % of NAV.
- **Reasoning feed** (the centerpiece): reverse-chronological cards, one per cycle, showing timestamp, the LLM's market read, its proposed actions, any guardrail adjustments, and what was actually executed. This is what makes it feel like "watching it think."
- Trade log table (executed fills only), most recent first.
- Health panel: which LLM/data provider served the last cycle, last error if any, next scheduled check.

Read all data via `fetch('https://raw.githubusercontent.com/<owner>/<repo>/main/state/xyz.json', { next: { revalidate: 60 } })` — no backend route needed, no keys required on the Vercel side at all for the MVP.

## 11. Accounts, API keys, and exact env vars

| What | Where to get it | Env var name | Used by |
|---|---|---|---|
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — sign in with Google, create key, no card needed | `GEMINI_API_KEY` | GitHub Actions secret |
| Groq API key (fallback LLM) | [console.groq.com/keys](https://console.groq.com/keys) — free signup | `GROQ_API_KEY` | GitHub Actions secret |
| EGXAPI key (primary market data) | [egxapi.com](https://egxapi.com/) — developer signup; confirm current onboarding flow at build time | `EGXAPI_API_KEY` | GitHub Actions secret |
| Twelve Data key (fallback market data) | [twelvedata.com](https://twelvedata.com/) — free signup | `TWELVEDATA_API_KEY` | GitHub Actions secret |

Add all four in **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**. Also go to **Settings → Actions → General → Workflow permissions** and select **"Read and write permissions"** — required so the workflow can commit the updated `state/*.json` files back to the repo (this uses the automatically-provided `GITHUB_TOKEN`; no extra secret needed for that part).

Vercel needs **no environment variables for the MVP** — the dashboard only reads public JSON from the repo's raw GitHub URL. Just connect the repo in the Vercel dashboard, point it at the Next.js app, deploy.

## 12. Repo structure (suggested)

```
/
├── .github/workflows/trade-cycle.yml
├── bot/
│   ├── index.ts              # entrypoint: session check → cycle → commit
│   ├── providers/
│   │   ├── llm/ (gemini.ts, groq.ts, index.ts — common interface)
│   │   └── market/ (egxapi.ts, twelvedata.ts, index.ts — common interface)
│   ├── policy.ts              # guardrail validation/clamping logic
│   ├── ledger.ts              # deterministic fill/booking math
│   └── prompt.ts              # prompt assembly + response schema
├── state/
│   ├── universe.json
│   ├── portfolio.json
│   ├── trades.json
│   ├── decisions.json
│   └── equity_curve.json
├── policy.json
├── dashboard/                  # Next.js app (or root-level app/, your call)
│   └── app/page.tsx, components/...
└── README.md
```

## 13. Build phases

1. **MVP**: static universe (hardcode EGX30 list + sectors), one LLM provider (Gemini), one data provider (EGXAPI), the guardrail/ledger logic, JSON state files, the GitHub Actions cron, and a bare-bones dashboard (numbers + a table, no chart yet). Get one full cycle running end to end and committing correctly before polishing anything.
2. **Resilience**: add the fallback LLM and fallback data providers, error logging, the health panel.
3. **Polish**: NAV chart with benchmark overlay, the reasoning feed UI, holdings/trades tables, end-of-day wrap-up cycle.
4. **Nice-to-haves (optional, later)**: EGX holiday calendar so cycles don't fire uselessly on holidays; periodic refresh of the EGX30 constituent list; a simple backtest mode that replays the same prompt/policy against historical data before trusting new policy changes.

## 14. Definition of done

- [ ] Workflow fires on schedule and correctly no-ops outside EGX session hours (verify with a manual `workflow_dispatch` test both inside and outside session hours).
- [ ] A full cycle runs end to end: data fetched → LLM called → guardrails applied → ledger updated → JSON committed — with no manual steps.
- [ ] Fallback LLM and fallback data provider both verified to work if you temporarily break/remove the primary key.
- [ ] Dashboard loads with zero required user interaction and reflects the latest committed state within ~60 seconds of a new commit.
- [ ] Reasoning feed shows a rationale for every cycle, including `hold`-only ones.
- [ ] No API key appears anywhere in committed code or client-side dashboard bundle.
- [ ] A week of unattended running produces a plausible, non-crashed trade/decision history.

## 15. Known limitations (by design, not bugs)

- Paper fills use delayed quotes as the fill price — real execution would differ (slippage, spread, true fill price). This is explicitly acceptable per the experiment's goal.
- EGXAPI is a newer/smaller provider; if it turns out unreliable or its free tier changes, the fallback provider and the pluggable interface in §6 are exactly the escape hatch — swap without touching the rest of the system.
- Free LLM tiers can rate-limit or degrade in quality without notice; the fallback provider covers availability, not necessarily identical decision quality.
- This is a research/learning project, not a validated trading strategy — no performance shown here (paper or otherwise) implies anything about real-money results.
