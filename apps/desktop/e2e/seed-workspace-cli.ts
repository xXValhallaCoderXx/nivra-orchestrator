import { seedPlan } from "./seed-workspace.ts";

// The staged node.exe runs this, bundled, on Windows: `node seed.mjs <workspace.db> <question> <plan>` prints what it made.
const [workspacePath, question, plan] = process.argv.slice(2);
if (!workspacePath || !question || !plan) throw new Error("Usage: seed.mjs <workspace.db> <question> <plan>");
process.stdout.write(`${JSON.stringify(seedPlan(workspacePath, { question, plan }))}\n`);
