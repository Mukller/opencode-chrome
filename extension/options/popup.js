chrome.runtime.sendMessage({ type: "get_status" }, (res) => {
  const st = (res && res.status) || "unknown";
  document.getElementById("st").textContent = st;
  const row = document.getElementById("row");
  if (st === "connected") row.className = "row on";
  else if (st === "auth_failed") row.className = "row err";
});