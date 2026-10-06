// Shared scaffolding for the two context-guard test files (kept out of *.test.mjs so node --test
// does not run it as a test of its own).
import http from "node:http";
import { readLedger, readUsage } from "../src/status.mjs";

export async function startFake(t, usage) {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "m", type: "message", model: "claude-sonnet-5-5", usage }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  return `http://127.0.0.1:${upstream.address().port}`;
}

export const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.text());

export async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value && (!Array.isArray(value) || value.length)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

/** Two turns in one conversation: the router picks sonnet, then asks for haiku. Returns turn 2's decision. */
export async function secondTurnDecision(t, { usage, startProxy }) {
  const since = Date.now() - 1;
  const choices = ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"];
  const { port, close } = await startProxy({
    upstreamURL: await startFake(t, usage),
    route: async () => ({ choice: choices.shift(), confidence: 0.95, ms: 1 }),
  });
  t.after(close);
  const opening = `context guard ${process.pid} ${Math.random()}`;
  const turn = (extra = []) => ({
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: opening }, ...extra],
  });
  await post(port, turn());
  await until(() => readUsage({ since }));
  await post(port, turn([{ role: "assistant", content: "ok" }, { role: "user", content: "now something small" }]));
  const decisions = readLedger({ since }).filter((e) => e.cli === "claude");
  return decisions.at(-1);
}
