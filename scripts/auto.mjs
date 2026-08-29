#!/usr/bin/env node
// opencode-chrome auto-setup & launch script v0.6.0
// One command to rule them all:
// 1. Start bridge if not running
// 2. Start Edge with extension if not running
// 3. Auto-set extension token via CDP
// 4. Wait for extension to connect
// 5. Print ready status
//
// Usage: node scripts/auto.mjs
// Exits 0 when ready, non-zero on error.

import WebSocket from "ws";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const EDGE_PORT = 9223;
const BRIDGE_PORT = 8766;
const ROOT = resolve(import.meta.dirname, "..");
const PROFILE = `${ROOT}/.edge-profile`;
const TOKEN_FILE = `${homedir()}/.opencode-chrome/token`;
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function log(msg) { console.log(`[auto] ${msg}`); }

async function isPortOpen(port) {
  try {
    // The bridge is a WS server, returns 404 for HTTP - that's still "up"
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.status === 200 || res.status === 404;
  } catch { return false; }
}

async function startBridge() {
  if (await isPortOpen(BRIDGE_PORT)) {
    log("bridge already running");
    return;
  }
  log("starting bridge...");
  // On Windows, use detached: true to fully detach the process
  const child = spawn("node", [`${ROOT}/bridge/bridge.mjs`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  // wait for it to come up
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortOpen(BRIDGE_PORT)) { log("bridge up"); return; }
  }
  // If still not up, the user needs to start it manually
  log("WARNING: bridge did not come up automatically. Start it with:");
  log("  node " + `${ROOT}/bridge/bridge.mjs`);
  log("Then re-run this script.");
  process.exit(1);
}

async function startEdge() {
  if (await isPortOpen(EDGE_PORT)) {
    log("edge CDP already running");
    return;
  }
  log("starting edge with extension...");
  const args = [
    `--user-data-dir=${PROFILE}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${EDGE_PORT}`,
    `--load-extension=${ROOT}/extension`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,800",
    "https://www.linkedin.com/in/anton-petnitsky/",
  ];
  const child = spawn(EDGE_PATH, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortOpen(EDGE_PORT)) { log("edge up"); return; }
  }
  throw new Error("edge failed to start");
}

async function setExtensionToken(token) {
  log("setting extension token...");
  const ver = JSON.parse(await (await fetch(`http://127.0.0.1:${EDGE_PORT}/json/version`)).text());
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let sq = 0, sess = null;

  function snd(m, p = {}, timeout = 30000) {
    return new Promise((res, rej) => {
      sq++;
      const msg = { id: sq, method: m, params: p };
      if (sess) msg.sessionId = sess;
      ws.send(JSON.stringify(msg));
      const t = setTimeout(() => res({}), timeout);
      ws.on("message", function h(d) {
        const r = JSON.parse(d);
        if (r.id === sq) { clearTimeout(t); ws.off("message", h); if (r.error) rej(new Error(JSON.stringify(r.error))); else res(r.result || {}); }
      });
    });
  }

  await new Promise(r => ws.on("open", r));
  // Find extension service worker (might need multiple attempts as it starts)
  for (let i = 0; i < 20; i++) {
    const targets = await snd("Target.getTargets");
    const sw = (targets.targetInfos || []).find(t => t.url?.includes("keinddgpmnbjaapocdmnfbjmbhldkpml"));
    if (sw) {
      const r = await snd("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
      sess = r.sessionId;
      await snd("Runtime.evaluate", {
        expression: `chrome.storage.sync.set({token: ${JSON.stringify(token)}, wsUrl: "ws://127.0.0.1:${BRIDGE_PORT}"}, () => {})`,
        awaitPromise: true,
      });
      log("token set in extension storage");
      ws.close();
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  ws.close();
  throw new Error("extension service worker not found");
}

async function waitForExtension() {
  log("waiting for extension to connect to bridge...");
  // We tail the bridge log file
  // Simpler: just wait 5s and try a command
  await new Promise(r => setTimeout(r, 5000));
}

async function callExtension(cmd, params = {}, timeout = 10000) {
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const ws = new WebSocket("ws://127.0.0.1:" + BRIDGE_PORT);
  let id = 0;
  const pending = new Map();
  await new Promise(r => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", token }));
  await new Promise(r => ws.on("message", function h(raw) {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "hello_ok") { ws.off("message", h); r(); }
  }));
  return new Promise((res, rej) => {
    id++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ type: "cmd", id, cmd, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout")); ws.close(); } }, timeout);
    ws.on("message", function h(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "res" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        ws.off("message", h);
        ws.close();
        msg.ok ? p.res(msg.data) : p.rej(new Error(msg.data?.error || "fail"));
      }
    });
  });
}

async function main() {
  if (!existsSync(TOKEN_FILE)) {
    log("ERROR: token file not found at " + TOKEN_FILE);
    log("Run: node bridge/bridge.mjs first to generate the token");
    process.exit(1);
  }
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  log("token: " + token.slice(0, 10) + "...");

  await startBridge();
  await startEdge();
  await new Promise(r => setTimeout(r, 3000)); // let extension load
  await setExtensionToken(token);
  await waitForExtension();

  log("testing connection...");
  for (let i = 0; i < 10; i++) {
    try {
      const tabs = await callExtension("tabs_list");
      log(`READY: ${tabs.length} tabs visible`);
      for (const t of tabs) {
        if (t.url) log(`  tab ${t.id}: ${t.url.slice(0, 70)}`);
      }
      log("\nReady for automation. Use the MCP tools or the bridge protocol.");
      log("62 tools available. See bridge/bridge.mjs TOOLS array.");
      process.exit(0);
    } catch (e) {
      if (i === 9) { log("FAILED after 10 attempts: " + e.message); process.exit(1); }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

main().catch(e => { log("ERROR: " + e.message); process.exit(1); });