"use strict";
// Local image preparation. No image or collected data is sent to an AI service.
(() => {
  const profiles = { standard: { edge: 384, jpeg: 0.90 }, high: { edge: 768, jpeg: 0.94 }, maximum: { edge: 1280, jpeg: 0.96 } };
  const byteBudget = 128 * 1024 * 1024;
  function safeUrl(value) {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; }
  }
  function urls(output) {
    return [...new Set([...(output.products || []), ...(output.tasks || []).flatMap(task => task.products || [])].map(item => item.image_url).filter(value => safeUrl(value)))];
  }
  const origins = list => [...new Set(list.map(value => `${new URL(value).origin}/*`))];
  function candidates(value) {
    const url = safeUrl(value); if (!url) return [];
    const original = url.href;
    // Only known Alibaba/1688 CDN thumbnail suffixes are reversible. Preserve
    // arbitrary hosts, filenames, query transformations and signed URLs.
    const signed = [...url.searchParams.keys()].some(key => /^(?:sig|sign|signature|token|auth|expires|OSSAccessKeyId|x-(?:oss|amz)-(?:credential|signature))$/i.test(key));
    if (!signed && (url.hostname === "alicdn.com" || url.hostname.endsWith(".alicdn.com"))) {
      url.pathname = url.pathname.replace(/(\.(?:jpe?g|png))_\d{1,4}x\d{1,4}(?:xz)?(?:q\d{1,3})?\.(?:jpe?g|png|webp)(?:_\.webp)?$/i, "$1").replace(/(\.(?:jpe?g|png))_\.webp$/i, "$1");
    }
    return [...new Set([url.href, original])];
  }
  async function thumbnail(url, signal, profile) {
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
      // Keep real detail without manufacturing pixels in a small source image.
      const edge = Math.min(profile.edge, Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(edge, edge), context = canvas.getContext("2d");
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, edge, edge);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      const scale = Math.min(1, edge / bitmap.width, edge / bitmap.height);
      const width = bitmap.width * scale, height = bitmap.height * scale;
      context.drawImage(bitmap, (edge - width) / 2, (edge - height) / 2, width, height);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: profile.jpeg })).arrayBuffer());
      return { bytes, lowResolution: Math.max(bitmap.width, bitmap.height) < 256 };
    } finally { bitmap.close(); }
  }
  async function load(value, signal, profile) {
    let failure;
    for (const url of candidates(value)) {
      if (signal.aborted) throw new DOMException("Экспорт отменён", "AbortError");
      const controller = new AbortController(), abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true }); const timer = setTimeout(abort, 8000);
      try { return await thumbnail(url, controller.signal, profile); }
      catch (cause) { failure = cause; }
      finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
    }
    throw failure || new Error("Изображение недоступно");
  }
  async function collect(list, onProgress, signal, options = {}) {
    const profile = profiles[options.quality] || profiles.high;
    const thumbnails = new Map(); let next = 0, completed = 0, failed = 0, bytes = 0, lowResolution = 0;
    const progress = () => onProgress({ completed, failed, loaded: thumbnails.size, total: list.length, bytes, lowResolution });
    progress();
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
      while (next < list.length && !signal.aborted) {
        const url = list[next++];
        try {
          if (bytes >= byteBudget) throw new Error("Лимит изображений 128 МБ");
          const image = await load(url, signal, profile);
          if (signal.aborted) break;
          if (bytes + image.bytes.length > byteBudget) throw new Error("Лимит изображений 128 МБ");
          thumbnails.set(url, image.bytes); bytes += image.bytes.length; if (image.lowResolution) lowResolution++;
        } catch { if (!signal.aborted) failed++; }
        if (!signal.aborted) { completed++; progress(); }
      }
    }));
    if (signal.aborted) throw new DOMException("Экспорт отменён", "AbortError");
    return { thumbnails, failed, lowResolution };
  }
  globalThis.SupplierImages = { urls, origins, candidates, collect };
})();
