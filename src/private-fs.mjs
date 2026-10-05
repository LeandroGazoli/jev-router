import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared by everything that writes a file only this user should be able to read or control:
// per-session status files, the temporary --settings file passed to Claude Code, and the
// restore of the user's own ~/.claude/settings.json.
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * A per-OS-user directory under the temp dir. On POSIX, folds the uid into the name so another
 * user sharing the same /tmp cannot pre-create (or pre-replace with a symlink) a directory with
 * a predictable, fixed name before this process ever runs -- a mode we chmod onto it afterwards
 * does nothing against that, since the attacker already controls what that path points to.
 * macOS and Windows temp dirs are already per-user, so the plain name is kept there.
 */
export function privateDirPath(baseName) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return join(tmpdir(), uid == null ? baseName : `${baseName}-${uid}`);
}

/**
 * Creates (or verifies) a directory meant to hold only this user's private files. Refuses to
 * use a path that already exists as a symlink, or that a different user owns -- chmod alone
 * cannot fix either case, since the path is already pointing somewhere the attacker chose.
 */
export function ensurePrivateDir(dir) {
  if (existsSync(dir)) {
    const current = lstatSync(dir);
    if (current.isSymbolicLink()) {
      throw new Error(`refusing to use ${dir}: it already exists as a symlink`);
    }
    if (typeof process.getuid === "function" && current.uid !== process.getuid()) {
      throw new Error(`refusing to use ${dir}: it is owned by another user`);
    }
  }
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // Tighten a directory created by an earlier version that did not set this mode.
  chmodSync(dir, DIR_MODE);
  return dir;
}

/**
 * Write-temp-then-rename so a crash mid-write never leaves a half-written file in place, and
 * so a file this process does not own is never truncated in place. Preserves the target's
 * existing permission mode when it already exists; otherwise uses `mode` (defaulting to
 * whatever the platform applies, same as a plain writeFileSync).
 */
export function atomicWriteFile(file, content, { mode } = {}) {
  let keepMode = mode;
  if (keepMode == null && existsSync(file)) {
    try {
      keepMode = statSync(file).mode & 0o777;
    } catch {
      // Could not stat it; fall through with whatever default the platform applies.
    }
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, keepMode == null ? undefined : { mode: keepMode });
  renameSync(tmp, file);
}

/**
 * Writes `name` inside `dir` as a private file (0600, inside a 0700 directory), refusing to
 * write through a symlink or over a file owned by another user. Combines ensurePrivateDir with
 * atomicWriteFile for the common case of "a file only I should ever read or control".
 */
export function writePrivateFile(dir, name, content) {
  ensurePrivateDir(dir);
  const file = join(dir, name);
  if (existsSync(file)) {
    const current = lstatSync(file);
    if (current.isSymbolicLink()) {
      throw new Error(`refusing to write ${file}: it already exists as a symlink`);
    }
    if (typeof process.getuid === "function" && current.uid !== process.getuid()) {
      throw new Error(`refusing to write ${file}: it is owned by another user`);
    }
  }
  atomicWriteFile(file, content, { mode: FILE_MODE });
  return file;
}
