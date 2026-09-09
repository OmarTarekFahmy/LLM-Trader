# EGX LLM Paper Trader

A hands-off experiment: on a schedule during Egyptian Exchange (EGX) hours, a bot feeds an
LLM the current paper portfolio plus recent price/sector/market history for a fixed universe
of EGX30 stocks, asks it to buy/sell/hold under a written policy, books the surviving actions
into a **paper** ledger (fake money, real delayed prices), commits everything — reasoning
included — as JSON to this repo, and a Next.js dashboard on Vercel renders it.

**No brokerage, no execution, no real funds, ever.** See [the spec](./egx-llm-paper-trader-spec.md)
if present, or the section headers below.

---

## Status — MVP (spec §13 phase 1) complete

| Piece | State |
|---|---|
| Hardcoded EGX30 universe + sectors | ✅ `state/universe.json` |
| Deterministic guardrail + ledger layer | ✅ `bot/policy.ts`, `bot/ledger.ts` (unit-tested) |
| One LLM provider (Gemini) | ✅ `bot/providers/llm/gemini.ts` |
| One market-data provider | ✅ **Twelve Data** (`bot/providers/market/twelvedata.ts`) — see decision below |
| JSON state files in git | ✅ `state/*.json` |
| GitHub Actions cron | ✅ `.github/workflows/trade-cycle.yml` |
| Bare-bones dashboard | ✅ `dashboard/` (numbers, holdings, reasoning feed, trade log, health) |
| Full cycle runs end to end & commits | ✅ verified with offline mocks; needs your API keys for a live run |

Not yet built (later phases): fallback LLM/data providers wired in, NAV chart, EGX holiday
calendar, constituent auto-refresh, backtest mode.

---

## Decisions made during the build (spec §2: "make the reasonable call, note it")

1. **Market data: Twelve Data is primary, not EGXAPI.** A build-time check (2026-09-09) found
   `api.egxapi.com` returning Cloudflare error 1033 (no origin) on every endpoint, and the
   product is actually an *order-execution* API, not a read-only price feed — a poor fit for a
   never-real-money project. Per the brief's instruction ("if it doesn't check out, use Twelve
   Data as primary rather than stalling"), Twelve Data serves prices. `EgxApiProvider` is kept
   as a stub (`bot/providers/market/egxapi.ts`) so re-enabling it later is a one-file change.
   Twelve Data confirmed to cover EGX (exchange `EGX` / MIC `XCAI`, currency EGP, tz
   Africa/Cairo) with common stocks.
2. **`git commit` happens in the workflow, not the bot script.** The bot writes `state/*.json`;
   the `Commit updated state` step in the workflow adds/commits/pushes (rebase-safe). Keeps
   local/dry runs from ever creating commits. (Spec §12 sketched it inside `index.ts`.)
3. **Added `state/prices.json`.** A per-cycle snapshot of every universe quote + index level so
   the dashboard can value holdings and show prices without calling a data API itself. Not in
   the spec's file list; it's the cheapest way to satisfy the §10 holdings table.
4. **Universe 30th name.** Investing.com's EGX30 components list showed an ambiguous
   "Valmore Holding" / "Valmore Holding A" pair; used `SWDY` (Elsewedy Electric), a long-time
   EGX30 heavyweight every data provider carries, instead. Refresh the whole list from the EGX
   factsheet after each index review (Feb / Aug) — see the comment in `state/universe.json`.
5. **Transaction costs:** `commissionPct 0.05% + levyPct 0.05% = 0.10%` per fill, both sides,
   inside the spec's 0.05–0.15% band. Editable in `policy.json`.
6. **EGX30 index level:** tries Twelve Data index symbols first; if none resolve on the free
   tier, the bot synthesizes an equal-weight proxy from the tracked universe and flags it
   `synthetic: true` everywhere it surfaces. The buy-and-hold benchmark uses whatever series
   is available, consistently, from inception.
7. **End-of-day cycle** (spec §5) is included in the MVP: the `30 12 * * *` cron runs
   `MODE=eod` — a mark-to-market snapshot + an LLM-free wrap-up entry.
8. **Offline mock providers** (`MOCK_LLM`, `MOCK_MARKET`) exist so the full cycle — guardrails,
   ledger, state writes, dashboard — can be exercised with zero network / keys. This is how the
   MVP end-to-end run was verified.

Anything touching spec §1–§2 hard constraints (100,000 EGP start, EGX30 universe, paper-only,
free-tier-only) was **not** changed.

---

## Repo layout

```
bot/                     TypeScript bot (runs in GitHub Actions via tsx, no build step)
  index.ts               entrypoint: session gate -> gather data -> LLM -> guardrails -> write state
  session.ts             Africa/Cairo timezone-aware session check (luxon)
  marketData.ts          per-cycle data gather + sector aggregates + synthetic index
  prompt.ts              prompt assembly + LLM JSON response schema + tolerant parser
  policy.ts              guardrail validation / clamping / rejection
  ledger.ts              deterministic fill + fee + NAV math
  providers/llm/         gemini.ts, mock.ts, index.ts (chain + fallback)
  providers/market/      twelvedata.ts, egxapi.ts (stub), mock.ts, index.ts
  cycle.test.ts          unit tests (node --test)
state/                   committed JSON "database"
  universe.json portfolio.json trades.json decisions.json equity_curve.json prices.json
policy.json              guardrail config
.github/workflows/trade-cycle.yml
dashboard/               Next.js App Router app for Vercel
```

---

## Setup

### 1. Push this to a **public** GitHub repo named `LLM-Trader`

Public = unlimited free Actions minutes. Nothing secret is in the code.

```bash
gh repo create LLM-Trader --public --source . --remote origin --push
```

### 2. Get the API keys (all free, no card)

| Key | Where | Secret name |
|---|---|---|
| Gemini | https://aistudio.google.com/apikey | `GEMINI_API_KEY` |
| Twelve Data | https://twelvedata.com/ (free signup) | `TWELVEDATA_API_KEY` |
| Groq (later, fallback LLM) | https://console.groq.com/keys | `GROQ_API_KEY` |
| EGXAPI (later, if it comes online) | https://egxapi.com/ | `EGXAPI_API_KEY` |

For the MVP only the first two matter.

### 3. Add them as repo secrets

**Settings → Secrets and variables → Actions → New repository secret** for each.
Optionally add a **variable** `GEMINI_MODEL` (defaults to `gemini-2.5-flash`).

### 4. Allow the workflow to commit

**Settings → Actions → General → Workflow permissions → "Read and write permissions"**.

### 5. First run

**Actions → trade-cycle → Run workflow** with `force_session: true` to prove a full cycle
end to end regardless of the current time. Then run it again with defaults to confirm it
no-ops correctly outside session hours. Check that `state/*.json` got a new commit.

### 6. Deploy the dashboard to Vercel

- Import the repo at https://vercel.com/new
- **Root Directory: `dashboard`**
- Add one env var: `STATE_BASE_URL` =
  `https://raw.githubusercontent.com/<your-user>/LLM-Trader/main/state`
- Deploy. The page is static + ISR (revalidates every 60s) — no backend, no keys on Vercel.

---

## Local development

```bash
npm install
cp .env.example .env          # fill in GEMINI_API_KEY + TWELVEDATA_API_KEY for a real run

npm run cycle:mock            # full cycle, offline deterministic mocks, no writes (DRY_RUN)
npm run test                  # unit tests for ledger + guardrails
npm run typecheck

# real providers, but don't require the market to be open and don't commit:
DRY_RUN=1 FORCE_SESSION=1 npm run cycle

cd dashboard && npm install && npm run dev   # http://localhost:3000, reads ../state from disk
```

### Env / switches

`GEMINI_API_KEY`, `GEMINI_MODEL`, `TWELVEDATA_API_KEY` — real providers.
`DRY_RUN=1` skip all state writes · `FORCE_SESSION=1` bypass the Cairo session gate ·
`MOCK_LLM=1` / `MOCK_MARKET=1` deterministic offline providers · `MODE=eod` mark-to-market run.

---

## How a cycle works

1. Compute Cairo time. Weekend or outside 10:00–14:15 → log and exit cheaply (unless in the
   14:20–15:30 EOD window → mark-to-market instead).
2. Fetch ~60 daily closes per universe ticker from Twelve Data; derive a delayed quote from the
   latest bar; compute 5d/20d per-ticker and per-sector changes and the EGX30 level (real or
   synthetic). Snapshot written to `state/prices.json`.
3. If fewer than half the universe has quotes (holiday / outage) → record a no-trade cycle and
   exit without trading on stale data.
4. Build the prompt (portfolio, policy limits, per-ticker data, sector aggregates, last 5
   cycles' decisions) and call Gemini with a JSON response schema.
5. `applyGuardrails`: sells before buys; reject sells inside `minHoldingDays`; clamp buys to
   `maxPositionPct` / `maxSectorPct` / `minCashBufferPct`; cap at `maxTradesPerCycle`. Every
   proposal ends up logged as accepted / clamped / rejected with a reason.
6. Book surviving fills at the delayed price + costs into the ledger; recompute NAV.
7. Write `portfolio.json`, append `trades.json` / `decisions.json` / `equity_curve.json`.
8. The workflow commits `state/` back to the repo.

---

## Known limitations (by design)

Paper fills use delayed quotes as the fill price (no slippage/spread modelling). Free LLM/data
tiers can rate-limit or degrade without notice. This is a research/learning project — nothing
here is a validated strategy or investment advice.
