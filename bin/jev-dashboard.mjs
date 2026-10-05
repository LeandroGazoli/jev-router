#!/usr/bin/env node
import { randomToken, startDashboard } from "../src/dashboard.mjs";

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i !== -1 && argv[i + 1] !== undefined) return Number(argv[i + 1]);
  return Number(process.env.JEV_DASHBOARD_PORT ?? 8787);
}

const token = randomToken();
const { port, close } = await startDashboard({ port: parsePort(process.argv.slice(2)), token });
const url = `http://127.0.0.1:${port}/?token=${token}`;

process.stdout.write(`[jev] dashboard: ${url}\n`);
process.stdout.write("[jev] read-only -- opening this URL never calls the router itself.\n");

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    close();
    process.exit(0);
  });
}
