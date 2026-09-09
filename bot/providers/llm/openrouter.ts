import type { LlmProvider, LlmResult } from "../../types.js";
import { parseLlmJson } from "../../prompt.js";

const URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterResponse {
  choices?: { message?: { content?: string }; finish_reason?: string; error?: { message?: string } }[];
  error?: { message?: string; code?: number | string };
}

/**
 * OpenRouter (OpenAI-compatible chat completions). Default model
 * `google/gemma-4-26b-a4b-it:free`. No strict `response_format` — we prompt hard
 * for JSON and lean on the tolerant parser, which keeps model swaps painless.
 *
 * Note on free models: OpenRouter caps `:free` models at ~50 requests/day for
 * accounts with under $10 of lifetime credit (~1000/day above that). Three
 * strategies on the 10-minute cadence is ~80 calls/day, so the Gemini/Groq
 * fallback in providers/llm/index.ts will carry cycles once the daily cap hits.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model: string) {
    if (!apiKey) throw new Error("OpenRouterProvider: missing OPENROUTER_API_KEY");
    this.apiKey = apiKey;
    this.model = model;
  }

  async decide(promptText: string): Promise<LlmResult> {
    const payload = {
      model: this.model,
      temperature: 0.35,
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content:
            "You are a disciplined EGX paper-portfolio manager. Output ONLY a single JSON object, no prose, no markdown fences, " +
            'matching: {"marketRead": string, "actions": [{"ticker": string, "action": "buy"|"sell"|"hold", "quantity": integer, "rationale": string}]}.',
        },
        { role: "user", content: promptText },
      ],
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
            "HTTP-Referer": "https://github.com/OmarTarekFahmy/LLM-Trader",
            "X-Title": "EGX LLM Paper Trader",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60_000),
        });
        const body = (await res.json()) as OpenRouterResponse;

        const errMsg = body.error?.message ?? body.choices?.[0]?.error?.message;
        if (!res.ok || errMsg) {
          const msg = errMsg ?? `HTTP ${res.status}`;
          if ((res.status === 429 || res.status >= 500) && attempt < 2) {
            await new Promise((r) => setTimeout(r, 6_000 * (attempt + 1)));
            lastErr = new Error(msg);
            continue;
          }
          throw new Error(`openrouter: ${msg}`);
        }

        const text = body.choices?.[0]?.message?.content ?? "";
        if (!text.trim()) throw new Error("openrouter: empty response");
        const decision = parseLlmJson(text);
        return { ...decision, provider: this.name, model: this.model, raw: text };
      } catch (err) {
        lastErr = err;
        if (attempt >= 2) break;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
