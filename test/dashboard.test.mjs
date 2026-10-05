import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard.mjs";
import { appendRouting } from "../src/status.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "jev-dashboard-"));

async function withDashboard(statusDir, run) {
  const { port, token, close } = await startDashboard({ statusDir });
  try {
    await run({ port, token });
  } finally {
    close();
  }
}

test("every route requires the token", async (t) => {
  const dir = scratch();
  await withDashboard(dir, async ({ port, token }) => {
    for (const path of ["/", "/api/sessions", "/api/ledger"]) {
      const noToken = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(noToken.status, 401, `${path} without a token`);

      const wrongToken = await fetch(`http://127.0.0.1:${port}${path}?token=wrong`);
      assert.equal(wrongToken.status, 401, `${path} with the wrong token`);

      const queryToken = await fetch(`http://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`);
      assert.equal(queryToken.status, 200, `${path} with the correct token (query)`);

      const headerToken = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(headerToken.status, 200, `${path} with the correct token (header)`);
    }
  });
});

test("GET / serves the dashboard page", async (t) => {
  await withDashboard(scratch(), async ({ port, token }) => {
    const res = await fetch(`http://127.0.0.1:${port}/?token=${token}`);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await res.text(), /Jev Router/);
  });
});

test("GET /api/sessions reflects status files, truncated, excluding settings.json", async (t) => {
  const dir = scratch();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ statusLine: {} }));
  writeFileSync(
    join(dir, "s1.json"),
    JSON.stringify({ tier: "sonnet", confidence: 0.8, prompt: "x".repeat(500), at: 1 }),
  );

  await withDashboard(dir, async ({ port, token }) => {
    const sessions = await fetch(`http://127.0.0.1:${port}/api/sessions?token=${token}`).then((r) => r.json());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "s1");
    assert.ok(sessions[0].prompt.length < 500, "the prompt is truncated for the listing");
  });
});

test("GET /api/ledger never calls the router and returns aggregate stats", async (t) => {
  const dir = scratch();
  appendRouting({ at: 1, cli: "claude", tier: "haiku" }, dir);
  appendRouting({ at: 2, cli: "claude", tier: "haiku" }, dir);
  appendRouting({ at: 3, cli: "codex", tier: "opus" }, dir);

  await withDashboard(dir, async ({ port, token }) => {
    const body = await fetch(`http://127.0.0.1:${port}/api/ledger?token=${token}`).then((r) => r.json());
    assert.equal(body.entries.length, 3);
    assert.deepEqual(body.stats.byTier, { haiku: 2, opus: 1 });
    assert.deepEqual(body.stats.byCli, { claude: 2, codex: 1 });
  });
});

test("an unknown path is a 404, not a passthrough", async (t) => {
  await withDashboard(scratch(), async ({ port, token }) => {
    const res = await fetch(`http://127.0.0.1:${port}/not-a-route?token=${token}`);
    assert.equal(res.status, 404);
  });
});
