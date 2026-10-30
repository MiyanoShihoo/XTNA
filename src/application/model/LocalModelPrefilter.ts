/**
 * Local-model pre-filter (Ollama-compatible, loopback only).
 *
 * The point is to shrink what a larger model has to read: a small local model
 * labels a candidate as relevant, irrelevant or unclear. It is deliberately
 * fail-open to `unknown`: a model that is down must never look like a silent
 * "irrelevant" and hide evidence.
 */
import { readFile } from "node:fs/promises";

export type PrefilterLabel = "relevant" | "irrelevant" | "unknown";

export interface PrefilterResult {
  readonly label: PrefilterLabel;
  readonly confidence: number;
  readonly reason: string;
  readonly model: string;
  readonly latencyMs: number;
}

export interface PrefilterOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxInputChars?: number;
}

export interface Prefilter {
  classify(text: string): Promise<PrefilterResult>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 8_000;
const MAX_REPLY_BYTES = 64 * 1024;

const SYSTEM_PROMPT =
  'You label reverse-engineering evidence for a reader. Answer with one JSON object: {"label":"relevant"|"irrelevant","confidence":0..1,"reason":"<=200 chars"}. Judge only whether the text carries analysis-relevant facts. Never invent facts.';

const loopbackEndpoint = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("endpoint must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("endpoint must use http or https");
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(
      "endpoint must be loopback (127.0.0.1, localhost or [::1])",
    );
  return url;
};

const parseLabel = (value: unknown): PrefilterLabel =>
  value === "relevant" || value === "irrelevant" ? value : "unknown";

/** Create a prefilter bound to one local model. */
export const createLocalModelPrefilter = (
  options: PrefilterOptions,
): Prefilter => {
  const endpoint = loopbackEndpoint(options.endpoint);
  const url = new URL("/api/chat", endpoint.origin);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInput = options.maxInputChars ?? MAX_INPUT_CHARS;

  const classify = async (text: string): Promise<PrefilterResult> => {
    const startedAt = Date.now();
    const trimmed = text.length > maxInput ? text.slice(0, maxInput) : text;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          stream: false,
          format: "json",
          options: { temperature: 0, num_predict: 160 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: trimmed },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        return {
          label: "unknown",
          confidence: 0,
          reason: `model HTTP ${String(response.status)}: ${detail}`,
          model: options.model,
          latencyMs: Date.now() - startedAt,
        };
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_REPLY_BYTES)
        return {
          label: "unknown",
          confidence: 0,
          reason: "model reply exceeded the size cap",
          model: options.model,
          latencyMs: Date.now() - startedAt,
        };
      const envelope = JSON.parse(raw) as { message?: { content?: string } };
      const content = envelope.message?.content;
      if (typeof content !== "string")
        return {
          label: "unknown",
          confidence: 0,
          reason: "model reply had no message.content",
          model: options.model,
          latencyMs: Date.now() - startedAt,
        };
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return {
          label: "unknown",
          confidence: 0,
          reason: "model content was not JSON",
          model: options.model,
          latencyMs: Date.now() - startedAt,
        };
      }
      const record =
        parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
      const confidence =
        typeof record.confidence === "number" &&
        Number.isFinite(record.confidence)
          ? Math.max(0, Math.min(1, record.confidence))
          : 0;
      return {
        label: parseLabel(record.label),
        confidence,
        reason:
          typeof record.reason === "string"
            ? record.reason.slice(0, 300)
            : "model gave no reason",
        model: options.model,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        label: "unknown",
        confidence: 0,
        reason: `model unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
        model: options.model,
        latencyMs: Date.now() - startedAt,
      };
    }
  };

  return { classify };
};

/** Convenience wrapper used by the CLI: read a file, classify it, return one result. */
export const prefilterFile = async (
  path: string,
  options: PrefilterOptions,
): Promise<PrefilterResult> => {
  const text = await readFile(path, "utf8");
  return createLocalModelPrefilter(options).classify(text);
};
