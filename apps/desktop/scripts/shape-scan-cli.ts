// Scans files for credential shapes with the domain's own patterns, and prints which shapes each holds (never the
// text): `node shape-scan.mjs [--skip <name>]… (<file> | --tree <folder>)…`. A folder is walked whole, apart from the
// top-level entries --skip names. R3's live run (D37, NIV-45) runs it, bundled, with the staged node.exe on Windows for
// the profile, so a workspace is only ever read on its own OS (D7), and with Node in WSL for the engine's home and the
// evidence. A file that doesn't exist is reported as missing; an image is reported as one, since text can't be found
// in its pixels. A Token Factory key has no shape of its own, so this can't see one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secretShapes } from "@nivra/domain";

const args = process.argv.slice(2);
const skip = new Set<string>();
const files: string[] = [];
const walk = (folder: string, top: boolean): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (top && skip.has(entry.name)) return [];
    const path = join(folder, entry.name);
    return entry.isDirectory() ? walk(path, false) : entry.isFile() ? [path] : [];
  });
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (arg === "--skip") skip.add(args[++index] ?? "");
  else if (arg === "--tree") {
    const folder = args[++index] ?? "";
    files.push(...(existsSync(folder) ? walk(folder, true) : [folder]));
  } else files.push(arg);
}
if (files.length === 0) throw new Error("Usage: shape-scan.mjs [--skip <name>]… (<file> | --tree <folder>)…");
const found = files.map((file) => {
  if (!existsSync(file)) return { file, image: false, shapes: null };
  if (/\.(png|jpe?g|gif|webp|ico)$/i.test(file)) return { file, image: true, shapes: [] };
  return { file, image: false, shapes: [...new Set(secretShapes(readFileSync(file).toString("latin1")))] };
});
process.stdout.write(`${JSON.stringify(found)}\n`);
