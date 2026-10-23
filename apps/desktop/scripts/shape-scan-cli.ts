// Scans files for credential shapes with the domain's own patterns, and prints which shapes each holds (never the
// text): `node shape-scan.mjs <file>…`. R3's live run (D37, NIV-45) runs it, bundled, with the staged node.exe on
// Windows for the profile's files, so a workspace is only ever read on its own OS (D7), and with Node in WSL for the
// engine's. A file that doesn't exist is reported as missing.
import { existsSync, readFileSync } from "node:fs";
import { secretShapes } from "@nivra/domain";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("Usage: shape-scan.mjs <file>…");
const found = files.map((file) => ({ file, shapes: existsSync(file) ? [...new Set(secretShapes(readFileSync(file).toString("latin1")))] : null }));
process.stdout.write(`${JSON.stringify(found)}\n`);
