(function () {
  "use strict";
  void chrome.runtime.sendMessage({ target: "1688-background", type: "RESPONSE_ALLOWED" }).then(response => {
    if (!response?.ok || response.result?.allowed !== true) return;
    const enable = () => document.dispatchEvent(new CustomEvent("supplier-response-control", { detail: { enabled: true, taskId: response.result.taskId } }));
    enable(); setTimeout(enable, 0);
    document.addEventListener("DOMContentLoaded", enable, { once: true });
  }).catch(() => {});
})();
