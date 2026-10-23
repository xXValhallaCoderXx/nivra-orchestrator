import { readFileSync } from "node:fs";
import { seedPlan, seedProjectPlan, type ProjectSeed } from "./seed-workspace.ts";

// The staged node.exe runs this, bundled, on Windows, and prints what it made:
//   node seed.mjs <workspace.db> <question> <plan>             a general conversation's plan
//   node seed.mjs --project <user data folder> <seed.json>     a project conversation's plan (ProjectSeed)
const args = process.argv.slice(2);
if (args[0] === "--project") {
  const [, userData, seedPath] = args;
  if (!userData || !seedPath) throw new Error("Usage: seed.mjs --project <user data folder> <seed.json>");
  process.stdout.write(`${JSON.stringify(seedProjectPlan(userData, JSON.parse(readFileSync(seedPath, "utf8")) as ProjectSeed))}\n`);
} else {
  const [workspacePath, question, plan] = args;
  if (!workspacePath || !question || !plan) throw new Error("Usage: seed.mjs <workspace.db> <question> <plan>");
  process.stdout.write(`${JSON.stringify(seedPlan(workspacePath, { question, plan }))}\n`);
}
