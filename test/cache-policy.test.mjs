import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.mjs";

const base = {
  prompt: "fix the bug",
  current: "sonnet",
  available: ["haiku", "sonnet", "opus"],
  jev: { choice: "haiku", confidence: 0.95 },
  contextTokens: 100000,
};

test("a warm cache holds the downgrade; unknown is treated as warm", () => {
  assert.match(decide({ ...base, cacheWarm: true }).reason, /cache-rebuild/);
  assert.match(decide(base).reason, /cache-rebuild/, "callers that do not say keep the old behaviour");
});

test("an expired cache has nothing to protect, so the downgrade goes ahead", () => {
  const out = decide({ ...base, cacheWarm: false });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "jev");
});

test("a conversation too big for haiku never moves there, cache or not", () => {
  const out = decide({ ...base, cacheWarm: false, contextTokens: 170000 });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /context-too-large-for-tier/);
});

test("the window limit does not hold back upgrades", () => {
  const out = decide({ ...base, current: "haiku", jev: { choice: "sonnet", confidence: 0.95 }, contextTokens: 170000, cacheWarm: false });
  assert.equal(out.tier, "sonnet");
});

test("break-even is the same whatever the size of the conversation, and depends on the price gap", async () => {
  const { paybackRequests, CONTEXT_WINDOW_TOKENS } = await import("../src/config.mjs");
  assert.equal(paybackRequests("sonnet", "haiku"), 12.5);
  assert.equal(paybackRequests("opus", "sonnet"), 12.5);
  assert.ok(Math.abs(paybackRequests("opus", "haiku") - 4.1667) < 0.001, "a bigger price gap pays back sooner");
  assert.equal(paybackRequests("haiku", "sonnet"), Infinity, "moving up saves nothing");
  assert.equal(CONTEXT_WINDOW_TOKENS, 1_000_000);
});

test("with a long run ahead a big, warm conversation may still move down; with a short one it may not", () => {
  const longRun = decide({ ...base, expectedRequests: 20 });
  assert.equal(longRun.tier, "haiku");
  const shortRun = decide({ ...base, expectedRequests: 8 });
  assert.equal(shortRun.tier, "sonnet");
  assert.match(shortRun.reason, /cache-rebuild/);
  assert.equal(decide({ ...base, current: "opus", expectedRequests: 6 }).tier, "haiku", "opus to haiku pays back in about 4");
  assert.equal(decide({ ...base, contextTokens: 5000, expectedRequests: 1 }).tier, "haiku", "a tiny cache is cheap to lose");
});
