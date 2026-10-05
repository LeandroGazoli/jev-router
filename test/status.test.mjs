import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRouting, listStatuses, readLedger, rotateLedgerIfLarge } from "../src/status.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "jev-status-"));

test("appendRouting/readLedger round-trip, oldest first, without any prompt field", () => {
  const dir = scratch();
  appendRouting({ at: 1, cli: "claude", tier: "haiku", confidence: 0.9 }, dir);
  appendRouting({ at: 2, cli: "codex", tier: "opus", confidence: 0.4 }, dir);

  const entries = readLedger({ dir });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.tier), ["haiku", "opus"]);
  assert.ok(!("prompt" in entries[0]), "the ledger must never carry prompt text");
});

test("readLedger filters by `since` and caps with `limit`", () => {
  const dir = scratch();
  for (let i = 0; i < 5; i++) appendRouting({ at: i, tier: "sonnet" }, dir);

  assert.deepEqual(readLedger({ dir, since: 3 }).map((e) => e.at), [3, 4]);
  assert.deepEqual(readLedger({ dir, limit: 2 }).map((e) => e.at), [3, 4]);
});

test("readLedger returns an empty array when no ledger exists yet", () => {
  assert.deepEqual(readLedger({ dir: scratch() }), []);
});

test("rotateLedgerIfLarge keeps only the most recent lines", () => {
  const dir = scratch();
  for (let i = 0; i < 10; i++) appendRouting({ at: i, tier: "haiku" }, dir);
  rotateLedgerIfLarge(join(dir, "routing.jsonl"), 3);
  assert.deepEqual(readLedger({ dir }).map((e) => e.at), [7, 8, 9]);
});

test("listStatuses lists every session, newest first, and ignores settings.json", () => {
  const dir = scratch();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ statusLine: {} }));
  writeFileSync(join(dir, "old.json"), JSON.stringify({ tier: "haiku", at: 1 }));
  writeFileSync(join(dir, "new.json"), JSON.stringify({ tier: "opus", at: 2 }));
  writeFileSync(join(dir, "broken.json"), "not json");

  const sessions = listStatuses(dir);
  assert.deepEqual(
    sessions.map((s) => s.sessionId),
    ["new", "old"],
  );
  assert.equal(sessions[0].tier, "opus");
});

test("listStatuses returns an empty array for a directory that does not exist", () => {
  assert.deepEqual(listStatuses(join(tmpdir(), "jev-status-does-not-exist")), []);
});
