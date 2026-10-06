import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { aggregate, aggregateSignals } from "../src/dashboard.mjs";
import { startProxy } from "../src/proxy.mjs";
import { startCodexProxy } from "../src/codex-proxy.mjs";
import { appendRouting, appendSignal, readLedger, readSignals } from "../src/status.mjs";
import { syntheticKind } from "../src/synthetic.mjs";

test("syntheticKind recognises the machine-written prompts seen in real sessions", () => {
  const cases = {
    'Another Claude session sent a message:\n<teammate-message teammate_id="x">hi</teammate-message>': "peer-message",
    '<teammate-message teammate_id="team-lead" summary="s">hi</teammate-message>': "peer-message",
    "This session is being continued from a previous conversation that ran out of context.": "continuation",
    "[SUGGESTION MODE: Suggest what the user might naturally type next]": "suggestion",
    "The user stepped away and is coming back. Recap in under 40 words": "recap",
    "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.": "summary-request",
    "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>": "command",
    "<local-command-caveat>x</local-command-caveat>\n<command-name>/compact</command-name>\n<command-args></command-args>\n<local-command-stdout>ok</local-command-stdout>": "command",
  };
  for (const [prompt, kind] of Object.entries(cases)) assert.equal(syntheticKind(prompt), kind, prompt.slice(0, 40));
});

test("a turn a person typed is never marked synthetic", () => {
  for (const prompt of [
    "Renomeie a variavel foo para bar",
    "fix the failing test in /clear handling",
    "<command-name>/impeccable</command-name><command-args>critique the dashboard</command-args>",
    "<local-command-caveat>x</local-command-caveat>\n<command-name>/compact</command-name>\n<command-args></command-args>\n\no relatorio não capturou",
    "<system-reminder>x</system-reminder>\nfix the bug",
    "",
    undefined,
  ]) {
    assert.equal(syntheticKind(prompt), null, String(prompt).slice(0, 50));
  }
});

test("calibration counts leave synthetic turns out and report how many", () => {
  const stats = aggregate(
    [
      { at: 1, tier: "sonnet", cli: "claude", confidence: 0.9, reason: "jev" },
      { at: 2, tier: "sonnet", cli: "claude", confidence: 0.2, reason: "jev", synthetic: "continuation" },
      { at: 3, tier: "haiku", cli: "claude", confidence: 0.9, reason: "jev", synthetic: "command" },
    ],
    { minConfidence: 0.3, stepUpConfidence: 0.6 },
  );
  assert.equal(stats.total, 1);
  assert.equal(stats.synthetic, 2);
  assert.deepEqual(stats.byTier, { sonnet: 1 });
  assert.deepEqual(stats.bands, { low: 0, mid: 0, high: 1, unknown: 0 }, "the 0.2 from a synthetic turn is not a low-confidence decision");
});

test("aggregateSignals counts direction and how fast the correction came", () => {
  const signals = aggregateSignals([
    { kind: "manual-switch", from: "haiku", to: "opus", afterMs: 30_000 },
    { kind: "manual-switch", from: "sonnet", to: "haiku", afterMs: 3_600_000 },
    { kind: "manual-switch", from: "sonnet", to: "opus", afterMs: null },
    { kind: "something-else", from: "sonnet", to: "opus" },
  ]);
  assert.equal(signals.switches, 3);
  assert.equal(signals.toStronger, 2);
  assert.equal(signals.toWeaker, 1);
  assert.equal(signals.within10min, 1);
  assert.deepEqual(signals.byFrom, { haiku: 1, sonnet: 2 });
});

test("signals are kept apart from decisions", () => {
  const dir = `${process.env.JEV_STATUS_DIR}/signals-${process.pid}`;
  appendSignal({ at: 1, kind: "manual-switch", from: "sonnet", to: "opus" }, dir);
  assert.equal(readSignals({ dir }).length, 1);
  assert.equal(readLedger({ dir }).length, 0);
  appendRouting({ at: 2, tier: "haiku" }, dir);
  assert.equal(readSignals({ dir }).length, 1);
});

async function fakeUpstream(t) {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"m","type":"message","model":"claude-sonnet-5-5","usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  return `http://127.0.0.1:${upstream.address().port}`;
}

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.text());

test("switching model by hand after a routed decision is recorded once, with the direction", async (t) => {
  const since = Date.now() - 1;
  const { port, close } = await startProxy({
    upstreamURL: await fakeUpstream(t),
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.8, ms: 1 }),
  });
  t.after(close);
  const opening = `switch test ${process.pid}`;
  const convo = (model, extra = []) => ({
    model,
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: opening }, ...extra],
  });
  const key = (await import("../src/proxy.mjs")).conversationKey(convo("x"));

  await post(port, convo("jev-router"));
  assert.equal(readSignals({ since }).filter((s) => s.key === key).length, 0, "following the router is not a correction");

  await post(port, convo("claude-opus-5-5", [{ role: "assistant", content: "ok" }, { role: "user", content: "more" }]));
  await post(port, convo("claude-opus-5-5", [{ role: "assistant", content: "ok" }, { role: "user", content: "more" }]));
  const signals = readSignals({ since }).filter((s) => s.key === key);
  assert.equal(signals.length, 1, "one correction, however many requests follow it");
  assert.deepEqual([signals[0].kind, signals[0].from, signals[0].to, signals[0].cli], ["manual-switch", "sonnet", "opus", "claude"]);
  assert.ok(signals[0].afterMs >= 0 && signals[0].afterMs < 5000);

  // Back on the router, then away again: a second, separate correction.
  await post(port, convo("jev-router"));
  await post(port, convo("claude-haiku-4-5-20251001"));
  assert.equal(readSignals({ since }).filter((s) => s.key === key).length, 2);
});

test("a model chosen before the router decided anything, a sub-agent and an aux call are not corrections", async (t) => {
  const since = Date.now() - 1;
  const { port, close } = await startProxy({
    upstreamURL: await fakeUpstream(t),
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.8, ms: 1 }),
  });
  t.after(close);
  const n = process.pid;

  await post(port, { model: "claude-opus-5-5", tools: [{ name: "Bash" }], messages: [{ role: "user", content: `never routed ${n}` }] });

  await post(port, { model: "jev-router", tools: [{ name: "Bash" }], messages: [{ role: "user", content: `main ${n}` }] });
  await post(port, { model: "claude-haiku-4-5-20251001", tools: [{ name: "Read" }], messages: [{ role: "user", content: `explore sub-agent ${n}` }] });
  await post(port, { model: "claude-haiku-4-5-20251001", tools: [], messages: [{ role: "user", content: `main ${n}` }] });

  assert.deepEqual(readSignals({ since }), []);
});

test("a routed turn nobody typed is flagged in the ledger and still routed", async (t) => {
  const since = Date.now() - 1;
  let routed = 0;
  const { port, close } = await startProxy({
    upstreamURL: await fakeUpstream(t),
    route: async () => {
      routed += 1;
      return { choice: "claude-sonnet-5-5", confidence: 0.9, ms: 1 };
    },
  });
  t.after(close);
  const n = process.pid;
  await post(port, { model: "jev-router", tools: [{ name: "Bash" }], messages: [{ role: "user", content: `This session is being continued from a previous conversation ${n}` }] });
  await post(port, { model: "jev-router", tools: [{ name: "Bash" }], messages: [{ role: "user", content: `rename the variable ${n}` }] });

  assert.equal(routed, 2, "synthetic turns are routed like any other");
  const entries = readLedger({ since }).filter((e) => e.cli === "claude");
  assert.deepEqual(entries.map((e) => e.synthetic ?? null), ["continuation", null]);
});

test("a Codex model picked by hand after a routed decision is recorded", async (t) => {
  const since = Date.now() - 1;
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: `${base}/backend-api/codex`,
    apiBaseURL: `${base}/v1`,
    route: async () => ({ choice: "gpt-5.6-terra", confidence: 0.8, metrics: null }),
    statusId: `codex-disagree-${process.pid}`,
  });
  t.after(close);
  const send = (model, text) =>
    fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({
        model,
        prompt_cache_key: `disagree-${process.pid}`,
        input: [{ type: "additional_tools", role: "developer", tools: [{}] }, { role: "user", content: [{ type: "input_text", text }] }],
      }),
    }).then((r) => r.text());

  await send("jev-router", "refactor this module");
  await send("gpt-5.6-sol", "now do it properly");
  const [signal, ...rest] = readSignals({ since }).filter((s) => s.cli === "codex");
  assert.equal(rest.length, 0);
  assert.deepEqual([signal.from, signal.to], ["sonnet", "opus"]);
});
