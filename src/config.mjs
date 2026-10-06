// Every routing decision knob lives here, so the whole policy is reviewable in one file.

// Question descriptors read by the local JevK5 client in router.mjs (same shape the TypeSafe SDK builds).
const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
const score = (instructions, criteria) => ({ type: "score", instructions, criteria });

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags come from
 * the Agent SDK's model catalogue: Haiku supports neither adaptive thinking nor effort, so
 * those fields have to be stripped when routing down to it.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false },
  { name: "sonnet", id: "claude-sonnet-5-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE === "1");

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: Number(process.env.JEV_MIN_CONFIDENCE ?? 0.3),
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /** Below this confidence a jump of more than one tier is shortened to one step up. */
  stepUpConfidence: Number(process.env.JEV_STEP_UP_CONFIDENCE ?? 0.6),
  /** Task-complexity score (0-1) from which Haiku is never used. */
  riskFloor: Number(process.env.JEV_RISK_FLOOR ?? 0.5),
  riskFloorTier: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: Number(process.env.JEV_DOWNGRADE_CUTOFF_TOKENS ?? 20000),
  /**
   * How long the provider keeps a prompt cache alive after its last use (5 minutes by default;
   * set JEV_CACHE_TTL_MS to 3600000 if your sessions use the 1-hour cache). Once a conversation
   * has been idle longer than this, the cache is gone anyway, so a downgrade no longer throws
   * anything away and the size guard above does not apply.
   */
  cacheTtlMs: Number(process.env.JEV_CACHE_TTL_MS ?? 300000),
  /**
   * Inputs to the downgrade payback estimate: how many requests a turn makes when nothing has been
   * observed yet (a measured 3-4 per turn in real sessions), and how many further turns a
   * conversation is assumed to run at the cheaper tier.
   */
  defaultRequestsPerTurn: Number(process.env.JEV_REQUESTS_PER_TURN ?? 4),
  expectedTurnsAhead: Number(process.env.JEV_TURNS_AHEAD ?? 3),
  /**
   * Largest conversation a tier can be handed, with room left for its reply. Haiku's window is
   * 200K, so a long conversation cannot move down to it, however cold the cache is.
   */
  tierContextLimits: { haiku: 160000 },
  /**
   * Per-attempt timeout and hard wall-clock deadline for the whole routing call against the
   * local llama-server. Generous because the first call after the model loads is slow.
   */
  jevTimeoutMs: 20000,
  jevDeadlineMs: 25000,
  jevMaxRetries: 0,
};

/** Tier for Claude Code's own tool-less calls (progress summaries, titles); they are not engineering work. */
export const AUX_TIER = process.env.JEV_AUX_TIER ?? "haiku";

/**
 * The window the context-size metric is expressed against: 1M, what Opus and Sonnet work with.
 * Claude Code sessions start at roughly 70-100k tokens (system prompt, MCP tools, plugins and
 * skills), so against a 200K window the metric sat at 40% before anyone typed anything.
 */
export const CONTEXT_WINDOW_TOKENS = Number(process.env.JEV_CONTEXT_WINDOW_TOKENS ?? 1_000_000);

/**
 * Input price per million tokens by tier, used only as ratios (Anthropic list prices, cached
 * 2026-09-25: Haiku 4.5 $1, Sonnet 5.5 $2, Opus 5.5 $4, Fable $10), and the cache multipliers on
 * the base input price (write about 1.25x, read about 0.1x).
 */
export const TIER_INPUT_PRICE = { haiku: 1, sonnet: 2, opus: 4, fable: 10 };
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

/**
 * How many more requests a conversation must make on the cheaper tier before moving down to it
 * has paid for rebuilding its cache there. The size of the conversation cancels out of this:
 * both the one-off rebuild and the per-request saving scale with it. Infinity when the move
 * saves nothing.
 */
export function paybackRequests(from, to) {
  const a = TIER_INPUT_PRICE[from];
  const b = TIER_INPUT_PRICE[to];
  if (!(a > b)) return Infinity;
  return (CACHE_WRITE * b) / (CACHE_READ * (a - b));
}

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${{
      haiku: "haiku|fast|luna",
      sonnet: "sonnet|balanced|terra",
      opus: "opus|strong|sol",
      fable: "fable|long|astra",
    }[t.name]})\\b`,
    "i",
  ),
}));

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    COMPLEXITY_SCALE,
  ),
};

const GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: ["Rename, reformat, comment, or run one obvious command"],
    not_for: "Design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: ["Implement a specified function, test existing behaviour, or fix an understood local bug"],
    not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations"],
    not_for: "Routine work with a clear implementation.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    signals: ["Whole-repo migration, unusually large context, or multi-hour autonomous execution"],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) =>
  choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description }) => [
        id,
        { model: description ?? id, ...GUIDANCE[tier] },
      ]),
    ),
  );

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
