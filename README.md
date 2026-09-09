# EGX LLM Paper Trader

A hands-off experiment: on a schedule during Egyptian Exchange (EGX) hours, a bot feeds an LLM
the current paper portfolio plus recent price/volatility/sector history, asks it to buy/sell/hold
under a written policy, books the surviving actions into a **paper** ledger (fake money, real
delayed prices), commits everything — reasoning included — as JSON to this repo, and a Next.js
dashboard on Vercel renders it.

It now runs **two independent simulations side by side**, switchable in the dashboard:

| Strategy | Universe | Style |
|---|---|---|
| **Core** | EGX30 (30 names) | Semi-long-term. Min 5 trading-day holds, ≤2 trades/cycle, low turnover. |
| **Swing** | ~EGX100 (91 liquid names) | Active. No minimum hold, ≤3 trades/cycle. Aims for ~+2–3% per position over 1–2 weeks, cuts losers around −3–4%. All exits are the model's call. |

Each has its own cash, ledger, decision log and equity curve under `state/<id>/`. Both are polled
every ~10 minutes during the session.

**No brokerage, no execution, no real funds, ever.** See [the spec](./egx-llm-paper-trader-spec.md).

**Live:** the `trade-cycle` workflow runs on schedule and commits `state/` here. Deploy the
dashboard to Vercel (Root Directory `dashboard`, env var
`STATE_BASE_URL=https://raw.githubusercontent.com/OmarTarekFahmy/LLM-Trader/main/state`).

---

## Status

| Piece | State |
|---|---|
| Two independent strategies (core + swing), shared market fetch | ✅ `state/strategies.json`, `bot/index.ts` |
| Hardcoded universes + sectors | ✅ `state/universes/egx30.json`, `egx100.json` |
| Deterministic guardrail + ledger layer | ✅ `bot/policy.ts`, `bot/ledger.ts` (unit-tested) |
| LLM: OpenRouter primary, Gemini + Groq fallback | ✅ chain, per-provider fallback |
| Market data: Yahoo Finance (no key) | ✅ `bot/providers/market/yahoo.ts` |
| GitHub Actions cron every 10 min + EOD wrap-up | ✅ `.github/workflows/trade-cycle.yml` |
| Dashboard with a strategy switcher | ✅ `dashboard/` |
| Full cycle end to end & committing | ✅ verified live for both strategies |

Not yet built: NAV chart with benchmark overlay, EGX holiday calendar, constituent auto-refresh,
backtest mode, a second market-data provider.

---

## Decisions made during the build (spec §2: "make the reasonable call, note it")

1. **Market data: Yahoo Finance, not EGXAPI or Twelve Data.** Build-time checks (2026-09-09):
   - **EGXAPI** — `api.egxapi.com` returns Cloudflare error 1033 (no origin) on every endpoint;
     it's also an *order* API, not a price feed. Unusable. Kept as a stub.
   - **Twelve Data** — the free plan returns *"available starting with the Pro plan"* for every
     EGX symbol (verified with a real key). Pro is paid → breaks the zero-cost constraint. Wired
     as an opt-in fallback (`USE_TWELVEDATA=1`) that only helps on a paid plan.
   - **Yahoo Finance** — EGX equities as `<TICKER>.CA`, index as `^CASE30`, EGP, no key, prices
     matching the live market. Primary provider. Its `meta.regularMarketPrice`/`instrumentType`
     are unreliable for EGX, so we take the last daily close as the (delayed, spec-approved)
     quote and trust the curated universe over its labels.
2. **Two concurrent strategies.** The user asked to keep the original strategy and fork a second,
   more active one alongside it. `state/strategies.json` is the registry; each strategy carries
   its own `policy` and `universe` there. One shared market snapshot per cycle (union of both
   universes) feeds both, so Yahoo is hit once, not twice.
3. **Swing universe ≈ EGX100.** = EGX30 + EGX70-EWI components (investing.com, 2026-09-09), minus
   8 names with no usable Yahoo history → 91 names. Sector tags are coarse hand assignments used
   only for the concentration cap.
4. **Swing exits are LLM-only** (user's choice). `minHoldingDays: 0`; the `targetGainPct` /
   `softStopPct` in the swing policy are surfaced in the prompt as guidance, never auto-executed.
5. **LLM: OpenRouter primary** (`google/gemma-4-26b-a4b-it:free` by default), then Gemini
   (`gemini-flash-latest` → `gemini-flash-lite-latest`), then Groq (`openai/gpt-oss-120b`). Each
   is used only if its key is set; the spec's `gemini-2.5-flash` / `llama-3.3-70b-versatile` are
   retired.
6. **`git commit` happens in the workflow, not the bot.** Keeps local/dry runs commit-free.
7. **Added `state/<id>/prices.json`** — a per-cycle quote+index snapshot so the dashboard values
   holdings without its own API calls.
8. **Transaction costs:** 0.05% commission + 0.05% levy = 0.10% per fill, both sides (0.20% round
   trip), inside the spec's band. Per-strategy in `state/strategies.json`.
9. **EGX30 index level:** Yahoo `^CASE30`; a synthetic equal-weight proxy (flagged
   `synthetic: true`) if it's ever unavailable. The buy-and-hold benchmark uses whatever series
   is available, consistently, from each strategy's inception.
10. **End-of-day cycle** (spec §5): the `30 12 * * *` cron runs `MODE=eod` — a mark-to-market
    snapshot + LLM-free wrap-up per strategy.
11. **Offline mock providers** (`MOCK_LLM`, `MOCK_MARKET`) for keyless end-to-end testing.

Spec §1–§2 hard constraints not touched *except* where the user directed it: the swing strategy's
universe (EGX100) and cadence (10 min) were explicit requests; the 100,000 EGP start, paper-only
and free-tier-only rules are unchanged, and Core still tracks EGX30.

---

## Repo layout

```
bot/                     TypeScript bot (GitHub Actions via tsx, no build step)
  index.ts               entrypoint: session gate -> shared market fetch -> per-strategy cycle
  config.ts              loads strategies.json + universes
  session.ts             Africa/Cairo session check + trading-day counting (luxon)
  marketData.ts          shared snapshot, short-term signals, sector aggregates, filterSnapshot
  prompt.ts              per-profile prompt assembly + response schema + tolerant parser
  policy.ts              guardrail validation / clamping / rejection
  ledger.ts              deterministic fill + fee + NAV math
  providers/llm/         openrouter.ts, gemini.ts, groq.ts, mock.ts, index.ts (chain + fallback)
  providers/market/      yahoo.ts (primary), twelvedata.ts + egxapi.ts (unusable free), mock.ts
  cycle.test.ts          unit tests (node --test)
state/
  strategies.json        registry: cadence + [{id,label,universe,profile,policy}]
  universes/             egx30.json, egx100.json
  core/  swing/           portfolio / trades / decisions / equity_curve / prices  (per strategy)
.github/workflows/trade-cycle.yml
dashboard/               Next.js App Router app for Vercel (strategy switcher)
scripts/bootstrap-github.sh
```

---

## Setup

1. **Public repo** (`gh repo create LLM-Trader --public --source . --remote origin --push`) —
   public = unlimited free Actions minutes.
2. **API keys** (free): `OPENROUTER_API_KEY` ([openrouter.ai/keys](https://openrouter.ai/keys)) is
   the primary LLM. `GEMINI_API_KEY` ([aistudio.google.com/apikey](https://aistudio.google.com/apikey))
   and `GROQ_API_KEY` ([console.groq.com/keys](https://console.groq.com/keys)) are optional
   fallbacks (worth keeping — OpenRouter caps `:free` models around 50 requests/day under $10 of
   lifetime credit, and three strategies on a 10-min cadence run ~80/day). Market data needs no key.
3. **Repo secrets:** Settings → Secrets and variables → Actions. Optional variables
   `OPENROUTER_MODEL` (default `google/gemma-4-26b-a4b-it:free`), `GEMINI_MODEL`, `GROQ_MODEL`.
4. **Settings → Actions → General → Workflow permissions → Read and write.**
5. **First run:** Actions → trade-cycle → Run workflow, `force_session: true`.
6. **Vercel:** import repo, Root Directory `dashboard`, env var
   `STATE_BASE_URL=https://raw.githubusercontent.com/<user>/LLM-Trader/main/state`, deploy.

`scripts/bootstrap-github.sh` does 1–5 from your `.env`.

---

## Local development

```bash
npm install
cp .env.example .env          # GEMINI_API_KEY (+ GROQ_API_KEY) for a real run

npm run cycle:mock            # both strategies, offline deterministic mocks, no writes
npm run test                  # ledger + guardrail unit tests
npm run typecheck

DRY_RUN=1 FORCE_SESSION=1 npm run cycle           # real providers, no writes, ignores session
DRY_RUN=1 FORCE_SESSION=1 STRATEGY=swing npm run cycle   # one strategy only

cd dashboard && npm install && npm run dev        # localhost:3000, reads ../state from disk
```

Switches: `DRY_RUN` `FORCE_SESSION` `MOCK_LLM` `MOCK_MARKET` `MODE=eod` `STRATEGY=<id>`.

---

## How a cycle works

1. Compute Cairo time. Weekend / outside 10:00–14:15 → exit cheaply (unless in the 14:20–15:30
   EOD window → mark-to-market instead).
2. Fetch ~60 daily closes for the **union** of every strategy's universe from Yahoo (one pass,
   throttled). Derive the delayed quote from the latest close; compute 1d/3d/5d/10d/20d changes,
   10-day volatility, distance from 20-day high/low, sector aggregates, and the EGX30 level.
3. For each strategy: narrow the snapshot to its universe; write `state/<id>/prices.json`; if
   <50% of the universe is quoted, record a no-trade cycle and skip.
4. Build the profile-specific prompt (core = "don't churn"; swing = "trade the moves, target
   +2–3%, cut losers") with portfolio state, policy limits, per-ticker signals, and the last 5
   cycles' decisions. Call OpenRouter, then Gemini, then Groq on failure.
5. `applyGuardrails`: sells before buys; reject sells inside `minHoldingDays`; clamp buys to
   `maxPositionPct` / `maxSectorPct` / `minCashBufferPct`; cap at `maxTradesPerCycle`. Every
   proposal logged as accepted / clamped / rejected with a reason.
6. Book surviving fills at the delayed price + costs; recompute NAV; append
   `trades` / `decisions` / `equity_curve`.
7. The workflow commits `state/` back to the repo.

---

## Known limitations (by design)

Paper fills use delayed quotes as the fill price (no slippage/spread). Free LLM/data tiers can
rate-limit or degrade without notice. Yahoo is an unofficial API and the sole market source.
"~+2–3% per 1–2 weeks" is an aspiration the bot chases, not a projection. This is a
research/learning project — nothing here is a validated strategy or investment advice.
