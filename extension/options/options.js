const $ = id => document.getElementById(id);

chrome.storage.sync.get(["wsUrl", "token"]).then(cfg => {
  $("wsUrl").value = cfg.wsUrl || "ws://127.0.0.1:8766";
  $("token").value = cfg.token || "";
});

$("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    wsUrl: $("wsUrl").value.trim() || "ws://127.0.0.1:8766",
    token: $("token").value.trim(),
  });
  $("msg").textContent = "Saved. Reconnecting...";
  setTimeout(() => ($("msg").textContent = ""), 2500);
});