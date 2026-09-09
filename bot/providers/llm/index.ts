import { config } from "../../config.js";
import type { LlmProvider, MarketSnapshot, Portfolio } from "../../types.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { MockLlmProvider } from "./mock.js";

/**
 * LLM provider chain: Gemini primary, Groq fallback (used only if Gemini errors
 * or is rate-limited that cycle). The caller in index.ts tries them in order and
 * records which one served the cycle.
 */
export function getLlmProviderChain(
  mockContext: () => { portfolio: Portfolio; snapshot: MarketSnapshot },
): LlmProvider[] {
  if (config.mockLlm) return [new MockLlmProvider(mockContext)];

  const chain: LlmProvider[] = [];
  if (config.gemini.apiKey) chain.push(new GeminiProvider(config.gemini.apiKey, config.gemini.model));
  if (config.groq.apiKey) chain.push(new GroqProvider(config.groq.apiKey, config.groq.model));

  if (chain.length === 0) {
    throw new Error("No LLM provider configured. Set GEMINI_API_KEY (or MOCK_LLM=1).");
  }
  return chain;
}
