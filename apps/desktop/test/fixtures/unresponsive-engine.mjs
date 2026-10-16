// Stands in for an engine that starts, then hangs: it answers initialize and nothing after it (no ping, no shutdown),
// ignores the end of its input, and stays alive, so the supervisor has to notice the silence and force it down.
import { randomUUID } from "node:crypto";

const home = process.argv[process.argv.indexOf("--home") + 1];
const instanceId = process.argv[process.argv.indexOf("--instance") + 1] || randomUUID();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (request.method === "initialize") {
      const result = { protocolVersion: 1, engineVersion: "unresponsive", instanceId, pid: process.pid, home, runtimeHash: null, node: process.versions.node, platform: process.platform, arch: process.arch };
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    }
  }
});
process.stdin.on("end", () => undefined);
setInterval(() => undefined, 1_000);
