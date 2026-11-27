import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { competitionConfig } from "./config";

export interface AiCallRecord {
  step: string;
  model: string;
  request_id: string | null;
  started_at: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  outcome: "ok" | "invalid_json" | "refusal" | "error";
  error?: string;
}

export class AiUnavailableError extends Error {}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  const cfg = competitionConfig();
  if (!cfg.anthropicKey) throw new AiUnavailableError("ANTHROPIC_API_KEY is not configured");
  if (!client) client = new Anthropic({ apiKey: cfg.anthropicKey, maxRetries: 1, timeout: 120_000 });
  return client;
}

/**
 * One structured-output call (output_config.format json_schema). Returns the parsed JSON and an
 * execution record (model, request id, latency, tokens) that goes into the job's evidence log.
 * No user media, prompt text or keys are written to the record.
 */
export async function structuredCall(opts: {
  step: string;
  model: string;
  system: string;
  content: Anthropic.ContentBlockParam[];
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}): Promise<{ data: unknown; record: AiCallRecord }> {
  const started = Date.now();
  const record: AiCallRecord = {
    step: opts.step,
    model: opts.model,
    request_id: null,
    started_at: new Date(started).toISOString(),
    latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    outcome: "error",
  };
  try {
    const stream = getClient().messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 16000,
      system: opts.system,
      output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema: opts.schema } },
      messages: [{ role: "user", content: opts.content }],
    });
    const res = await stream.finalMessage();
    record.latency_ms = Date.now() - started;
    record.request_id = res.id ?? null; // API message id (msg_…), verifiable in the Anthropic console logs
    record.input_tokens = res.usage?.input_tokens ?? 0;
    record.output_tokens = res.usage?.output_tokens ?? 0;
    if (res.stop_reason === "refusal") {
      record.outcome = "refusal";
      return { data: null, record };
    }
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    try {
      const data = JSON.parse(text);
      record.outcome = "ok";
      return { data, record };
    } catch {
      record.outcome = "invalid_json";
      return { data: null, record };
    }
  } catch (err) {
    record.latency_ms = Date.now() - started;
    if (err instanceof AiUnavailableError) throw err;
    record.outcome = "error";
    record.error =
      err instanceof Anthropic.APIError
        ? `http_${err.status ?? "x"}:${String(err.message ?? "").replace(/\s+/g, " ").slice(0, 240)}`
        : err instanceof Error
          ? err.name
          : "unknown";
    return { data: null, record };
  }
}
