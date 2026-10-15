"use strict";
const $ = id => document.getElementById(id);
const taskId = new URLSearchParams(location.search).get("task");
let snapshot = null, imageUrls = [], requiredOrigins = [], controller = null, downloadUrl = null;
function error(message) { $("error").textContent = message; $("error").hidden = false; }
function cleanupUrl() { if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
window.addEventListener("pagehide", () => { controller?.abort(); cleanupUrl(); });
$("cancel").addEventListener("click", () => controller?.abort());
async function initialize() {
  try {
    const response = await chrome.runtime.sendMessage({ target: "1688-background", type: "EXCEL_DATA", options: { task_id: taskId } });
    if (!response?.ok) throw new Error(response?.error || "Не удалось получить данные");
    snapshot = response.result; imageUrls = SupplierImages.urls(snapshot);
    const origins = SupplierImages.origins(imageUrls);
    const permissions = await Promise.all(origins.map(async origin => await chrome.permissions.contains({ origins: [origin] }) ? null : origin));
    requiredOrigins = permissions.filter(Boolean);
    $("summary").textContent = `${taskId ? "Выбранная проверка" : "Вся память"}: ${snapshot.total_products} товаров · ${snapshot.total_tasks} проверок · ${imageUrls.length} разных изображений. Снимок данных на ${new Date(snapshot.exported_at).toLocaleString("ru-RU")}.`;
    $("download").disabled = false;
  } catch (cause) { error(cause.message); }
}
$("download").addEventListener("click", () => {
  if (!snapshot || controller) return;
  const includeImages = $("include-images").checked;
  // Start permission request directly in the user's click handler.
  const permission = includeImages && requiredOrigins.length ? chrome.permissions.request({ origins: requiredOrigins }) : Promise.resolve(true);
  controller = new AbortController();
  const signal = controller.signal;
  $("download").disabled = true; $("include-images").disabled = true; $("cancel").hidden = false;
  $("error").hidden = true; $("status").textContent = "Подготавливаю экспорт…";
  void (async () => {
    try {
      if (!await permission) throw new Error("Доступ к изображениям не предоставлен. Можно снять галочку и сохранить Excel со ссылками.");
      if (signal.aborted) throw new DOMException("Экспорт отменён", "AbortError");
      let thumbnails = new Map(), failed = 0;
      if (includeImages) {
        $("progress").hidden = false;
        ({ thumbnails, failed } = await SupplierImages.collect(imageUrls, progress => {
          $("progress").max = progress.total || 1; $("progress").value = progress.completed;
          $("status").textContent = `Картинки: ${progress.completed} / ${progress.total} · загружено ${progress.loaded} · недоступно ${progress.failed}`;
        }, signal));
      }
      $("status").textContent = "Формирую файл Excel…";
      // Yield once so progress and cancellation render before assembling the ZIP.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (signal.aborted) throw new DOMException("Экспорт отменён", "AbortError");
      const bytes = SupplierExcel.workbook(snapshot, { includeImages, thumbnails });
      cleanupUrl(); downloadUrl = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      await chrome.downloads.download({ url: downloadUrl, filename: `suppliers-${taskId ? "task" : "all"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`, saveAs: true });
      $("status").textContent = `Файл передан в загрузки Chrome.${includeImages ? ` Встроено разных картинок: ${thumbnails.size}. Недоступно: ${failed}. В Excel нажмите − / + над столбцом фото.` : " Сохранены ссылки на картинки."}`;
    } catch (cause) { if (cause.name === "AbortError") $("status").textContent = "Подготовка отменена. Данные в памяти сохранены."; else { $("status").textContent = ""; error(cause.message); } }
    finally { controller = null; $("download").disabled = false; $("include-images").disabled = false; $("cancel").hidden = true; $("progress").hidden = true; }
  })();
});
void initialize();
