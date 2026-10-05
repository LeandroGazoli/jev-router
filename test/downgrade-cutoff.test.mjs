import test from "node:test";
import assert from "node:assert/strict";

// THRESHOLDS.downgradeMaxContextTokens is read from JEV_DOWNGRADE_CUTOFF_TOKENS once, at module
// load. The env var has to be set before the first (dynamic) import of policy/config in this
// process, which is why this lives in its own file rather than alongside the other policy
// tests: node --test runs each test file in its own subprocess, so this is the first load here.
test("JEV_DOWNGRADE_CUTOFF_TOKENS lowers the cache-rebuild guard below the 20000 default", async () => {
  process.env.JEV_DOWNGRADE_CUTOFF_TOKENS = "1000";
  const { decide } = await import("../src/policy.mjs");

  const base = {
    prompt: "fix the bug",
    current: "opus",
    available: ["haiku", "sonnet", "opus"],
    jev: { choice: "haiku", confidence: 0.95 },
  };

  // Comfortably under the hardcoded 20000 default, but over the configured 1000 cutoff.
  const out = decide({ ...base, contextTokens: 5000 });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);

  // Under the configured cutoff too: the downgrade is still allowed.
  const allowed = decide({ ...base, contextTokens: 500 });
  assert.equal(allowed.tier, "haiku");

  delete process.env.JEV_DOWNGRADE_CUTOFF_TOKENS;
});
