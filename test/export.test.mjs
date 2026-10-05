import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_COLUMNS, exportFilename, ledgerToCsv, ledgerToJson } from "../src/export.mjs";
import { startDashboard } from "../src/dashboard.mjs";
import { appendRouting } from "../src/status.mjs";

const entry = {
  at: Date.UTC(2026, 9, 5, 12, 0, 0),
  cli: "claude",
  tier: "haiku",
  model: "claude-haiku-4-5-20251001",
  confidence: 0.92,
  reason: "jev",
  key: "abc123",
  metrics: { taskComplexity: 0.1, reasoningRequired: 0.2, toolComplexity: 0, contextSize: 0.05 },
};

test("CSV has a header row, ISO times and the metrics flattened", () => {
  const [header, row] = ledgerToCsv([entry]).trim().split("\r\n");
  assert.equal(header, EXPORT_COLUMNS.join(","));
  assert.equal(row, "2026-10-05T12:00:00.000Z,claude,haiku,claude-haiku-4-5-20251001,0.92,jev,0.1,0.2,0,0.05,abc123");
});

test("missing fields become empty cells instead of 'undefined'", () => {
  const row = ledgerToCsv([{ at: 1 }]).trim().split("\r\n")[1];
  assert.ok(!row.includes("undefined") && !row.includes("null"));
  assert.equal(row.split(",").length, EXPORT_COLUMNS.length);
});

test("cells are quoted, and spreadsheet formulas are neutralised", () => {
  const csv = ledgerToCsv([{ ...entry, model: '=HYPERLINK("http://x")', reason: "a,b", cli: '+cmd|x' }]);
  const row = csv.trim().split("\r\n")[1];
  assert.match(row, /,"'=HYPERLINK\(""http:\/\/x""\)",/);
  assert.match(row, /,"a,b",/);
  assert.match(row, /,'\+cmd\|x,/);
});

test("no export ever contains a prompt or the Jev exchange", () => {
  const dirty = { ...entry, prompt: "SECRET PROMPT", jev: { request: "SECRET" } };
  assert.ok(!ledgerToCsv([dirty]).includes("SECRET"));
  assert.ok(!ledgerToJson([dirty]).includes("SECRET"));
});

test("JSON export is an array of the same flat rows", () => {
  const parsed = JSON.parse(ledgerToJson([entry]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].time, "2026-10-05T12:00:00.000Z");
  assert.equal(parsed[0].taskComplexity, 0.1);
});

test("exportFilename carries the date and format", () => {
  assert.equal(exportFilename("csv", new Date("2026-10-05T12:00:00Z")), "jev-routing-2026-10-05.csv");
});

test("/api/export needs the token, returns an attachment, and covers the whole ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-export-"));
  for (let i = 0; i < 1500; i++) appendRouting({ at: i + 1, cli: "claude", tier: "haiku", key: `k${i}` }, dir);
  const { port, token, close } = await startDashboard({ statusDir: dir });
  try {
    const base = `http://127.0.0.1:${port}/api/export`;
    assert.equal((await fetch(`${base}?format=csv`)).status, 401);

    const res = await fetch(`${base}?format=csv&token=${token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="jev-routing-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 1 + 1500, "more than the dashboard's 1000-entry view");

    const json = await fetch(`${base}?format=json&token=${token}`).then((r) => r.json());
    assert.equal(json.length, 1500);

    assert.equal((await fetch(`${base}?format=xml&token=${token}`)).status, 400);
  } finally {
    close();
  }
});
