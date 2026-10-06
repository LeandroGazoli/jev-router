import test from "node:test";
import assert from "node:assert/strict";
import { secondTurnDecision } from "./context-guard.helper.mjs";

// A TTL of zero means the cache is always already gone. Set before the first import of config.
process.env.JEV_CACHE_TTL_MS = "0";
const { startProxy } = await import("../src/proxy.mjs");

test("with the cache already expired, a large conversation can still move down", async (t) => {
  const decision = await secondTurnDecision(t, {
    startProxy,
    usage: { input_tokens: 2, cache_read_input_tokens: 100000, output_tokens: 10 },
  });
  assert.equal(decision.tier, "haiku");
});

test("but never into a model whose window it no longer fits", async (t) => {
  const decision = await secondTurnDecision(t, {
    startProxy,
    usage: { input_tokens: 2, cache_read_input_tokens: 170000, output_tokens: 10 },
  });
  assert.equal(decision.tier, "sonnet");
  assert.match(decision.reason, /context-too-large-for-tier/);
});
