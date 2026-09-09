import type { LlmProvider, LlmResult } from "../../types.js";
import { parseLlmJson } from "../../prompt.js";

const URL = "https://api.groq.com/openai/v1/chat/completions";

interface GroqResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  error?: { message?: string; type?: string };
}

/**
 * Groq fallback LLM (OpenAI-compatible chat completions). Used only when the
 * primary (Gemini) errors or is rate-limited for a cycle. Free tier is ~30
 * RPM / 1,000 RPD — far more than this project needs.
 *
 * Default model `openai/gpt-oss-120b`: the spec's `llama-3.3-70b-versatile` is
 * no longer offered on Groq (checked 2026-09-09). gpt-oss emits a separate
 * `reasoning` field and returns clean JSON in `content`; strict
 * `response_format: json_object` fails against it, so we prompt hard for JSON
 * and lean on the tolerant parser instead.
 */
export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model: string) {
    if (!apiKey) throw new Error("GroqProvider: missing GROQ_API_KEY");
    this.apiKey = apiKey;
    this.model = model;
  }

  async decide(promptText: string): Promise<LlmResult> {
    const payload: Record<string, unknown> = {
      model: this.model,
      temperature: 0.35,
      max_tokens: 4096,
      messages: [
        {
          role: "system",
          content:
            "You are a disciplined EGX paper-portfolio manager. Output ONLY a single JSON object, no prose, " +
            'matching: {"marketRead": string, "actions": [{"ticker": string, "action": "buy"|"sell"|"hold", "quantity": integer, "rationale": string}]}.',
        },
        { role: "user", content: promptText },
      ],
    };
    if (this.model.includes("gpt-oss")) payload.reasoning_effort = "low";

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(45_000),
        });
        const body = (await res.json()) as GroqResponse;

        if (!res.ok || body.error) {
          const msg = body.error?.message ?? `HTTP ${res.status}`;
          if ((res.status === 429 || res.status >= 500) && attempt < 2) {
            await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
            lastErr = new Error(msg);
            continue;
          }
          throw new Error(`groq: ${msg}`);
        }

        const text = body.choices?.[0]?.message?.content ?? "";
        if (!text.trim()) throw new Error("groq: empty response");
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
