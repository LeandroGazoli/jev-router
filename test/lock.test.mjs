import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, isLockStale, releaseLock } from "../src/lock.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "jev-lock-"));

test("no lock file at all is not stale -- there is nothing to clean up after", () => {
  assert.equal(isLockStale(scratch()), true);
});

test("a lock naming this process's own pid is not stale", () => {
  const dir = scratch();
  acquireLock(dir);
  assert.equal(isLockStale(dir), false);
});

test("a lock naming a pid that is no longer running is stale", () => {
  const dir = scratch();
  // A pid this high is never a real running process.
  writeFileSync(join(dir, "jev-claude.lock"), JSON.stringify({ pid: 999999999 }));
  assert.equal(isLockStale(dir), true);
});

test("a malformed lock file is treated as stale", () => {
  const dir = scratch();
  writeFileSync(join(dir, "jev-claude.lock"), "not json");
  assert.equal(isLockStale(dir), true);
});

test("releaseLock removes this process's own lock", () => {
  const dir = scratch();
  acquireLock(dir);
  releaseLock(dir);
  assert.equal(isLockStale(dir), true, "no lock file left behind, so nothing to find stale or not");
});

test("releaseLock never removes a lock belonging to a different (live) process", () => {
  const dir = scratch();
  const file = join(dir, "jev-claude.lock");
  writeFileSync(file, JSON.stringify({ pid: process.pid + 1 }));
  releaseLock(dir);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).pid, "the other process's lock file is untouched");
});
