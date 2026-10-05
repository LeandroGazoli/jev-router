import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THRESHOLDS } from "../src/config.mjs";
import { PRODUCT_NAME, aggregate, parseWindow, reasonFamily, startDashboard } from "../src/dashboard.mjs";
import { appendRouting } from "../src/status.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "jev-calibration-"));

async function withDashboard(statusDir, run) {
  const { port, token, close } = await startDashboard({ statusDir });
  try {
    await run({ base: `http://127.0.0.1:${port}`, token });
  } finally {
    close();
  }
}

test("reasonFamily sorts every policy reason into what the page shows", () => {
  const cases = {
    jev: "accepted",
    "jev/no-change": "accepted",
    "risk-floor": "overruled",
    "risk-floor/no-change": "overruled",
    "low-confidence-no-downgrade/no-change": "overruled",
    "low-confidence-capped": "overruled",
    "downgrade-not-worth-cache-rebuild": "overruled",
    "gradual-step": "overruled",
    "jev+unavailable": "overruled",
    override: "override",
    "override/no-change": "override",
    "jev-unavailable/no-change": "unavailable",
  };
  for (const [reason, family] of Object.entries(cases)) assert.equal(reasonFamily(reason), family, reason);
  assert.equal(reasonFamily(undefined), "overruled", "an unknown reason is not silently counted as accepted");
});

test("aggregate cuts confidence at the router's own thresholds", () => {
  const t = { minConfidence: 0.3, stepUpConfidence: 0.6 };
  const stats = aggregate(
    [
      { at: 10, tier: "haiku", cli: "claude", confidence: 0.1, reason: "low-confidence-capped" },
      { at: 20, tier: "haiku", cli: "claude", confidence: 0.3, reason: "jev" },
      { at: 30, tier: "sonnet", cli: "codex", confidence: 0.59, reason: "gradual-step" },
      { at: 40, tier: "opus", cli: "claude", confidence: 0.6, reason: "jev/no-change" },
      { at: 50, tier: "opus", cli: "claude", confidence: null, reason: "jev-unavailable/no-change" },
      { at: 60, tier: "opus", cli: "claude", confidence: 0.95, reason: "override" },
    ],
    t,
  );
  assert.deepEqual(stats.bands, { low: 1, mid: 2, high: 2, unknown: 1 });
  assert.deepEqual(stats.outcomes, { accepted: 2, overruled: 2, override: 1, unavailable: 1 });
  assert.deepEqual(stats.byTier, { haiku: 2, sonnet: 1, opus: 3 });
  assert.deepEqual(stats.byCli, { claude: 5, codex: 1 });
  assert.equal(stats.total, 6);
  assert.equal(stats.first, 10);
  assert.equal(stats.last, 60);
});

test("aggregate handles an empty window", () => {
  const stats = aggregate([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.first, null);
  assert.deepEqual(stats.bands, { low: 0, mid: 0, high: 0, unknown: 0 });
});

test("parseWindow understands the four windows and rejects anything else", () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(parseWindow("1h", "24h", now), { name: "1h", since: now - 3_600_000 });
  assert.deepEqual(parseWindow(null, "24h", now), { name: "24h", since: now - 86_400_000 });
  assert.deepEqual(parseWindow("7d", "24h", now), { name: "7d", since: now - 604_800_000 });
  assert.deepEqual(parseWindow("all", "24h", now), { name: "all", since: undefined });
  assert.equal(parseWindow("forever", "24h", now), null);
  assert.equal(parseWindow("toString", "24h", now), null, "prototype keys are not windows");
});

test("/api/stats is token-protected, windowed, and carries the router's thresholds", async () => {
  const dir = scratch();
  const now = Date.now();
  appendRouting({ at: now - 30 * 60_000, cli: "claude", tier: "haiku", confidence: 0.9, reason: "jev" }, dir);
  appendRouting({ at: now - 5 * 3_600_000, cli: "claude", tier: "opus", confidence: 0.2, reason: "low-confidence-capped" }, dir);
  appendRouting({ at: now - 3 * 86_400_000, cli: "codex", tier: "sonnet", confidence: 0.5, reason: "risk-floor" }, dir);

  await withDashboard(dir, async ({ base, token }) => {
    assert.equal((await fetch(`${base}/api/stats`)).status, 401);

    const get = (query) => fetch(`${base}/api/stats?token=${token}&${query}`).then((r) => r.json());
    assert.equal((await get("window=1h")).stats.total, 1);
    assert.equal((await get("window=24h")).stats.total, 2);
    assert.equal((await get("window=7d")).stats.total, 3);
    assert.equal((await get("window=all")).stats.total, 3);
    assert.equal((await get("")).window, "24h", "24h is the default window");

    const body = await get("window=all");
    assert.deepEqual(body.thresholds, {
      minConfidence: THRESHOLDS.minConfidence,
      stepUpConfidence: THRESHOLDS.stepUpConfidence,
    });
    assert.deepEqual(body.stats.outcomes, { accepted: 1, overruled: 2, override: 0, unavailable: 0 });

    const bad = await fetch(`${base}/api/stats?token=${token}&window=forever`);
    assert.equal(bad.status, 400);
  });
});

test("opening the page without a valid token explains how to recover, and reveals nothing", async () => {
  await withDashboard(scratch(), async ({ base, token }) => {
    for (const url of [`${base}/`, `${base}/?token=wrong`]) {
      const res = await fetch(url);
      assert.equal(res.status, 401);
      assert.match(res.headers.get("content-type"), /text\/html/);
      const html = await res.text();
      assert.match(html, /jev-dashboard/);
      assert.match(html, /token/i);
      assert.ok(!html.includes(token), "the real token is never echoed");
    }
    const api = await fetch(`${base}/api/sessions`);
    assert.equal(api.status, 401);
    assert.match(api.headers.get("content-type"), /application\/json/, "the API stays machine-readable");
  });
});

test("/api/sessions keeps every session's prompt, not just the first one's", async () => {
  // Regression: .map(sessionView) passed the row index as the length limit, so the second row's
  // prompt was cut to one character, the third to two, and the first to nothing.
  const dir = scratch();
  const now = Date.now();
  const prompts = ["rename the variable foo to bar", "explain the difference between the two modes", "ok", "x".repeat(900)];
  prompts.forEach((prompt, i) => {
    writeFileSync(join(dir, `s${i}.json`), JSON.stringify({ tier: "haiku", confidence: 0.9, reason: "jev", at: now - i * 1000, prompt }));
  });
  await withDashboard(dir, async ({ base, token }) => {
    const sessions = await fetch(`${base}/api/sessions?token=${token}`).then((r) => r.json());
    const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s.prompt]));
    assert.equal(byId.s0, prompts[0]);
    assert.equal(byId.s1, prompts[1]);
    assert.equal(byId.s2, "ok");
    assert.equal(byId.s3, "x".repeat(400) + "…", "only a genuinely long prompt is cut, at 400 characters");
  });
});

test("/api/sessions sends only what the page shows, with the policy family", async () => {
  const dir = scratch();
  const now = Date.now();
  writeFileSync(
    join(dir, "s1.json"),
    JSON.stringify({
      tier: "sonnet",
      model: "claude-sonnet-5-5",
      confidence: 0.4,
      reason: "risk-floor",
      at: now,
      prompt: "x".repeat(900),
      jev: { request: { secret: "exact router exchange" } },
      history: [{ prompt: "an older prompt" }],
    }),
  );
  writeFileSync(join(dir, "s2.json"), JSON.stringify({ manual: true, at: now - 1000 }));

  await withDashboard(dir, async ({ base, token }) => {
    const sessions = await fetch(`${base}/api/sessions?token=${token}`).then((r) => r.json());
    const s1 = sessions.find((s) => s.sessionId === "s1");
    assert.equal(s1.family, "overruled");
    assert.equal(s1.model, "claude-sonnet-5-5");
    assert.ok(s1.prompt.length <= 401, "the prompt is cut for the listing");
    assert.ok(!("jev" in s1) && !("history" in s1), "the router exchange and older prompts stay out");
    assert.equal(sessions.find((s) => s.sessionId === "s2").family, "manual");
  });
});

test("export follows the window when one is given and keeps the whole ledger when not", async () => {
  const dir = scratch();
  const now = Date.now();
  appendRouting({ at: now - 10 * 60_000, cli: "claude", tier: "haiku", key: "recent" }, dir);
  appendRouting({ at: now - 3 * 86_400_000, cli: "claude", tier: "opus", key: "old" }, dir);

  await withDashboard(dir, async ({ base, token }) => {
    const windowed = await fetch(`${base}/api/export?format=csv&window=24h&token=${token}`);
    assert.match(windowed.headers.get("content-disposition"), /jev-routing-24h-\d{4}-\d{2}-\d{2}\.csv/);
    const rows = (await windowed.text()).trim().split("\r\n");
    assert.equal(rows.length, 2, "header plus the one entry inside the window");
    assert.ok(rows[1].includes("recent"));

    const whole = await fetch(`${base}/api/export?format=json&token=${token}`);
    assert.match(whole.headers.get("content-disposition"), /jev-routing-\d{4}-\d{2}-\d{2}\.json/);
    assert.equal((await whole.json()).length, 2);

    assert.equal((await fetch(`${base}/api/export?format=csv&window=nope&token=${token}`)).status, 400);
  });
});

test("the page carries the product name from one place and its script is valid", async () => {
  await withDashboard(scratch(), async ({ base, token }) => {
    const html = await fetch(`${base}/?token=${token}`).then((r) => r.text());
    assert.ok(!html.includes("{{PRODUCT_NAME}}"), "no placeholder left in the served page");
    assert.ok(html.includes(`<h1>${PRODUCT_NAME}</h1>`));
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script), "the inline script parses");
  });
  const source = readFileSync(new URL("../src/dashboard.html", import.meta.url), "utf8");
  assert.ok(!source.includes(PRODUCT_NAME), "the name is not hard-coded in the page source");
});
