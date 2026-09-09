#!/usr/bin/env bash
#
# One-shot GitHub setup for the EGX LLM paper trader.
#
#   1. creates the public repo `LLM-Trader` under your account and pushes `main`
#   2. uploads GEMINI_API_KEY / GROQ_API_KEY / TWELVEDATA_API_KEY from ./.env as
#      Actions secrets (only the ones that are set)
#   3. flips the repo's Actions permissions to "read and write" so the workflow
#      can commit state/ back
#   4. kicks off a first `trade-cycle` run with force_session=true and follows it
#
# Prereqs: `gh auth status` shows you logged in with `repo` + `workflow` scopes,
# and ./.env exists (copy from .env.example and fill in the keys).
#
# Safe to re-run: repo creation / push are skipped if they already exist.

set -euo pipefail
cd "$(dirname "$0")/.."

REPO_NAME="LLM-Trader"
OWNER="$(gh api user -q .login)"
SLUG="$OWNER/$REPO_NAME"

# 1. repo + push -------------------------------------------------------------
if gh repo view "$SLUG" >/dev/null 2>&1; then
  echo "repo $SLUG already exists"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$SLUG.git"
  git push -u origin main
else
  gh repo create "$SLUG" --public --source . --remote origin --push \
    --description "Hands-off LLM-driven paper trading experiment on the Egyptian Exchange (EGX). Fake money, real delayed prices."
fi

# 2. secrets ----------------------------------------------------------------
set -a; [ -f .env ] && . ./.env; set +a
for name in GEMINI_API_KEY GROQ_API_KEY TWELVEDATA_API_KEY; do
  val="${!name:-}"
  if [ -n "$val" ]; then
    printf '%s' "$val" | gh secret set "$name" --repo "$SLUG" --body -
    echo "secret set: $name"
  else
    echo "skip (not in .env): $name"
  fi
done

# 3. workflow write permission -------------------------------------------------
gh api -X PUT "repos/$SLUG/actions/permissions/workflow" \
  -f default_workflow_permissions=write -F can_approve_pull_request_reviews=false >/dev/null
echo "workflow permissions -> read & write"

# 4. first run --------------------------------------------------------------
echo "triggering trade-cycle (force_session=true)…"
gh workflow run trade-cycle.yml --repo "$SLUG" -f mode=trade -f force_session=true
sleep 6
RUN_ID="$(gh run list --repo "$SLUG" --workflow trade-cycle.yml --limit 1 --json databaseId -q '.[0].databaseId')"
gh run watch "$RUN_ID" --repo "$SLUG" --exit-status || true
gh run view "$RUN_ID" --repo "$SLUG" --log | tail -60

echo
echo "done. dashboard env var for Vercel:"
echo "  STATE_BASE_URL=https://raw.githubusercontent.com/$SLUG/main/state"
