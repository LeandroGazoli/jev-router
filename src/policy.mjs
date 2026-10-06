import { TIER_NAMES, THRESHOLDS, OVERRIDE_PATTERNS, paybackRequests, rankOf } from "./config.mjs";

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * (which bills extra usage credits) unless that is what was asked for.
 */
function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @param {number} input.contextTokens approximate size of the conversation so far
 * @param {number} [input.expectedRequests] requests this conversation is expected to make from
 *   here on. When given, a downgrade is refused unless it will pay back the cache rebuild
 *   (see paybackRequests); when absent, the size cutoff below decides instead
 * @param {boolean} [input.cacheWarm] false when the conversation's prompt cache has already
 *   expired, which makes a downgrade free of rebuild cost; unknown (the default) is treated as warm
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, jev, current, available, contextTokens = 0, cacheWarm = true, expectedRequests }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || !TIER_NAMES.includes(jev.choice)) return settle(current, "jev-unavailable");

  let target = jev.choice;
  let reason = "jev";

  // Complexity/risk floor: a task that scores high is never handed to the cheapest tier.
  const risk = jev.metrics?.taskComplexity;
  if (risk != null && risk >= THRESHOLDS.riskFloor && rankOf(target) < rankOf(THRESHOLDS.riskFloorTier)) {
    target = THRESHOLDS.riskFloorTier;
    reason = "risk-floor";
  }

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  // A smaller model may simply not fit what the conversation has grown to.
  const limit = THRESHOLDS.tierContextLimits?.[target];
  if (rankOf(target) < rankOf(current) && limit && contextTokens > limit) {
    return settle(current, "context-too-large-for-tier");
  }

  // Only a warm cache is worth protecting: after it expires, any model has to rebuild it.
  if (cacheWarm && rankOf(target) < rankOf(current)) {
    // A cache this small is cheap to rebuild whatever happens next; above that, what matters is
    // whether the conversation will run long enough on the cheaper tier to earn the rebuild back.
    const big = contextTokens > THRESHOLDS.downgradeMaxContextTokens;
    const notWorth = big && (expectedRequests == null || expectedRequests < paybackRequests(current, target));
    if (notWorth) return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  // Climb one tier at a time unless Jev is sure; a doubtful jump to the top is the costly mistake.
  if (jev.confidence < THRESHOLDS.stepUpConfidence && rankOf(target) > rankOf(current) + 1) {
    return settle(TIER_NAMES[rankOf(current) + 1], "gradual-step");
  }

  return settle(target, reason);
}
