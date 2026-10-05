import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatExplanation } from "../src/explain.mjs";

test("formats the last routing decision", () => {
  const output = formatExplanation({
    prompt: "Explain the router architecture",
    tier: "sonnet",
    confidence: 0.94,
    reason: "jev",
    jev: {
      request: { state: { session: { current_model: "haiku", context_tokens: 6200 } } },
      // The model question's answer is an exact model id, not a tier name.
      response: { answers: { model: { choice: "claude-sonnet-5" } } },
    },
    metrics: {
      taskComplexity: 0.82,
      reasoningRequired: 0.91,
      toolComplexity: 0.64,
      contextSize: 0.31,
    },
  });

  assert.match(output, /Task complexity     0\.82/);
  assert.match(output, /Prompt: Explain the router/);
  assert.match(output, /Current tier: HAIKU/);
  assert.match(output, /Context tokens: 6200/);
  assert.match(output, /Recommended tier: SONNET/);
  assert.match(output, /Selected model: SONNET/);
  assert.match(output, /Confidence: 94%/);
  assert.match(output, /Decision: Jev recommendation/);
});

test("shows what Jev actually recommended even when policy overruled it", () => {
  // Jev's own recommendation (the model question's answer) was haiku, but a policy rule
  // (e.g. the risk floor) held the session at sonnet; the two rows must be allowed to differ.
  const output = formatExplanation({
    tier: "sonnet",
    model: "claude-sonnet-5",
    confidence: 0.6,
    reason: "risk-floor",
    jev: {
      response: { answers: { model: { choice: "claude-haiku-4-5-20251001" } } },
    },
  });

  assert.match(output, /Recommended tier: HAIKU/);
  assert.match(output, /Selected model: CLAUDE-SONNET-5/);
});

test("shows the concrete provider model when available", () => {
  assert.match(
    formatExplanation({ tier: "haiku", model: "gpt-5.6-luna", confidence: 0.99 }),
    /Selected model: GPT-5\.6-LUNA/,
  );
});

test("Claude skill pre-approves its read-only explanation command", () => {
  const skill = readFileSync(new URL("../.claude/skills/jev-explain/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^allowed-tools: Bash\(node \*\)$/m);
});
