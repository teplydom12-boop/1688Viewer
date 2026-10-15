"use strict";
// Local thumbnail generation. No image or collected data is sent to an AI service.
(() => {
  function urls(output) {
    return [...new Set([...(output.products || []), ...(output.tasks || []).flatMap(task => task.products || [])].map(item => item.image_url).filter(value => {
      try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
    }))];
  }
  const origins = list => [...new Set(list.map(value => `${new URL(value).origin}/*`))];
  async function thumbnail(url, signal) {
    const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Изображение недоступно");
    const limit = 8 * 1024 * 1024, reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > limit) throw new Error("Изображение больше 8 МБ"); chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const blob = new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
    const bitmap = await createImageBitmap(blob);
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error("Слишком большое изображение");
      const canvas = new OffscreenCanvas(96, 96), context = canvas.getContext("2d");
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, 96, 96);
      const scale = Math.min(96 / bitmap.width, 96 / bitmap.height);
      const width = bitmap.width * scale, height = bitmap.height * scale;
      context.drawImage(bitmap, (96 - width) / 2, (96 - height) / 2, width, height);
      return new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 })).arrayBuffer());
    } finally { bitmap.close(); }
  }
  async function collect(list, onProgress, signal) {
    const thumbnails = new Map(); let next = 0, completed = 0, failed = 0, bytes = 0;
    const progress = () => onProgress({ completed, failed, loaded: thumbnails.size, total: list.length });
    progress();
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
      while (next < list.length && !signal.aborted) {
        const url = list[next++], controller = new AbortController();
        const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 8000);
        try {
          if (bytes >= 32 * 1024 * 1024) throw new Error("Лимит миниатюр 32 МБ");
          const image = await thumbnail(url, controller.signal);
          if (signal.aborted) break;
          if (bytes + image.length > 32 * 1024 * 1024) throw new Error("Лимит миниатюр 32 МБ");
          thumbnails.set(url, image); bytes += image.length;
        } catch { if (!signal.aborted) failed++; }
        finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
        if (!signal.aborted) { completed++; progress(); }
      }
    }));
    if (signal.aborted) throw new DOMException("Экспорт отменён", "AbortError");
    return { thumbnails, failed };
  }
  globalThis.SupplierImages = { urls, origins, collect };
})();
