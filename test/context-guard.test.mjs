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

test("a conversation that works in long tool loops earns the move to haiku back, so it is allowed", async (t) => {
  const decision = await secondTurnDecision(t, {
    startProxy,
    loopRequests: 8,
    usage: { input_tokens: 2, cache_read_input_tokens: 100000, output_tokens: 10 },
  });
  assert.equal(decision.tier, "haiku", "9 requests on turn 1 predict about 27 more, past the break-even of 12.5");
});

test("a tiny conversation can always be downgraded", async (t) => {
  const decision = await secondTurnDecision(t, {
    startProxy,
    usage: { input_tokens: 2, cache_read_input_tokens: 500, output_tokens: 10 },
  });
  assert.equal(decision.tier, "haiku");
});
