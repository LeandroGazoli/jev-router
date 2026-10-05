// Export of the routing ledger. Deliberately limited to what routing.jsonl holds: no prompt
// text and no Jev exchange, so a file shared from here cannot leak what was typed.

export const EXPORT_COLUMNS = [
  "time",
  "cli",
  "tier",
  "model",
  "confidence",
  "reason",
  "taskComplexity",
  "reasoningRequired",
  "toolComplexity",
  "contextSize",
  "conversation",
];

const rowOf = (entry) => ({
  time: Number.isFinite(entry.at) ? new Date(entry.at).toISOString() : "",
  cli: entry.cli ?? "",
  tier: entry.tier ?? "",
  model: entry.model ?? "",
  confidence: entry.confidence ?? "",
  reason: entry.reason ?? "",
  taskComplexity: entry.metrics?.taskComplexity ?? "",
  reasoningRequired: entry.metrics?.reasoningRequired ?? "",
  toolComplexity: entry.metrics?.toolComplexity ?? "",
  contextSize: entry.metrics?.contextSize ?? "",
  conversation: entry.key ?? "",
});

/**
 * One CSV cell. Quotes when needed, and neutralises text a spreadsheet would run as a formula
 * (leading = + - @ or control characters) by prefixing an apostrophe -- values such as model ids
 * come from outside this program, and the file is meant to be opened in Excel or Sheets.
 */
function cell(value) {
  if (value === "" || value == null) return "";
  if (typeof value === "number") return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function ledgerToCsv(entries) {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const entry of entries) {
    const row = rowOf(entry);
    lines.push(EXPORT_COLUMNS.map((column) => cell(row[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function ledgerToJson(entries) {
  return `${JSON.stringify(entries.map(rowOf), null, 2)}\n`;
}

export const EXPORT_FORMATS = {
  csv: { toText: ledgerToCsv, type: "text/csv; charset=utf-8" },
  json: { toText: ledgerToJson, type: "application/json; charset=utf-8" },
};

/** `jev-routing-2026-10-05.csv`, or `jev-routing-24h-2026-10-05.csv` for a windowed export. */
export const exportFilename = (format, now = new Date(), windowName) =>
  `jev-routing${windowName ? `-${windowName}` : ""}-${now.toISOString().slice(0, 10)}.${format}`;
