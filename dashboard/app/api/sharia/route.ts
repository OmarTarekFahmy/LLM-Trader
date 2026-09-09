import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "state/sharia.json";

function repoCoords(): { owner: string; repo: string; branch: string } {
  const base = process.env.STATE_BASE_URL ?? "";
  const m = base.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/state/);
  if (m) return { owner: m[1]!, repo: m[2]!, branch: m[3]! };
  return { owner: "OmarTarekFahmy", repo: "LLM-Trader", branch: "main" };
}

interface Ruling {
  compliant: boolean;
  basis: string;
}

function validate(input: unknown): Record<string, Ruling> | null {
  if (typeof input !== "object" || input === null) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 300) return null;
  const out: Record<string, Ruling> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Z0-9]{2,8}$/.test(k)) return null;
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    if (typeof r.compliant !== "boolean") return null;
    const basis = typeof r.basis === "string" ? r.basis.slice(0, 240) : "";
    out[k] = { compliant: r.compliant, basis };
  }
  return out;
}

export async function POST(req: Request) {
  let body: { token?: unknown; rulings?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 20) {
    return NextResponse.json({ error: "A GitHub token with contents:write on the repo is required." }, { status: 401 });
  }
  const rulings = validate(body.rulings);
  if (!rulings) {
    return NextResponse.json({ error: "invalid rulings payload" }, { status: 400 });
  }

  const { owner, repo, branch } = repoCoords();
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${PATH}`;
  const gh = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "llm-trader-dashboard",
  };

  const getRes = await fetch(`${api}?ref=${branch}`, { headers: gh, cache: "no-store" });
  if (getRes.status === 401 || getRes.status === 403) {
    return NextResponse.json({ error: "GitHub rejected the token (needs contents:write on this repo)." }, { status: 401 });
  }
  if (!getRes.ok) {
    return NextResponse.json({ error: `GitHub read failed (${getRes.status})` }, { status: 502 });
  }
  const cur = (await getRes.json()) as { sha: string; content: string };
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(Buffer.from(cur.content, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    /* start fresh */
  }

  const next = {
    ...doc,
    rulings,
    updatedAt: new Date().toISOString(),
    updatedBy: "dashboard-settings",
  };
  const content = Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8").toString("base64");
  const compliant = Object.values(rulings).filter((r) => r.compliant).length;

  const putRes = await fetch(api, {
    method: "PUT",
    headers: { ...gh, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `sharia: update compliance rulings (${compliant} compliant) [skip ci]`,
      content,
      sha: cur.sha,
      branch,
    }),
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    return NextResponse.json({ error: `GitHub write failed (${putRes.status}): ${t.slice(0, 200)}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true, updatedAt: next.updatedAt, compliant });
}
