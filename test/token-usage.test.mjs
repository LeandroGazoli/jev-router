import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createUsageTap, tapResponse, usageFrom } from "../src/usage.mjs";
import { aggregateUsage, promptPreview, startDashboard } from "../src/dashboard.mjs";
import { startProxy } from "../src/proxy.mjs";
import { startCodexProxy } from "../src/codex-proxy.mjs";
import { appendRouting, appendUsage, readLedger, readUsage } from "../src/status.mjs";
import { ledgerToCsv, usageToCsv } from "../src/export.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "jev-usage-"));
const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

// What the Messages API streams: the input figures arrive first, the final output count last.
const ANTHROPIC_STREAM = sse([
  ["message_start", { type: "message_start", message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 120, cache_creation_input_tokens: 30, cache_read_input_tokens: 4000, output_tokens: 1 } } }],
  ["content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: 'the word "usage" and é' } }],
  ["message_delta", { type: "message_delta", delta: {}, usage: { output_tokens: 57 } }],
]);

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value && (!Array.isArray(value) || value.length)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

test("usageFrom reads Anthropic events and keeps the four kinds apart", () => {
  const start = usageFrom({ type: "message_start", message: { model: "m", usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 2, output_tokens: 1 } } });
  assert.deepEqual(start, { tokens: { input: 5, cacheRead: 7, cacheWrite: 2, output: 1 }, model: "m" });
  assert.deepEqual(usageFrom({ type: "message_delta", usage: { output_tokens: 9 } }).tokens, { output: 9 });
  assert.deepEqual(usageFrom({ type: "message", model: "m", usage: { input_tokens: 1, output_tokens: 2 } }).tokens, { input: 1, output: 2 });
});

test("usageFrom takes the cached part out of OpenAI's input count so the kinds do not overlap", () => {
  const found = usageFrom({
    type: "response.completed",
    response: { model: "gpt-5.6-sol", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50, total_tokens: 1050 } },
  });
  assert.deepEqual(found.tokens, { input: 200, cacheRead: 800, output: 50 });
  assert.equal(found.model, "gpt-5.6-sol");
});

test("usageFrom ignores events without usable counts", () => {
  assert.equal(usageFrom({ type: "ping" }), null);
  assert.equal(usageFrom({ usage: {} }), null);
  assert.equal(usageFrom({ usage: { input_tokens: "lots", output_tokens: -3 } }), null);
  assert.equal(usageFrom(null), null);
});

test("the tap finds usage in a stream cut at any byte, including inside a multi-byte character", () => {
  const bytes = Buffer.from(ANTHROPIC_STREAM);
  for (const size of [1, 3, 7, 64, bytes.length]) {
    const tap = createUsageTap();
    for (let i = 0; i < bytes.length; i += size) tap.write(bytes.subarray(i, i + size));
    const { tokens, model } = tap.result();
    assert.deepEqual(tokens, { input: 120, cacheRead: 4000, cacheWrite: 30, output: 57 }, `chunk size ${size}`);
    assert.equal(model, "claude-sonnet-5-5");
  }
});

test("the tap reads a non-streaming body and returns nothing when there is no usage", () => {
  const tap = createUsageTap();
  tap.write(JSON.stringify({ id: "m", type: "message", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 11, output_tokens: 4 } }));
  assert.deepEqual(tap.result().tokens, { input: 11, output: 4 });

  const empty = createUsageTap();
  empty.write('{"type":"error","error":{"message":"overloaded"}}');
  assert.equal(empty.result(), null);
});

test("text the model wrote about usage is not mistaken for usage", () => {
  const tap = createUsageTap();
  tap.write(sse([["content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: '{"usage":{"input_tokens":999999}}' } }]]));
  assert.equal(tap.result(), null);
});

test("tapResponse undoes gzip and reports once", async () => {
  const up = Readable.from([gzipSync(ANTHROPIC_STREAM)]);
  up.headers = { "content-encoding": "gzip" };
  let calls = 0;
  const result = await new Promise((resolve) => {
    tapResponse(up, (found) => {
      calls += 1;
      resolve(found);
    });
  });
  assert.equal(result.tokens.cacheRead, 4000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

test("tapResponse skips an encoding it cannot undo instead of guessing", async () => {
  const up = Readable.from([Buffer.from("not readable")]);
  up.headers = { "content-encoding": "zstd" };
  let called = false;
  tapResponse(up, () => (called = true));
  up.resume();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(called, false);
});

async function fakeUpstream(t, respond) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(req.url);
      respond(req, res);
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  return { url: `http://127.0.0.1:${upstream.address().port}`, seen };
}

test("a routed Claude request records the tokens the API reported, under the session and tier", async (t) => {
  const { url } = await fakeUpstream(t, (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end(ANTHROPIC_STREAM);
  });
  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.8, ms: 1 }),
  });
  t.after(close);
  const session = `00000000-0000-4000-8000-${String(process.pid).padStart(12, "0")}`;
  const since = Date.now() - 1;

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      metadata: { user_id: JSON.stringify({ session_id: session }) },
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "rename this variable" }],
    }),
  });
  assert.match(await response.text(), /message_delta/, "the client still receives the whole stream");

  const [entry] = await until(() => readUsage({ since }).filter((e) => e.session === session));
  assert.equal(entry.cli, "claude");
  assert.equal(entry.tier, "sonnet");
  assert.equal(entry.routed, true);
  assert.equal(entry.model, "claude-sonnet-5-5");
  assert.deepEqual([entry.input, entry.cacheRead, entry.cacheWrite, entry.output], [120, 4000, 30, 57]);
  assert.ok(!JSON.stringify(entry).includes("rename this variable"), "no prompt text is recorded");
});

test("a request on a model the user picked is counted too, and token counting is not", async (t) => {
  const { url, seen } = await fakeUpstream(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      req.url.includes("count_tokens")
        ? '{"input_tokens":4242}'
        : '{"id":"m","type":"message","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":3}}',
    );
  });
  const { port, close } = await startProxy({ upstreamURL: url });
  t.after(close);
  const session = `11111111-0000-4000-8000-${String(process.pid).padStart(12, "0")}`;
  const since = Date.now() - 1;
  const body = {
    model: "claude-opus-5-5",
    metadata: { user_id: JSON.stringify({ session_id: session }) },
    messages: [{ role: "user", content: "hello" }],
  };
  const post = (path) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.text());

  await post("/v1/messages/count_tokens");
  await post("/v1/messages");

  const entries = await until(() => readUsage({ since }).filter((e) => e.session === session));
  assert.equal(entries.length, 1, "only the real request is spend");
  assert.equal(entries[0].routed, false);
  assert.equal(entries[0].tier, "opus");
  assert.deepEqual([entries[0].input, entries[0].output], [10, 3]);
  assert.equal(seen.length, 2);
});

test("a Codex response records tokens with the cached part split out", async (t) => {
  const { url } = await fakeUpstream(t, (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end(
      sse([
        ["response.created", { type: "response.created", response: { id: "r1" } }],
        ["response.completed", { type: "response.completed", response: { id: "r1", model: "gpt-5.6-terra", usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 300 }, output_tokens: 40 } } }],
      ]),
    );
  });
  const statusId = `codex-usage-${process.pid}`;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: `${url}/backend-api/codex`,
    apiBaseURL: `${url}/v1`,
    statusId,
  });
  t.after(close);
  const since = Date.now() - 1;

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ model: "gpt-5.6-terra", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
  }).then((r) => r.text());

  const [entry] = await until(() => readUsage({ since }).filter((e) => e.session === statusId));
  assert.equal(entry.cli, "codex");
  assert.equal(entry.tier, "sonnet", "terra is the balanced tier");
  assert.deepEqual([entry.input, entry.cacheRead, entry.output], [200, 300, 40]);
});

test("usage and decisions live in separate ledgers", () => {
  const dir = scratch();
  appendUsage({ at: 1, cli: "claude", session: "s", tier: "haiku", input: 1 }, dir);
  assert.equal(readUsage({ dir }).length, 1);
  assert.equal(readLedger({ dir }).length, 0, "a token record is not a routing decision");
  appendRouting({ at: 2, cli: "claude", tier: "haiku" }, dir);
  assert.equal(readUsage({ dir }).length, 1);
  assert.equal(readLedger({ dir }).length, 1);
});

test("aggregateUsage keeps the kinds apart and breaks spend down by tier and CLI", () => {
  const usage = aggregateUsage([
    { cli: "claude", tier: "haiku", input: 10, cacheRead: 100, cacheWrite: 5, output: 1 },
    { cli: "claude", tier: "opus", input: 20, cacheRead: 0, cacheWrite: 0, output: 30 },
    { cli: "codex", tier: "opus", input: 1, output: 2 },
  ]);
  assert.equal(usage.requests, 3);
  assert.deepEqual([usage.input, usage.cacheRead, usage.cacheWrite, usage.output], [31, 100, 5, 33]);
  assert.equal(usage.total, 169);
  assert.equal(usage.byTier.opus.requests, 2);
  assert.equal(usage.byTier.opus.total, 53);
  assert.equal(usage.byCli.codex.total, 3);
  assert.deepEqual(aggregateUsage([]), { requests: 0, total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, byTier: {}, byCli: {} });
});

test("promptPreview shows what was typed, not the wrapper Claude Code puts around it", () => {
  const compact =
    "<local-command-caveat>The command below was run directly.</local-command-caveat>\n\n<command-name>/compact</command-name>\n  <command-message>compact</command-message>\n  <command-args></command-args>\n\n<local-command-stdout>Compacted</local-command-stdout>\n\no relatorio não capturou";
  assert.equal(promptPreview(compact), "/compact o relatorio não capturou");
  assert.equal(promptPreview("<system-reminder>noise</system-reminder>\nfix the bug"), "fix the bug");
  assert.equal(promptPreview("<command-name>/clear</command-name>"), "/clear");
  assert.equal(promptPreview("<system-reminder>only noise</system-reminder>"), undefined);
  assert.equal(promptPreview(undefined), undefined);
  assert.equal(promptPreview("x".repeat(500), 10), `${"x".repeat(10)}…`);
});

test("the sessions listing carries tokens, last activity and recent turns", async () => {
  const dir = scratch();
  const now = Date.now();
  writeFileSync(
    join(dir, "s1.json"),
    JSON.stringify({
      tier: "sonnet",
      model: "claude-sonnet-5-5",
      confidence: 0.8,
      reason: "jev",
      at: now - 20 * 60_000,
      prompt: "latest question",
      history: [
        { at: now - 40 * 60_000, tier: "haiku", confidence: 0.9, reason: "jev", prompt: "<system-reminder>x</system-reminder>first question" },
        { at: now - 20 * 60_000, tier: "sonnet", confidence: 0.8, reason: "jev", prompt: "latest question" },
      ],
    }),
  );
  appendUsage({ at: now - 60_000, cli: "claude", session: "s1", tier: "sonnet", input: 5, cacheRead: 90, cacheWrite: 1, output: 4 }, dir);
  appendUsage({ at: now - 30_000, cli: "claude", session: "s1", tier: "sonnet", input: 5, output: 6 }, dir);
  appendUsage({ at: now, cli: "claude", session: "other", tier: "opus", input: 7000 }, dir);

  const { port, token, close } = await startDashboard({ statusDir: dir });
  try {
    const base = `http://127.0.0.1:${port}`;
    const [s1] = await fetch(`${base}/api/sessions?token=${token}`).then((r) => r.json());
    assert.deepEqual(s1.tokens, { requests: 2, total: 111, input: 10, output: 10, cacheRead: 90, cacheWrite: 1 });
    assert.equal(s1.activeAt, now - 30_000, "activity is the last request, which is newer than the last decision");
    assert.equal(s1.at, now - 20 * 60_000);
    assert.deepEqual(s1.recent.map((turn) => turn.prompt), ["latest question", "first question"], "newest first, wrapper stripped");

    const stats = await fetch(`${base}/api/stats?window=1h&token=${token}`).then((r) => r.json());
    assert.equal(stats.usage.requests, 3);
    assert.equal(stats.usage.byTier.opus.total, 7000);
    assert.equal(stats.usage.total, 7111);
  } finally {
    close();
  }
});

test("token usage exports as CSV and JSON, follows the window, and carries no prompt text", async () => {
  const dir = scratch();
  const now = Date.now();
  appendUsage({ at: now - 60_000, cli: "claude", session: "recent", tier: "haiku", model: "m", routed: true, input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, dir);
  appendUsage({ at: now - 3 * 86_400_000, cli: "claude", session: "old", tier: "opus", input: 9 }, dir);
  const { port, token, close } = await startDashboard({ statusDir: dir });
  try {
    const base = `http://127.0.0.1:${port}`;
    const csv = await fetch(`${base}/api/export?kind=tokens&format=csv&window=24h&token=${token}`);
    assert.match(csv.headers.get("content-disposition"), /jev-tokens-24h-\d{4}-\d{2}-\d{2}\.csv/);
    const rows = (await csv.text()).trim().split("\r\n");
    assert.equal(rows.length, 2);
    assert.ok(rows[0].endsWith("input,cacheRead,cacheWrite,output,total"));
    assert.ok(rows[1].endsWith(",1,2,3,4,10"), "the total is the sum of the four kinds");

    const all = await fetch(`${base}/api/export?kind=tokens&format=json&token=${token}`).then((r) => r.json());
    assert.equal(all.length, 2);
    assert.equal(all[1].total, 9);

    assert.equal((await fetch(`${base}/api/export?kind=bogus&format=csv&token=${token}`)).status, 400);
    const decisions = await fetch(`${base}/api/export?format=csv&token=${token}`);
    assert.match(decisions.headers.get("content-disposition"), /jev-routing-/, "the default export is unchanged");
  } finally {
    close();
  }
  assert.ok(usageToCsv([{ at: 0, session: "=cmd" }]).includes("'=cmd"), "formula cells are neutralised");
  assert.ok(ledgerToCsv([]).length > 0);
});

test("a corrupt usage line is skipped rather than breaking the reader", () => {
  const dir = scratch();
  appendUsage({ at: 1, cli: "claude", session: "a", input: 1 }, dir);
  writeFileSync(join(dir, "usage.jsonl"), `${readFileSync(join(dir, "usage.jsonl"), "utf8")}{not json\n`);
  appendUsage({ at: 2, cli: "claude", session: "b", input: 2 }, dir);
  assert.deepEqual(readUsage({ dir }).map((e) => e.session), ["a", "b"]);
});
