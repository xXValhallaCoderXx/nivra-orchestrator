import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

try {
  const bytes = new Uint8Array(workerData as Uint8Array);
  const options = { verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false };
  const pdf = await getDocumentProxy(bytes, options);
  try {
    if (pdf.numPages > 5) throw new Error("pages");
    let text = "";
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      if (!content.items.some((item) => "str" in item && item.str.trim())) throw new Error("scanned page");
      for (const item of content.items) {
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
        if (text.length > 20_000) throw new Error("text");
      }
      text += "\n";
    }
    if (!text.trim()) throw new Error("scanned");
    parentPort!.postMessage({ text: text.trim() });
  } finally { await pdf.cleanup(); }
} catch { parentPort!.postMessage({ refused: true }); }
