import { config } from "../../config.js";
import type { LlmProvider, MarketSnapshot, Portfolio } from "../../types.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { MockLlmProvider } from "./mock.js";
import { OpenRouterProvider } from "./openrouter.js";

/**
 * LLM provider chain: OpenRouter primary (default model
 * google/gemma-4-26b-a4b-it:free), then Gemini, then Groq — each included only
 * if its key is set. The caller in index.ts tries them in order and records
 * which one served the cycle. Keep the Gemini/Groq keys in place as fallback
 * for when OpenRouter's free-model daily cap is reached; remove those secrets
 * to run OpenRouter-only.
 */
export function getLlmProviderChain(
  mockContext: () => { portfolio: Portfolio; snapshot: MarketSnapshot },
): LlmProvider[] {
  if (config.mockLlm) return [new MockLlmProvider(mockContext)];

  const chain: LlmProvider[] = [];
  if (config.openrouter.apiKey)
    chain.push(new OpenRouterProvider(config.openrouter.apiKey, config.openrouter.model));
  if (config.gemini.apiKey) chain.push(new GeminiProvider(config.gemini.apiKey, config.gemini.model));
  if (config.groq.apiKey) chain.push(new GroqProvider(config.groq.apiKey, config.groq.model));

  if (chain.length === 0) {
    throw new Error("No LLM provider configured. Set OPENROUTER_API_KEY (or MOCK_LLM=1).");
  }
  return chain;
}
