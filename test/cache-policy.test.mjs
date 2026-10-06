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
