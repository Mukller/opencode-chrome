#!/usr/bin/env node
// Direct WebSocket client speaking the extension protocol of opencode-chrome.
//   node oc.mjs <cmd> ['{"json":"params"}']
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const WebSocket = require("ws");

const CFG = path.join(os.homedir(), ".opencode-chrome", "token");
const token = process.env.OPENCODE_CHROME_TOKEN || fs.readFileSync(CFG, "utf8").trim();

const cmd = process.argv[2];
let params = {};
if (process.env.OC_ARGS) params = JSON.parse(process.env.OC_ARGS);
else if (process.argv[3] && !process.argv[3].startsWith("--")) params = JSON.parse(process.argv[3]);

const timeoutArg = process.argv.find((a) => a.startsWith("--timeout="));
const timeoutMs = Number(timeoutArg ? timeoutArg.split("=")[1] : 60000);

const ws = new WebSocket("ws://127.0.0.1:8766", { handshakeTimeout: 8000 });
let id = 0;

function send(obj) {
  ws.send(JSON.stringify(obj));
}
function req(command, p) {
  return new Promise((resolve, reject) => {
    const rid = "c" + ++id;
    const timer = setTimeout(() => reject(new Error(`timeout on ${command}`)), timeoutMs);
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "res" && m.id === rid) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        if (m.ok) resolve(m.data);
        else reject(new Error(m.error || "ext error"));
      }
    };
    ws.on("message", onMsg);
    send({ type: "req", id: rid, cmd: command, params: p });
  });
}

ws.on("open", () => send({ type: "hello", token, role: "driver" }));
ws.on("error", (e) => {
  console.error("WS ERROR:", e.message);
  process.exit(2);
});

ws.on("message", async (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "hello_err") {
    console.error("bad token");
    process.exit(2);
  }
  if (m.type === "hello_ok") {
    try {
      const data = await req(cmd, params);
      if (data && typeof data === "object" && !Array.isArray(data) && data.base64) {
        fs.writeFileSync("oc-last-screenshot.png", Buffer.from(data.base64, "base64"));
        console.log("[image saved to oc-last-screenshot.png]");
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      process.exit(0);
    } catch (e) {
      console.error("ERROR:", e.message);
      process.exit(3);
    }
  }
});
