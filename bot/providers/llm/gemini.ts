import type { LlmProvider, LlmResult } from "../../types.js";
import { parseLlmJson, RESPONSE_SCHEMA } from "../../prompt.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  error?: { message?: string; status?: string; code?: number };
  promptFeedback?: { blockReason?: string };
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model: string) {
    if (!apiKey) throw new Error("GeminiProvider: missing GEMINI_API_KEY");
    this.apiKey = apiKey;
    this.model = model;
  }

  async decide(promptText: string): Promise<LlmResult> {
    const url = `${BASE}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const payload = {
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.35,
        maxOutputTokens: 2048,
      },
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(45_000),
        });
        const body = (await res.json()) as GeminiResponse;

        if (!res.ok || body.error) {
          const msg = body.error?.message ?? `HTTP ${res.status}`;
          if ((res.status === 429 || res.status >= 500) && attempt < 2) {
            await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
            lastErr = new Error(msg);
            continue;
          }
          throw new Error(`gemini: ${msg}`);
        }
        if (body.promptFeedback?.blockReason) {
          throw new Error(`gemini: prompt blocked (${body.promptFeedback.blockReason})`);
        }

        const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        if (!text.trim()) throw new Error("gemini: empty response");

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
