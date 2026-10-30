const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<string>) => void) | null; postMessage(value: { base64?: string; error?: string }): void };
scope.onmessage = async (event) => {
  try {
    const [header, data] = event.data.split(",");
    if (!header || !data) throw new Error("image");
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: header.slice(5).split(";")[0] }));
    try {
      if (bitmap.width * bitmap.height > 16_000_000) throw new Error("pixels");
      let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      for (let pass = 0; pass < 16; pass++) {
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const png = await canvas.convertToBlob({ type: "image/png" });
        if (png.size <= 1024 * 1024) {
          const prepared = new Uint8Array(await png.arrayBuffer());
          let binary = "";
          for (let at = 0; at < prepared.length; at += 8192) binary += String.fromCharCode(...prepared.subarray(at, at + 8192));
          scope.postMessage({ base64: btoa(binary) });
          return;
        }
        scale *= 0.8;
      }
      throw new Error("size");
    } finally { bitmap.close(); }
  } catch { scope.postMessage({ error: "Chromium couldn't prepare this image within the image limits. Export a smaller static PNG or JPEG and attach it again." }); }
};
export {};
