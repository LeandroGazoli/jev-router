// Reads the token counts a model API reports in its own response, so spend can be recorded
// without estimating. Anthropic's Messages API and OpenAI's Responses API (what Codex speaks)
// both put a `usage` object in the response; streaming responses carry it in a few SSE events
// near the start and end rather than in a single body.
import { StringDecoder } from "node:string_decoder";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

// A single line longer than this is not an SSE event; dropping it bounds memory for a proxy
// that sits in front of every request.
const MAX_LINE = 2 * 1024 * 1024;

const count = (value) => (Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * Normalised token counts from one parsed response object or SSE event, or null when it has
 * none. The four fields never overlap, so their sum is the total the request processed:
 *   input      new (uncached) prompt tokens
 *   cacheRead  prompt tokens served from the cache
 *   cacheWrite prompt tokens written to the cache (Anthropic only)
 *   output     generated tokens
 * Anthropic already reports `input_tokens` without the cached part. OpenAI includes the cached
 * part in `input_tokens` and reports it separately, so it is subtracted here to match.
 */
export function usageFrom(event) {
  const usage = event?.message?.usage ?? event?.response?.usage ?? event?.usage;
  if (!usage || typeof usage !== "object") return null;
  const model = event?.message?.model ?? event?.response?.model ?? event?.model;
  const openai = usage.input_tokens_details != null || usage.prompt_tokens_details != null;
  const tokens = {};
  if (openai) {
    const cached = count(usage.input_tokens_details?.cached_tokens) ?? 0;
    const input = count(usage.input_tokens);
    if (input !== undefined) tokens.input = Math.max(0, input - cached);
    tokens.cacheRead = cached;
  } else {
    tokens.input = count(usage.input_tokens);
    tokens.cacheRead = count(usage.cache_read_input_tokens);
    tokens.cacheWrite = count(usage.cache_creation_input_tokens);
  }
  tokens.output = count(usage.output_tokens);
  for (const key of Object.keys(tokens)) if (tokens[key] === undefined) delete tokens[key];
  if (!Object.keys(tokens).length) return null;
  return { tokens, model: typeof model === "string" ? model : undefined };
}

/**
 * Feed it response text as it streams (strings or Buffers); `result()` returns the counts seen.
 * Anthropic repeats and refines figures across events (`message_start` opens with the input
 * counts and a placeholder output, `message_delta` closes with the final output), so for each
 * field the latest value wins. Only lines that mention "usage" are parsed, which keeps the
 * cost per streamed chunk to a substring search.
 */
export function createUsageTap() {
  const decoder = new StringDecoder("utf8");
  const total = {};
  let model;
  let carry = "";

  const take = (line) => {
    const text = line.startsWith("data:") ? line.slice(5) : line;
    if (!text.includes('"usage"')) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    const found = usageFrom(event);
    if (!found) return;
    Object.assign(total, found.tokens);
    model = found.model ?? model;
  };

  return {
    write(chunk) {
      carry += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const lines = carry.split("\n");
      carry = lines.pop();
      for (const line of lines) take(line);
      if (carry.length > MAX_LINE) carry = "";
    },
    result() {
      if (carry) take(carry);
      carry = "";
      return Object.keys(total).length ? { tokens: { ...total }, model } : null;
    },
  };
}

const DECODERS = { gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress };

/**
 * Reads usage off an upstream response without disturbing it: attaches beside whatever already
 * consumes the stream (the caller keeps piping it to the client). `onDone` runs once when the
 * response ends or is cut off, with `{ tokens, model }` or nothing when no usage was found.
 * A body in an encoding this cannot undo is skipped rather than guessed at.
 */
export function tapResponse(up, onDone) {
  const tap = createUsageTap();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      const result = tap.result();
      if (result) onDone(result);
    } catch {
      // Recording spend is best-effort and must never interfere with a response.
    }
  };

  const encoding = String(up.headers?.["content-encoding"] ?? "").trim().toLowerCase();
  if (!encoding || encoding === "identity") {
    up.on("data", (chunk) => tap.write(chunk));
    up.on("close", finish);
    return;
  }
  const make = DECODERS[encoding];
  if (!make) return;
  const decoder = make();
  decoder.on("data", (chunk) => tap.write(chunk));
  decoder.on("error", () => {});
  decoder.on("close", finish);
  up.pipe(decoder);
  // pipe() only ends the decoder when the response ends cleanly; a cut-off one still gets flushed.
  up.on("close", () => decoder.end());
}
