#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { launchDashboard } from "../src/dashboard-launch.mjs";
import { EXPORT_FORMATS } from "../src/export.mjs";
import { readLedger } from "../src/status.mjs";

const argv = process.argv.slice(2);

function portFrom(args) {
  const i = args.indexOf("--port");
  if (i !== -1 && args[i + 1] !== undefined) return Number(args[i + 1]);
  return undefined; // launchDashboard falls back to JEV_DASHBOARD_PORT, then 8787
}

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    [
      "Usage: jev-dashboard [--port <n>] [--open] [--new-token]",
      "       jev-dashboard --export <csv|json> [--out <file>]",
      "",
      "  --port <n>    port to listen on (default: JEV_DASHBOARD_PORT or 8787)",
      "  --open        open the dashboard in your default browser (or JEV_DASHBOARD_OPEN=1)",
      "  --new-token   replace the saved access token; previously shared links stop working",
      "  --export <f>  print the decision history as csv or json and exit (no server, no prompt text);",
      "                with --out <file> it is written to that file instead of stdout",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const exportAt = argv.indexOf("--export");
if (exportAt !== -1) {
  const format = EXPORT_FORMATS[argv[exportAt + 1]];
  if (!format) {
    process.stderr.write("[jev] --export needs a format: csv or json\n");
    process.exit(1);
  }
  const text = format.toText(readLedger({ limit: 100000 }));
  const outAt = argv.indexOf("--out");
  if (outAt !== -1 && argv[outAt + 1]) {
    writeFileSync(argv[outAt + 1], text);
    process.stderr.write(`[jev] wrote ${argv[outAt + 1]}\n`);
  } else {
    process.stdout.write(text);
  }
  process.exit(0);
}

let launched;
try {
  launched = await launchDashboard({
    port: portFrom(argv),
    open: argv.includes("--open") || process.env.JEV_DASHBOARD_OPEN === "1",
    rotate: argv.includes("--new-token"),
  });
} catch (err) {
  process.stderr.write(`[jev] dashboard: ${err.message}\n`);
  // exitCode rather than process.exit(): exiting while the probe's fetch handle is still closing
  // trips a libuv assertion on Windows and turns exit code 1 into 127.
  process.exitCode = 1;
}

if (launched) {
  const { url, close, alreadyRunning } = launched;
  process.stdout.write(`[jev] dashboard: ${url}\n`);
  if (alreadyRunning) {
    process.stdout.write("[jev] a dashboard is already running on this port; reusing it.\n");
  } else {
    process.stdout.write("[jev] read-only -- opening this URL never calls the router itself.\n");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        close();
        process.exit(0);
      });
    }
  }
}
