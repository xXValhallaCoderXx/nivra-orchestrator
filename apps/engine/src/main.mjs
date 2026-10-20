// The engine's entry point (D2). It runs before anything else is imported, so that stdout carries JSON-RPC and
// nothing else: the real writer is kept for the protocol, and every other write to stdout goes to stderr. It stays a
// small unbundled file because in a bundle every external import would run before this code.
import { existsSync } from "node:fs";

process.env["MASTRA_TELEMETRY_DISABLED"] = "1";

const stdout = process.stdout;
const protocolWrite = stdout.write.bind(stdout);
stdout.write = function toStderr(chunk, encoding, callback) {
  return process.stderr.write(chunk, encoding, callback);
};
for (const level of ["log", "info", "debug"]) {
  console[level] = (...args) => console.error(...args);
}
globalThis[Symbol.for("nivra.protocol.write")] = protocolWrite;

// Staged runtimes ship the bundle beside this file; from source, Node runs the TypeScript directly.
const bundled = new URL("./engine.mjs", import.meta.url);
const entry = existsSync(bundled) ? bundled : new URL("./engine.ts", import.meta.url);
let main;
let crashReport;
try {
  ({ main, crashReport } = await import(entry.href));
} catch (error) {
  // The engine itself could not load: say so on the protocol, so the app can offer to provision the runtime again.
  const message = `The engine could not load (${error instanceof Error ? error.message : String(error)}). Reinstall Nivra, or let it provision this target again.`;
  console.error(message);
  protocolWrite(`${JSON.stringify({ jsonrpc: "2.0", method: "engine.fatal", params: { code: "runtime-broken", message } })}\n`, () => process.exit(5));
  await new Promise(() => {});
}
// An error no handler caught: one safe diagnostic line and Nivra's own words to the app, then exit (NIV-27). Node's own
// report, which this replaces, prints the error's message and properties, and they can quote the key or the repository.
let crashed = false;
const crash = (error) => {
  if (crashed) return;
  crashed = true;
  let report;
  try {
    report = crashReport(error);
  } catch {
    report = { line: 'diagnostic {"code":"crashed","stage":"process"}', message: "The engine stopped because something inside it failed." };
  }
  process.stderr.write(`${new Date().toISOString()} ${report.line}\n`);
  protocolWrite(`${JSON.stringify({ jsonrpc: "2.0", method: "engine.fatal", params: { code: "crashed", message: report.message } })}\n`, () => process.exit(6));
  // Exits even when the app's end of the pipe is gone and the write never completes.
  setTimeout(() => process.exit(6), 2_000).unref();
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

const code = await main(process.argv.slice(2));
// main() resolves once the last protocol line has been handed to the OS, so exiting now loses nothing; it also ends
// handles a library may have left open.
process.exit(code);
