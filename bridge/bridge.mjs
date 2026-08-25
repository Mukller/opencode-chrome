#!/usr/bin/env node
// OpenCode in Chrome - bridge
// WebSocket server (for the Chrome extension) + MCP stdio server (for opencode).
//
//   node bridge.mjs                 # token in ~/.opencode-chrome/token
//   PORT=8766 node bridge.mjs       # custom port
//   OPENCODE_CHROME_TOKEN=xyz ...   # fixed token instead of generated
//
// The extension connects to ws://127.0.0.1:<PORT> and authenticates with the
// token. MCP clients (opencode) talk to this process over stdio.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.OPENCODE_CHROME_PORT || 8766);
const CFG_DIR = path.join(os.homedir(), ".opencode-chrome");
const TOKEN_FILE = path.join(CFG_DIR, "token");

function loadToken() {
  if (process.env.OPENCODE_CHROME_TOKEN) return process.env.OPENCODE_CHROME_TOKEN;
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

const TOKEN = loadToken();

// ---------- extension connection state ----------
let extSock = null; // currently connected, authenticated extension socket
const driverSocks = new Set();
let reqSeq = 0;
const pending = new Map(); // id -> {resolve, reject, timer}

function askExtension(cmd, params = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (!extSock || extSock.readyState !== 1) {
      return reject(new Error("Chrome extension is not connected. Open Chrome and make sure the OpenCode in Chrome extension is enabled and configured."));
    }
    const id = "b" + (++reqSeq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`extension timeout after ${timeoutMs}ms on ${cmd}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extSock.send(JSON.stringify({ type: "req", id, cmd, params }));
  });
}

function driverSend(sock, obj) {
  if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj));
}

function wsSend(sock, obj) {
  if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj));
}

// ---------- WebSocket server for the extension ----------
const server = http.createServer((req, res) => {
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server });

wss.on("connection", (sock, req) => {
  // only localhost
  const addr = req.socket.remoteAddress || "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) {
    sock.close();
    return;
  }
  sock.isExt = false;
  sock.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "hello") {
      if ((msg.token || "") !== TOKEN) {
        wsSend(sock, { type: "hello_err", error: "bad token" });
        sock.close();
        return;
      }
      if (msg.role === "driver") {
        sock.isDriver = true;
        driverSocks.add(sock);
        console.error(`[bridge] driver connected`);
        wsSend(sock, { type: "hello_ok" });
        return;
      }
      sock.isExt = true;
      extSock = sock;
      console.error(`[bridge] chrome extension connected`);
      wsSend(sock, { type: "hello_ok" });
      return;
    }

    if (sock.isDriver) {
      if (msg.type === "req") {
        askExtension(msg.cmd, msg.params || {})
          .then((data) => driverSend(sock, { type: "res", id: msg.id, ok: true, data }))
          .catch((e) => driverSend(sock, { type: "res", id: msg.id, ok: false, error: e.message }));
      }
      return;
    }

    if (!sock.isExt) return;

    if (msg.type === "res") {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || "extension error"));
    }
  });

  sock.on("close", () => {
    if (sock.isDriver) {
      driverSocks.delete(sock);
      return;
    }
    if (sock === extSock) {
      console.error("[bridge] chrome extension disconnected");
      extSock = null;
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("extension disconnected"));
      }
      pending.clear();
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[bridge] listening on ws://127.0.0.1:${PORT}`);
  console.error(`[bridge] token: ${TOKEN}   (also saved to ${TOKEN_FILE})`);
  console.error(`[bridge] waiting for the Chrome extension to connect...`);
});

// ---------- MCP server over stdio ----------
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handleMcpLine(line);
  }
});

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const TOOLS = [
  { name: "chrome_tabs_list", description: "List all open browser tabs (id, title, url, active).", inputSchema: { type: "object", properties: {} } },
  { name: "chrome_tab_open", description: "Open a URL in a NEW tab.", inputSchema: { type: "object", properties: { url: { type: "string" }, active: { type: "boolean", default: true } }, required: ["url"] } },
  { name: "chrome_tab_navigate", description: "Navigate a tab to a URL. Uses the active tab when tabId is omitted.", inputSchema: { type: "object", properties: { url: { type: "string" }, tabId: { type: "number" } }, required: ["url"] } },
  { name: "chrome_tab_close", description: "Close a tab by id.", inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] } },
  { name: "chrome_tab_wait_load", description: "Wait until the tab finishes loading.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_eval", description: "Run JavaScript in the page and return the JSON result.", inputSchema: { type: "object", properties: { expression: { type: "string" }, tabId: { type: "number" }, awaitPromise: { type: "boolean" } }, required: ["expression"] } },
  { name: "chrome_click", description: "Click an element by CSS selector (first visible match).", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_fill", description: "Fill an input/textarea by CSS selector using native setter + React-friendly events.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "text"] } },
  { name: "chrome_press_key", description: "Dispatch a KeyboardEvent (keydown+keyup) on the focused element.", inputSchema: { type: "object", properties: { key: { type: "string", default: "Enter" }, tabId: { type: "number" } } } },
  { name: "chrome_read", description: "Read page title, url and visible text.", inputSchema: { type: "object", properties: { tabId: { type: "number" }, maxChars: { type: "number" } } } },
  { name: "chrome_screenshot", description: "Capture a PNG screenshot of the tab; returns an image content block.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_console", description: "Return recent console logs / page exceptions captured while attached.", inputSchema: { type: "object", properties: { tabId: { type: "number" }, last: { type: "number", default: 50 } } } },
  { name: "chrome_click_coords", description: "Click at exact viewport coordinates using REAL mouse events (bypasses bot detection).", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } }, required: ["x", "y"] } },
  { name: "chrome_type", description: "Type text into currently focused element using REAL keyboard events (bypasses bot detection).", inputSchema: { type: "object", properties: { text: { type: "string" }, tabId: { type: "number" } }, required: ["text"] } },
  { name: "chrome_scroll", description: "Scroll page using mouse wheel events.", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] }, amount: { type: "number", default: 500 }, tabId: { type: "number" } } } },
  { name: "chrome_click_and_wait", description: "Click element and wait for page navigation.", inputSchema: { type: "object", properties: { selector: { type: "string" }, timeout: { type: "number" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_fill_and_submit", description: "Fill input and press Enter to submit form.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "text"] } },
  { name: "chrome_tab_switch", description: "Switch focus to a specific tab.", inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] } },
  { name: "chrome_tab_back", description: "Navigate back in browser history.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_tab_forward", description: "Navigate forward in browser history.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_tab_refresh", description: "Reload the page.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_hover", description: "Hover over an element (real mouse move). Needed for dropdowns, tooltips.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_double_click", description: "Double click on element.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_right_click", description: "Right click on element (context menu).", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_select", description: "Select option from a <select> dropdown by value or text.", inputSchema: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "value"] } },
  { name: "chrome_wait_for_element", description: "Wait until element appears (or disappears if shouldExist=false).", inputSchema: { type: "object", properties: { selector: { type: "string" }, timeout: { type: "number", default: 15000 }, shouldExist: { type: "boolean", default: true }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_get_text", description: "Get innerText of a specific element by CSS selector.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_get_attribute", description: "Get attribute value (href, src, value, class etc) of element.", inputSchema: { type: "object", properties: { selector: { type: "string" }, attribute: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "attribute"] } },
  { name: "chrome_get_all_links", description: "Extract all visible links (text + href) from page.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_find_elements", description: "Find all visible elements matching CSS selector. Returns list with tag, text, id, class, href.", inputSchema: { type: "object", properties: { selector: { type: "string" }, limit: { type: "number", default: 20 }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_cookies_get", description: "Get cookies for a domain (or all domains if not specified). Requires debugger attach.", inputSchema: { type: "object", properties: { domain: { type: "string" }, tabId: { type: "number" } } } },
];

async function callTool(name, args) {
  switch (name) {
    case "chrome_tabs_list":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tabs_list"), null, 2) }] };
    case "chrome_tab_open":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tabs_new", args)) }] };
    case "chrome_tab_navigate": {
      const r = await askExtension("tab_navigate", args);
      await askExtension("tab_wait_load", { tabId: r.id }).catch(() => {});
      const tab = await askExtension("tab_navigate", { tabId: r.id });
      return { content: [{ type: "text", text: JSON.stringify(tab) }] };
    }
    case "chrome_tab_close":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_close", args)) }] };
    case "chrome_tab_wait_load":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_wait_load", args)) }] };
    case "chrome_eval":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_eval", args)) }] };
    case "chrome_click":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_click", args)) }] };
    case "chrome_fill":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_fill", args)) }] };
    case "chrome_press_key":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_press_key", args)) }] };
    case "chrome_read":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_read", args)) }] };
    case "chrome_screenshot": {
      const r = await askExtension("tab_screenshot", args);
      return {
        content: [
          { type: "image", data: r.base64, mimeType: "image/png" },
          { type: "text", text: `screenshot taken (${Math.round(r.base64.length * 3 / 4)} bytes png)` },
        ],
      };
    }
    case "chrome_console":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_console", args), null, 2) }] };
    case "chrome_click_coords":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_click_coords", args)) }] };
    case "chrome_type":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_type", args)) }] };
    case "chrome_scroll":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_scroll", args)) }] };
    case "chrome_click_and_wait":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_click_and_wait", args)) }] };
    case "chrome_fill_and_submit":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_fill_and_submit", args)) }] };
    case "chrome_tab_switch":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_switch", args)) }] };
    case "chrome_tab_back":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_back", args)) }] };
    case "chrome_tab_forward":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_forward", args)) }] };
    case "chrome_tab_refresh":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_refresh", args)) }] };
    case "chrome_hover":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_hover", args)) }] };
    case "chrome_double_click":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_double_click", args)) }] };
    case "chrome_right_click":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_right_click", args)) }] };
    case "chrome_select":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_select", args)) }] };
    case "chrome_wait_for_element":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_wait_for_element", args)) }] };
    case "chrome_get_text":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_get_text", args)) }] };
    case "chrome_get_attribute":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_get_attribute", args)) }] };
    case "chrome_get_all_links":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_get_all_links", args)) }] };
    case "chrome_find_elements":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("tab_find_elements", args)) }] };
    case "chrome_cookies_get":
      return { content: [{ type: "text", text: JSON.stringify(await askExtension("cookies_get", args)) }] };
    default:
      throw new Error("unknown tool: " + name);
  }
}

async function handleMcpLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === "initialize") {
    write({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-chrome-bridge", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || String(method).startsWith("notifications/")) return;
  if (method === "ping") { write({ jsonrpc: "2.0", id, result: {} }); return; }

  if (method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params.name, params.arguments || {});
      write({ jsonrpc: "2.0", id, result });
    } catch (e) {
      write({
        jsonrpc: "2.0", id,
        result: { isError: true, content: [{ type: "text", text: e.message }] },
      });
    }
    return;
  }
  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  }
}