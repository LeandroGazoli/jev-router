import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForModels,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";

// Routing decisions come from a local JevK5 model served by llama.cpp's llama-server instead
// of the TypeSafe API, so no prompt text leaves this machine. JevK5 is a decision model: it
// does not generate, it reads the next-token logits of the option letters at the answer slot,
// and a client divides them by the calibration temperature before the softmax. The prompt
// format and readout follow the model card (alibiserikbay/JevK5-GGUF, "standalone client").

const LETTERS = "ABCDEFGHIJKLMNOP";
const MAX_OPTIONS = LETTERS.length;
const SYSTEM =
  "Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. " +
  "Respond with only its uppercase letter, with no explanation or reasoning.";

const baseURL = () => (process.env.JEV_LOCAL_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
// 1.316 is the calibration temperature of jevk5-9b-v0.3.3 (jevk5_config.json). Another model
// file has its own value; see the model card.
const temperature = () => Number(process.env.JEV_LOCAL_TEMPERATURE ?? 1.316);
const maxPromptChars = () => Number(process.env.JEV_MAX_PROMPT_CHARS ?? 1500);

/** Routing is on unless explicitly disabled; the local server needs no API key. */
export const routingEnabled = () => process.env.JEV_DISABLE !== "1";

async function post(path, body, signal) {
  const res = await fetch(baseURL() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`llama-server ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Context available to one request: llama-server splits -c across its parallel slots.
let slotContext;
async function slotTokens(signal) {
  if (slotContext) return slotContext;
  try {
    const res = await fetch(`${baseURL()}/props`, { signal });
    const props = await res.json();
    const total = props.default_generation_settings?.n_ctx ?? props.n_ctx;
    slotContext = Math.floor(total / (props.total_slots || 1)) || 1024;
  } catch {
    slotContext = 1024;
  }
  return slotContext;
}

/** Shortens long text, keeping the start and the end, which carry the instruction. */
function clip(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  return `${text.slice(0, head)} [...] ${text.slice(text.length - (max - head))}`;
}

const describe = (value) =>
  typeof value === "string"
    ? value
    : [value.model, value.what, value.signals?.length && `Signals: ${value.signals.join("; ")}`, value.not_for && `Not for: ${value.not_for}`]
        .filter(Boolean)
        .join(" ");

/** Normalises a question's criteria into ordered [id, description] pairs. */
function optionsOf(question) {
  const criteria = question.criteria;
  const pairs = Array.isArray(criteria)
    ? criteria.map((text, i) => [String(i), text])
    : Object.entries(criteria).map(([id, value]) => [id, describe(value)]);
  return pairs.slice(0, MAX_OPTIONS);
}

const buildPrompt = (evidence, question, options) => {
  const user = JSON.stringify({
    evidence,
    criterion: [].concat(question.instructions).join(" "),
    options: options.map(([id, text], i) => ({ letter: LETTERS[i], description: `${id}: ${text}` })),
  });
  return `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
};

/** One decision: a calibrated probability for every option, read from the answer-slot logits. */
async function decide(state, question, signal) {
  const options = optionsOf(question);
  const budget = (await slotTokens(signal)) - 16;
  let evidence = state;
  let tokens;
  // Shrink the user's prompt until the whole request fits one slot; a longer request would
  // be rejected by llama-server and routing would silently never happen.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    ({ tokens } = await post(
      "/tokenize",
      { content: buildPrompt(evidence, question, options), add_special: false, parse_special: true },
      signal,
    ));
    if (tokens.length <= budget) break;
    evidence = { ...evidence, request: clip(evidence.request, Math.floor(evidence.request.length / 2)) };
  }
  const result = await post(
    "/completion",
    { prompt: tokens, n_predict: 1, n_probs: 40, temperature: 0, cache_prompt: false },
    signal,
  );
  const top = result.completion_probabilities?.[0]?.top_logprobs;
  if (!top?.length) throw new Error("llama-server returned no logprobs");
  const seen = Object.fromEntries(top.map((t) => [t.token, t.logprob]));
  const floor = Math.min(...Object.values(seen)) - 2;
  const logits = options.map((_, i) => seen[LETTERS[i]] ?? floor);
  const peak = Math.max(...logits);
  const weights = logits.map((v) => Math.exp((v - peak) / temperature()));
  const sum = weights.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(options.map(([id], i) => [id, weights[i] / sum]));
  return { options, probabilities };
}

function asChoice({ probabilities }) {
  const [best, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { choice: best, confidence, probabilities };
}

// Probability-weighted position on the ordered levels.
function asScore({ options, probabilities }) {
  const expected = options.reduce((acc, [id], i) => acc + i * probabilities[id], 0);
  return { score: expected, probabilities };
}

/**
 * Asks the local Jev model which tier fits this prompt. Returns null on any failure, which
 * the policy layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, current, contextTokens, models }) {
  if (!models?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(
    () => abort.abort(),
    Number(process.env.JEV_LOCAL_DEADLINE_MS ?? THRESHOLDS.jevDeadlineMs),
  );
  const state = {
    request: clip(prompt, maxPromptChars()),
    session: { current_model: current, context_tokens: contextTokens },
    environment: { available_models: models.map((model) => model.id) },
  };
  // The decision must depend on the prompt, not on where the session already is; the current
  // model is kept in `request` for /jev-explain but is not part of the evidence the model reads.
  const evidence = { request: state.request, environment: state.environment };
  const questions = { ...QUESTIONS, model: questionForModels(models) };
  const request = { state, questions };
  try {
    // llama-server serves one slot per request, so the four independent questions run in
    // parallel without seeing each other's answers.
    const [model, taskComplexity, reasoning, tools] = await Promise.all(
      [questions.model, questions.task_complexity, questions.reasoning_required, questions.tool_complexity].map(
        (question) => decide(evidence, question, abort.signal),
      ),
    );
    const answer = asChoice(model);
    const scores = {
      task_complexity: asScore(taskComplexity),
      reasoning_required: asScore(reasoning),
      tool_complexity: asScore(tools),
    };
    return {
      ...answer,
      request,
      response: { answers: { model: answer, ...scores } },
      metrics: {
        taskComplexity: scores.task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: scores.reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: scores.tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
