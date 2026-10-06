import test from "node:test";
import assert from "node:assert/strict";
import { startProxy } from "../src/proxy.mjs";
import { secondTurnDecision } from "./context-guard.helper.mjs";

test("the real size the API reported keeps a warm conversation from being downgraded", async (t) => {
  // Tiny message text, but the previous request really carried ~100k tokens (system prompt and tools).
  const decision = await secondTurnDecision(t, {
    startProxy,
    usage: { input_tokens: 2, cache_read_input_tokens: 100000, output_tokens: 10 },
  });
  assert.equal(decision.tier, "sonnet");
  assert.match(decision.reason, /downgrade-not-worth-cache-rebuild/);
});

test("a small conversation can still be downgraded", async (t) => {
  const decision = await secondTurnDecision(t, {
    startProxy,
    usage: { input_tokens: 2, cache_read_input_tokens: 500, output_tokens: 10 },
  });
  assert.equal(decision.tier, "haiku");
});
