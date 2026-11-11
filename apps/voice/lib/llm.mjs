// Picks the Claude provider from env:
//   AWS Bedrock (preferred): AWS_BEARER_TOKEN_BEDROCK + AWS_REGION [+ BEDROCK_MODEL_ID]
//   Anthropic API fallback:  ANTHROPIC_API_KEY [+ SCOUT_MODEL]
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { anthropic } from "@ai-sdk/anthropic";

export function llm() {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_ACCESS_KEY_ID) {
    const bedrock = createAmazonBedrock({ region: process.env.AWS_REGION || "us-east-1" });
    return bedrock(process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-haiku-5-5");
  }
  if (process.env.ANTHROPIC_API_KEY) return anthropic(process.env.SCOUT_MODEL || "claude-haiku-5-5");
  throw new Error("No LLM configured: set AWS_BEARER_TOKEN_BEDROCK (+ AWS_REGION) or ANTHROPIC_API_KEY");
}

export function llmName() {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_ACCESS_KEY_ID)
    return `bedrock:${process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-haiku-5-5"}`;
  if (process.env.ANTHROPIC_API_KEY) return `anthropic:${process.env.SCOUT_MODEL || "claude-haiku-5-5"}`;
  return "none";
}
