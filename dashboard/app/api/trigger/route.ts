import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKFLOW = "trade-cycle.yml";

/**
 * External-scheduler relay for the trade-cycle workflow.
 *
 * GitHub Actions' own `schedule:` trigger is documented as best-effort and, in
 * practice on this repo, only fired 2-4 times/day instead of the ~28-40
 * expected at a 15/10-minute cadence (2026-09-13/14) — GitHub can silently
 * skip or delay scheduled runs under load, and there's no fix for that from
 * inside the workflow file. This endpoint lets a real external scheduler (e.g.
 * cron-job.org, free) call `POST /repos/.../actions/workflows/trade-cycle.yml/dispatches`
 * on our behalf on a real schedule, which is far more reliable than GitHub's
 * own `schedule:` trigger. The GH `schedule:` crons stay in the workflow too,
 * as a free redundant backup — harmless since the bot's session gate and the
 * workflow's `concurrency` group make duplicate/overlapping triggers a no-op.
 *
 * Auth is two separate secrets, both Vercel env vars, neither ever sent to the
 * external pinger:
 *  - CRON_SECRET: a low-stakes shared secret the pinger includes in its
 *    request (query param `?secret=` or header `x-cron-secret`) so randoms
 *    can't spam this endpoint into burning your Actions minutes.
 *  - GH_DISPATCH_TOKEN: a GitHub PAT (classic `public_repo` scope, or
 *    fine-grained with Actions: Read & write on this repo) used server-side
 *    only to call the GitHub API. Never exposed to the client or the pinger.
 */
function repoCoords(): { owner: string; repo: string; branch: string } {
  const base = process.env.STATE_BASE_URL ?? "";
  const m = base.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/state/);
  if (m) return { owner: m[1]!, repo: m[2]!, branch: m[3]! };
  return { owner: "OmarTarekFahmy", repo: "LLM-Trader", branch: "main" };
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const provided = url.searchParams.get("secret") ?? req.headers.get("x-cron-secret") ?? "";
  const expected = process.env.CRON_SECRET ?? "";

  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET is not configured on this deployment" }, { status: 500 });
  }
  if (provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.GH_DISPATCH_TOKEN ?? "";
  if (!token) {
    return NextResponse.json({ error: "GH_DISPATCH_TOKEN is not configured on this deployment" }, { status: 500 });
  }

  const { owner, repo, branch } = repoCoords();
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "llm-trader-dashboard",
      },
      body: JSON.stringify({ ref: branch }),
    },
  );

  // GitHub returns 204 No Content on a successful dispatch.
  if (res.status === 204) {
    return NextResponse.json({ ok: true, dispatchedAt: new Date().toISOString() });
  }
  const text = await res.text().catch(() => "");
  const status = res.status === 401 || res.status === 403 ? 401 : 502;
  return NextResponse.json(
    { error: `GitHub dispatch failed (${res.status}): ${text.slice(0, 300)}` },
    { status },
  );
}

export const GET = handle;
export const POST = handle;
