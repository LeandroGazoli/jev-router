import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, ensurePrivateDir, privateDirPath, writePrivateFile } from "../src/private-fs.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "jev-private-fs-"));
const posixOnly = { skip: process.platform === "win32" ? "POSIX file modes/symlinks only" : false };

test("privateDirPath folds the uid into the name on POSIX", posixOnly, () => {
  const path = privateDirPath("jev-claude-test");
  assert.match(path, new RegExp(`jev-claude-test-${process.getuid()}$`));
});

test("ensurePrivateDir creates a 0700 directory", posixOnly, () => {
  const dir = join(scratch(), "nested", "status");
  ensurePrivateDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("ensurePrivateDir refuses a pre-existing symlink", posixOnly, () => {
  const base = scratch();
  const elsewhere = join(base, "attacker-controlled");
  mkdirSync(elsewhere);
  const link = join(base, "status");
  symlinkSync(elsewhere, link);
  assert.throws(() => ensurePrivateDir(link), /symlink/);
});

test("writePrivateFile writes 0600 inside the directory it creates", posixOnly, () => {
  const dir = scratch();
  const file = writePrivateFile(dir, "settings.json", JSON.stringify({ a: 1 }));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 });
});

test("writePrivateFile refuses to write through a symlinked file", posixOnly, () => {
  const dir = scratch();
  const elsewhere = join(dir, "..", "elsewhere.json");
  writeFileSync(elsewhere, "{}");
  symlinkSync(elsewhere, join(dir, "settings.json"));
  assert.throws(() => writePrivateFile(dir, "settings.json", "{}"), /symlink/);
});

test("atomicWriteFile leaves no temp file behind and the content is correct", () => {
  const dir = scratch();
  const file = join(dir, "settings.json");
  atomicWriteFile(file, JSON.stringify({ model: "opus" }));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "opus" });
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("atomicWriteFile preserves the target's existing mode", posixOnly, () => {
  const dir = scratch();
  const file = join(dir, "settings.json");
  writeFileSync(file, "{}", { mode: 0o640 });
  atomicWriteFile(file, JSON.stringify({ model: "opus" }));
  assert.equal(statSync(file).mode & 0o777, 0o640);
});
