import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export function claudeTotalUsage(result: SDKResultMessage) {
  const models = Object.values(result.modelUsage || {});
  const sum = (key: string) => models.reduce((total, model) => total + Number((model as any)[key] || 0), 0);
  return {
    inputTokens: models.length ? sum("inputTokens") : result.usage.input_tokens || 0,
    outputTokens: models.length ? sum("outputTokens") : result.usage.output_tokens || 0,
    cacheReadTokens: models.length ? sum("cacheReadInputTokens") : result.usage.cache_read_input_tokens || 0,
    cacheCreateTokens: models.length ? sum("cacheCreationInputTokens") : result.usage.cache_creation_input_tokens || 0,
    costUsd: result.total_cost_usd || 0,
    ...(sum("thinkingTokens") > 0 ? { thinkingTokens: sum("thinkingTokens") } : {}),
  };
}
