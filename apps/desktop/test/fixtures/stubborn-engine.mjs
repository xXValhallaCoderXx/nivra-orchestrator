// Stands in for an engine that starts but will not stop: it answers initialize and ping, then ignores shutdown and the
// end of its input, so only the quit order's last step (force) can stop it.
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
    const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    if (request.method === "initialize") {
      reply({ protocolVersion: 1, engineVersion: "stubborn", instanceId, pid: process.pid, home, homeId: randomUUID(), runtimeHash: null, node: process.versions.node, platform: process.platform, arch: process.arch });
    } else if (request.method === "ping") {
      reply({ instanceId });
    }
  }
});
process.stdin.on("end", () => undefined);
setInterval(() => undefined, 1_000);
