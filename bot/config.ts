import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Policy, StrategyDef, StrategyRegistry, Universe } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..");
export const STATE_DIR = join(REPO_ROOT, "state");

/** Absolute path to one strategy's state directory. */
export const strategyDir = (id: string): string => join(STATE_DIR, id);

/** Load a tiny .env file if present (no dependency on dotenv). */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(join(REPO_ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1]!;
      let val = m[2]!;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // no .env, fine
  }
}
loadDotEnv();

const flag = (name: string): boolean => {
  const v = process.env[name];
  return v === "1" || v === "true" || v === "yes";
};

export const config = {
  dryRun: flag("DRY_RUN"),
  forceSession: flag("FORCE_SESSION"),
  mockLlm: flag("MOCK_LLM"),
  mockMarket: flag("MOCK_MARKET"),
  mode: (process.env.MODE === "eod" ? "eod" : "trade") as "eod" | "trade",
  /** Optional: run only this strategy id (comma-separated ok). Empty = all. */
  strategyFilter: (process.env.STRATEGY ?? "").split(",").map((s) => s.trim()).filter(Boolean),

  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: process.env.GEMINI_MODEL || "gemini-flash-latest",
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY ?? "",
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  },
  twelveData: {
    apiKey: process.env.TWELVEDATA_API_KEY ?? "",
  },
  useTwelveData: flag("USE_TWELVEDATA"),

  /** How much daily history to request per ticker for the LLM to reason about. */
  historyDays: 60,
  /** How many prior decision entries to feed back to the LLM for continuity. */
  decisionContextWindow: 5,
} as const;

export function loadStrategies(): StrategyRegistry {
  const raw = JSON.parse(
    readFileSync(join(STATE_DIR, "strategies.json"), "utf8"),
  ) as StrategyRegistry & { _comment?: string };
  let strategies = raw.strategies;
  if (config.strategyFilter.length > 0) {
    strategies = strategies.filter((s) => config.strategyFilter.includes(s.id));
  }
  return { cadenceMinutes: raw.cadenceMinutes, strategies };
}

/** Full runtime policy for a strategy (its per-strategy policy + starting cash). */
export function policyFor(def: StrategyDef): Policy {
  return { startingCashEgp: def.startingCashEgp, ...def.policy };
}

export function loadUniverse(name: string): Universe {
  const raw = JSON.parse(
    readFileSync(join(STATE_DIR, "universes", `${name}.json`), "utf8"),
  ) as Universe;
  return raw;
}
