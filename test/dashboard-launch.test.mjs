import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardToken, launchDashboard, openCommand } from "../src/dashboard-launch.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "jev-launch-"));

test("the token is created once and then reused, so the link is stable", () => {
  const dir = scratch();
  const first = dashboardToken({ dir });
  assert.match(first, /^[\w-]{16,}$/);
  assert.equal(dashboardToken({ dir }), first);
});

test("rotating replaces the token and the new one is persisted", () => {
  const dir = scratch();
  const first = dashboardToken({ dir });
  const rotated = dashboardToken({ dir, rotate: true });
  assert.notEqual(rotated, first);
  assert.equal(dashboardToken({ dir }), rotated);
});

test("the token file is private to its owner", { skip: process.platform === "win32" }, () => {
  const dir = scratch();
  dashboardToken({ dir });
  assert.equal(statSync(join(dir, "dashboard.token")).mode & 0o777, 0o600);
});

test("a garbage token file is replaced rather than trusted", () => {
  const dir = scratch();
  dashboardToken({ dir });
  writeFileSync(join(dir, "dashboard.token"), "x"); // too short to be a real token
  const token = dashboardToken({ dir });
  assert.notEqual(token, "x");
  assert.match(token, /^[\w-]{16,}$/);
});

test("openCommand picks the platform opener and refuses a URL that is not ours", () => {
  const url = "http://127.0.0.1:8787/?token=abc_DEF-123";
  assert.deepEqual(openCommand(url, "win32"), { file: "cmd", args: ["/c", "start", "", url] });
  assert.deepEqual(openCommand(url, "darwin"), { file: "open", args: [url] });
  assert.deepEqual(openCommand(url, "linux"), { file: "xdg-open", args: [url] });
  assert.equal(openCommand("http://evil.example/?token=x", "win32"), null);
  assert.equal(openCommand("http://127.0.0.1:1/?token=a&calc", "win32"), null);
});

test("launchDashboard serves with the stable token and the URL works", async () => {
  const dir = scratch();
  const { url, close, alreadyRunning } = await launchDashboard({ port: 0, statusDir: dir });
  try {
    assert.equal(alreadyRunning, false);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url.replace(/token=.*/, "token=wrong"))).status, 401);
  } finally {
    close();
  }
});

test("a second launch on a busy port reuses the running dashboard with the same link", async () => {
  const dir = scratch();
  const first = await launchDashboard({ port: 0, statusDir: dir });
  try {
    const port = Number(new URL(first.url).port);
    const second = await launchDashboard({ port, statusDir: dir });
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.url, first.url);
    assert.equal((await fetch(second.url)).status, 200);
  } finally {
    first.close();
  }
});

test("rotating while another dashboard holds the port is refused, not silently wrong", async () => {
  const dir = scratch();
  const first = await launchDashboard({ port: 0, statusDir: dir });
  try {
    const port = Number(new URL(first.url).port);
    await assert.rejects(launchDashboard({ port, statusDir: dir, rotate: true }), /still accepts the old token/);
    // The refused rotation must not have replaced the saved token the running dashboard uses.
    assert.equal(dashboardToken({ dir }), new URL(first.url).searchParams.get("token"));
  } finally {
    first.close();
  }
});

test("a port held by something that is not a dashboard is an error, not a dead link", async () => {
  const blocker = net.createServer((socket) => socket.destroy()).listen(0, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  try {
    await assert.rejects(
      launchDashboard({ port: blocker.address().port, statusDir: scratch() }),
      /not this dashboard/,
    );
  } finally {
    blocker.close();
  }
});

test("rotating on a free port serves the new token and persists it", async () => {
  const dir = scratch();
  const old = dashboardToken({ dir });
  const { url, close } = await launchDashboard({ port: 0, statusDir: dir, rotate: true });
  try {
    const token = new URL(url).searchParams.get("token");
    assert.notEqual(token, old);
    assert.equal(dashboardToken({ dir }), token);
    assert.equal((await fetch(url)).status, 200);
  } finally {
    close();
  }
});

test("an unrelated local server that answers 200 to everything is not mistaken for the dashboard", async () => {
  const http = await import("node:http");
  const other = http.createServer((req, res) => res.end("hello")).listen(0, "127.0.0.1");
  await new Promise((r) => other.once("listening", r));
  try {
    await assert.rejects(
      launchDashboard({ port: other.address().port, statusDir: scratch() }),
      /not this dashboard/,
    );
  } finally {
    other.close();
    other.closeAllConnections();
  }
});
