// OpenCode in Chrome - background service worker
// WS client to the local bridge; dispatches commands from commands.js.

const DEFAULT_WS_URL = "ws://127.0.0.1:8766";

let ws = null;
let wsUrl = DEFAULT_WS_URL;
let token = "";
let reconnectDelay = 1000;
let backoffAuth = false;

importScripts("cdp.js", "commands.js");

async function loadConfig() {
  const cfg = await chrome.storage.sync.get(["wsUrl", "token"]);
  wsUrl = (cfg.wsUrl || DEFAULT_WS_URL).trim();
  token = (cfg.token || "").trim();
}

function setStatus(s) {
  const colors = { connected: "#2ea043", auth_failed: "#d29922" };
  chrome.action.setBadgeText({ text: s === "connected" ? "ON" : s === "auth_failed" ? "ERR" : "" });
  if (colors[s]) chrome.action.setBadgeBackgroundColor({ color: colors[s] });
}

function safeSend(obj) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch (e) {}
}

function scheduleReconnect() {
  const d = backoffAuth ? 15000 : reconnectDelay;
  setTimeout(connect, d);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setStatus(backoffAuth ? "auth_failed" : "connecting");
  let sock;
  try { sock = new WebSocket(wsUrl); } catch (e) { scheduleReconnect(); return; }
  ws = sock;

  sock.onopen = () => safeSend({ type: "hello", ext: "opencode-chrome/0.1.0", token });

  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "hello_ok") { reconnectDelay = 1000; backoffAuth = false; setStatus("connected"); return; }
    if (msg.type === "hello_err") { backoffAuth = true; setStatus("auth_failed"); scheduleReconnect(); return; }
    if (msg.type === "req") {
      handleCommand(msg.cmd, msg.params || {})
        .then(data => safeSend({ type: "res", id: msg.id, ok: true, data }))
        .catch(err => safeSend({ type: "res", id: msg.id, ok: false, error: String((err && err.message) || err) }));
    }
  };

  sock.onclose = () => { setStatus(backoffAuth ? "auth_failed" : "disconnected"); detachAll(); scheduleReconnect(); };
  sock.onerror = () => {};
}

chrome.storage.onChanged.addListener(() => {
  loadConfig().then(() => {
    backoffAuth = false;
    reconnectDelay = 500;
    try { if (ws) ws.close(); } catch (e) {}
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "get_status") { loadConfig().then(() => sendResponse({ status: backoffAuth ? "auth_failed" : (ws && ws.readyState === WebSocket.OPEN ? "connected" : "disconnected") })); }
  return false;
});

chrome.runtime.onInstalled.addListener(() => loadConfig().then(connect));
loadConfig().then(connect);