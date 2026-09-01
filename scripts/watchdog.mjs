#!/usr/bin/env node
// Watchdog: monitors Edge (CDP :9223) and Bridge (WS :8766), auto-restarts if dead.
// Usage: node scripts/watchdog.mjs
// Runs forever, exits if --once flag passed.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TOKEN_FILE = `${homedir()}/.opencode-chrome/token`;
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EDGE_CDP = 9223;
const BRIDGE_WS = 8766;
const PROFILE = `${ROOT}/.edge-profile`;
const EXTENSION = `${ROOT}/extension`;

const once = process.argv.includes("--once");
let bridgeProcess = null;

function log(msg) { console.log(`[watchdog ${new Date().toISOString().slice(11, 19)}] ${msg}`); }

async function isPortOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.status === 200 || res.status === 404;
  } catch { return false; }
}

async function isExtensionConnected() {
  // The extension logs connect/disconnect. We can't directly probe it,
  // but we can check if the bridge has received a hello from the extension recently.
  // Simpler: just check if bridge is up and assume extension will reconnect.
  return await isPortOpen(BRIDGE_WS);
}

async function startBridge() {
  if (bridgeProcess) { try { bridgeProcess.kill(); } catch {} }
  log("starting bridge...");
  bridgeProcess = spawn("node", [`${ROOT}/bridge/bridge.mjs`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  bridgeProcess.unref();
  bridgeProcess.on("exit", () => { bridgeProcess = null; log("bridge exited"); });
  // wait for it to come up
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortOpen(BRIDGE_WS)) { log("bridge up"); return; }
  }
  log("ERROR: bridge failed to start");
}

async function startEdge() {
  log("starting Edge...");
  const child = spawn(EDGE_PATH, [
    `--user-data-dir=${PROFILE}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${EDGE_CDP}`,
    `--load-extension=${EXTENSION}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,800",
    "about:blank",
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortOpen(EDGE_CDP)) { log("edge up"); return; }
  }
  log("ERROR: edge failed to start");
}

async function setExtensionToken() {
  if (!existsSync(TOKEN_FILE)) { log("ERROR: token file missing"); return; }
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  log("setting extension token...");

  const ver = JSON.parse(await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/version`)).text());
  const WebSocket = (await import("ws")).default;
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let sq = 0, sess = null;

  function snd(m, p = {}, timeout = 10000) {
    return new Promise((res, rej) => {
      sq++;
      const msg = { id: sq, method: m, params: p };
      if (sess) msg.sessionId = sess;
      ws.send(JSON.stringify(msg));
      const t = setTimeout(() => res({}), timeout);
      ws.on("message", function h(d) {
        const r = JSON.parse(d);
        if (r.id === sq) { clearTimeout(t); ws.off("message", h); res(r.result || {}); }
      });
    });
  }

  await new Promise(r => ws.on("open", r));
  for (let i = 0; i < 20; i++) {
    const targets = await snd("Target.getTargets");
    const sw = (targets.targetInfos || []).find(t => t.url?.includes("keinddgpmnbjaapocdmnfbjmbhldkpml"));
    if (sw) {
      const r = await snd("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
      sess = r.sessionId;
      await snd("Runtime.evaluate", {
        expression: `chrome.storage.sync.set({token: ${JSON.stringify(token)}, wsUrl: "ws://127.0.0.1:${BRIDGE_WS}"}, () => {})`,
        awaitPromise: true,
      });
      log("token set");
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  ws.close();
}

async function main() {
  log("=== watchdog started ===");
  log(`edge CDP: ${EDGE_CDP}, bridge WS: ${BRIDGE_WS}`);

  // Initial start
  if (!await isPortOpen(BRIDGE_WS)) await startBridge();
  if (!await isPortOpen(EDGE_CDP)) {
    await startEdge();
    await new Promise(r => setTimeout(r, 5000));
    await setExtensionToken();
  }
  log("initial setup complete");

  if (once) { log("--once mode, exiting"); return; }

  // Watch loop
  while (true) {
    await new Promise(r => setTimeout(r, 10000)); // check every 10s

    if (!await isPortOpen(BRIDGE_WS)) {
      log("bridge down, restarting...");
      await startBridge();
    }

    if (!await isPortOpen(EDGE_CDP)) {
      log("edge down, restarting...");
      await startEdge();
      await new Promise(r => setTimeout(r, 8000));
      await setExtensionToken();
    }
  }
}

main().catch(e => { log("FATAL: " + e.message); process.exit(1); });