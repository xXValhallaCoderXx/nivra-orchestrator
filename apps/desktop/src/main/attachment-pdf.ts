import { Worker } from "node:worker_threads";

export const PDF_REFUSED = "This PDF couldn't provide readable text within five pages, 20,000 characters and five seconds. Scanned, encrypted and unreadable PDFs can't be AI context. Attach relevant PNG or JPEG pages instead.";
export function extractPdf(bytes: Buffer, options: { workerUrl?: URL; timeoutMs?: number } = {}): Promise<string> {
  if (bytes.includes(Buffer.from("/Encrypt"))) return Promise.reject(new Error(PDF_REFUSED));
  return new Promise((resolve, reject) => {
    const worker = new Worker(options.workerUrl ?? new URL(import.meta.url.endsWith(".ts") ? "./pdf-worker.ts" : "./pdf-worker.js", import.meta.url), { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let done = false;
    const finish = (text?: string) => {
      if (done) return;
      done = true; clearTimeout(timer);
      void worker.terminate().then(() => text ? resolve(text) : reject(new Error(PDF_REFUSED)), () => reject(new Error(PDF_REFUSED)));
    };
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 5_000);
    worker.once("message", (value: { text?: unknown }) => finish(typeof value.text === "string" && value.text.length <= 20_000 ? value.text : undefined));
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
  });
}
