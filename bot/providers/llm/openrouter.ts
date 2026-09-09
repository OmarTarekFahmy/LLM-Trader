import type { LlmProvider, LlmResult } from "../../types.js";
import { parseLlmJson } from "../../prompt.js";

const URL = "https://openrouter.ai/api/v1/chat/completions";

interface OrMessage {
  content?: string;
  reasoning?: string;
}
interface OpenRouterResponse {
  choices?: {
    message?: OrMessage;
    finish_reason?: string;
    native_finish_reason?: string;
    error?: { message?: string };
  }[];
  error?: { message?: string; code?: number | string };
}

/**
 * OpenRouter (OpenAI-compatible chat completions). Default model
 * `google/gemma-4-26b-a4b-it:free`. No strict `response_format` — we prompt hard
 * for JSON and lean on the tolerant parser, which keeps model swaps painless.
 *
 * Robustness notes:
 *  - `max_tokens` is generous (8k) because reasoning/"thinking" models burn a
 *    lot of the budget before emitting the answer. With 2k they hit the length
 *    limit mid-thought and return empty `content`.
 *  - If `content` is empty we try `message.reasoning` (some reasoning models put
 *    the final JSON only in their trace).
 *  - Free models: OpenRouter caps `:free` at ~50 req/day under $10 lifetime
 *    credit (~1000/day above). ~80 calls/day across three strategies, so the
 *    Gemini/Groq fallback in providers/llm/index.ts carries the overflow.
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
      max_tokens: 8192,
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
          signal: AbortSignal.timeout(90_000),
        });
        const body = (await res.json()) as OpenRouterResponse;

        const errMsg = body.error?.message ?? body.choices?.[0]?.error?.message;
        if (!res.ok || errMsg) {
          const msg = errMsg ?? `HTTP ${res.status}`;
          // A saturated free/shared upstream pool won't clear in seconds — fail
          // fast so the provider chain can move on to Gemini/Groq.
          const sharedPoolExhausted = /shared[_ ]pool|rate-limited upstream/i.test(msg);
          if (!sharedPoolExhausted && (res.status === 429 || res.status >= 500) && attempt < 2) {
            await new Promise((r) => setTimeout(r, 6_000 * (attempt + 1)));
            lastErr = new Error(msg);
            continue;
          }
          throw new Error(`openrouter: ${msg}`);
        }

        const choice = body.choices?.[0];
        const msg = choice?.message ?? {};
        const finish = choice?.finish_reason ?? choice?.native_finish_reason ?? "?";
        const text = (msg.content ?? "").trim() || (msg.reasoning ?? "").trim();

        if (!text) {
          const hint =
            finish === "length"
              ? " (finish_reason: length — model likely ran out of tokens while reasoning; raise max_tokens or pick a non-reasoning model)"
              : ` (finish_reason: ${finish})`;
          throw new Error(`openrouter: empty response${hint}`);
        }

        const decision = parseLlmJson(text);
        return { ...decision, provider: this.name, model: this.model, raw: msg.content?.trim() || text };
      } catch (err) {
        lastErr = err;
        if (attempt >= 2) break;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
