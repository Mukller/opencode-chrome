#!/usr/bin/env node
// OpenCode in Chrome - bridge v0.6.0
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

// v0.6.0: askExtensionWithRetry handles MV3 SW disconnect/reconnect.
// If the extension disconnects mid-request, wait for it to reconnect and retry.
async function askExtensionWithRetry(cmd, params = {}, opts = {}) {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 20000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await askExtension(cmd, params, timeoutMs);
    } catch (e) {
      const msg = e.message || "";
      const isTransient = msg.includes("timeout") || msg.includes("disconnected") || msg.includes("not connected");
      if (!isTransient || attempt === maxRetries - 1) throw e;
      // Wait for extension to reconnect (chrome.alarms wakes SW every 24s)
      const delay = baseDelayMs * Math.pow(1.5, attempt);
      console.error(`[bridge] ${cmd} failed (${msg}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
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
  // ===== NAVIGATION (9) =====
  { name: "chrome_tabs_list", description: "List all open browser tabs (id, title, url, active).", inputSchema: { type: "object", properties: {} } },
  { name: "chrome_tab_open", description: "Open a URL in a NEW tab.", inputSchema: { type: "object", properties: { url: { type: "string" }, active: { type: "boolean", "default": true } }, required: ["url"] } },
  { name: "chrome_tab_navigate", description: "Navigate a tab to a URL. Uses the active tab when tabId is omitted.", inputSchema: { type: "object", properties: { url: { type: "string" }, tabId: { type: "number" } }, required: ["url"] } },
  { name: "chrome_tab_close", description: "Close a tab by id.", inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] } },
  { name: "chrome_tab_switch", description: "Switch focus to a specific tab.", inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] } },
  { name: "chrome_tab_wait_load", description: "Wait until the tab finishes loading.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_tab_back", description: "Navigate back in browser history.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_tab_forward", description: "Navigate forward in browser history.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_tab_refresh", description: "Reload the page.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },

  // ===== MOUSE (6) - all use CDP Input = REAL events =====
  { name: "chrome_click", description: "Click element by CSS selector (CDP Input = real mouse).", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_click_coords", description: "Click at exact viewport coordinates using REAL mouse events (bypasses bot detection).", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } }, required: ["x", "y"] } },
  { name: "chrome_hover", description: "Hover over element (real mouse move). Needed for dropdowns, tooltips, edit-on-hover buttons.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_double_click", description: "Double click on element.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_right_click", description: "Right click on element (context menu).", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_scroll", description: "Scroll page using mouse wheel events.", inputSchema: { type: "object", properties: { direction: { type: "string", "enum": ["up", "down"] }, amount: { type: "number", "default": 500 }, tabId: { type: "number" } } } },
  { name: "chrome_drag_and_drop", description: "Drag element from one selector to another.", inputSchema: { type: "object", properties: { fromSelector: { type: "string" }, toSelector: { type: "string" }, tabId: { type: "number" } }, required: ["fromSelector", "toSelector"] } },

  // ===== KEYBOARD (3) =====
  { name: "chrome_fill", description: "Fill input/textarea by CSS selector with native setter + React events.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "text"] } },
  { name: "chrome_type", description: "Type text into currently focused element using REAL keyboard events (bypasses bot detection).", inputSchema: { type: "object", properties: { text: { type: "string" }, tabId: { type: "number" } }, required: ["text"] } },
  { name: "chrome_press_key", description: "Press a single key (Enter, Tab, Escape, ArrowDown, etc.).", inputSchema: { type: "object", properties: { key: { type: "string", "default": "Enter" }, tabId: { type: "number" } } } },

  // ===== SELECT =====
  { name: "chrome_select", description: "Select option from <select> by value or text.", inputSchema: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "value"] } },

  // ===== READING (6) =====
  { name: "chrome_read", description: "Read page title, url and visible text.", inputSchema: { type: "object", properties: { tabId: { type: "number" }, maxChars: { type: "number" } } } },
  { name: "chrome_get_text", description: "Get innerText of specific element by CSS selector.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_get_attribute", description: "Get attribute value (href, src, value, class etc) of element.", inputSchema: { type: "object", properties: { selector: { type: "string" }, attribute: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "attribute"] } },
  { name: "chrome_get_all_links", description: "Extract all visible links (text + href) from page.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_find_elements", description: "Find all visible elements matching CSS selector. Returns list with tag, text, id, class, href.", inputSchema: { type: "object", properties: { selector: { type: "string" }, limit: { type: "number", "default": 20 }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_eval", description: "Run JavaScript in the page and return the JSON-serialized result.", inputSchema: { type: "object", properties: { expression: { type: "string" }, tabId: { type: "number" }, awaitPromise: { type: "boolean" } }, required: ["expression"] } },

  // ===== SCREENSHOTS / PDF (4) =====
  { name: "chrome_screenshot", description: "Capture PNG screenshot of visible tab. Returns image content block.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_full_page_screenshot", description: "Capture full-page PNG (entire scrollable area).", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_element_screenshot", description: "Capture screenshot of a specific element by CSS selector.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_save_pdf", description: "Save current page as PDF.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },

  // ===== EXTRACTION (4) =====
  { name: "chrome_get_page_source", description: "Get full HTML source of the page.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_get_element_html", description: "Get inner/outer HTML of a specific element.", inputSchema: { type: "object", properties: { selector: { type: "string" }, outer: { type: "boolean", "default": true }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_extract_table", description: "Extract table data (rows + cells) from a <table> element.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_get_computed_style", description: "Get computed CSS style properties of an element.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },

  // ===== WAITING (2) =====
  { name: "chrome_wait_for_element", description: "Wait until element appears (or disappears if shouldExist=false).", inputSchema: { type: "object", properties: { selector: { type: "string" }, timeout: { type: "number", "default": 15000 }, shouldExist: { type: "boolean", "default": true }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_wait_and_retry", description: "Retry an action (click/fill/eval) up to N times with delay.", inputSchema: { type: "object", properties: { action: { type: "string", "enum": ["click", "fill", "eval"] }, selector: { type: "string" }, text: { type: "string" }, maxRetries: { type: "number", "default": 3 }, delayMs: { type: "number", "default": 2000 }, tabId: { type: "number" } }, required: ["action", "selector"] } },

  // ===== COMPOSITE (2) =====
  { name: "chrome_click_and_wait", description: "Click element and wait for page navigation.", inputSchema: { type: "object", properties: { selector: { type: "string" }, timeout: { type: "number" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_fill_and_submit", description: "Fill input and press Enter to submit form.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "text"] } },

  // ===== MONITORING =====
  { name: "chrome_console", description: "Return recent console logs / page exceptions captured while attached.", inputSchema: { type: "object", properties: { tabId: { type: "number" }, last: { type: "number", "default": 50 } } } },

  // ===== ADVANCED (5) =====
  { name: "chrome_upload_file", description: "Upload a file to a <input type=file> by selector.", inputSchema: { type: "object", properties: { selector: { type: "string" }, filePath: { type: "string" }, tabId: { type: "number" } }, required: ["selector", "filePath"] } },
  { name: "chrome_iframe_list", description: "List all iframes in the page (index, src, name).", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "chrome_iframe_eval", description: "Run JavaScript inside a specific iframe by index.", inputSchema: { type: "object", properties: { index: { type: "number", "default": 0 }, expression: { type: "string" }, tabId: { type: "number" } }, required: ["expression"] } },
  { name: "chrome_shadow_query", description: "Query element inside a shadow DOM (first match).", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },

  // ===== COOKIES / STORAGE (3) =====
  { name: "chrome_cookies_get", description: "Get cookies for a domain (or all if not specified).", inputSchema: { type: "object", properties: { domain: { type: "string" }, tabId: { type: "number" } } } },
  { name: "chrome_cookie_set", description: "Set a single cookie (name, value, domain).", inputSchema: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, domain: { type: "string" }, tabId: { type: "number" } }, required: ["name", "value"] } },
  { name: "chrome_local_storage", description: "Get/set localStorage. action=get|set|remove, key, value.", inputSchema: { type: "object", properties: { action: { type: "string", "enum": ["get", "set", "remove"] }, key: { type: "string" }, value: { type: "string" }, tabId: { type: "number" } }, required: ["action", "key"] } },
  { name: "chrome_export_session", description: "Export cookies + localStorage to JSON (for session transfer between profiles).", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },

  // ===== EMULATION (5) =====
  { name: "chrome_set_viewport", description: "Set browser viewport size (width x height).", inputSchema: { type: "object", properties: { width: { type: "number", "default": 1280 }, height: { type: "number", "default": 800 }, tabId: { type: "number" } } } },
  { name: "chrome_set_user_agent", description: "Override the user agent string for this tab.", inputSchema: { type: "object", properties: { userAgent: { type: "string" }, tabId: { type: "number" } }, required: ["userAgent"] } },
  { name: "chrome_set_geolocation", description: "Override geolocation (lat, lon) for this tab.", inputSchema: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" }, tabId: { type: "number" } } } },
  { name: "chrome_set_timezone", description: "Override timezone for this tab (e.g. Europe/Minsk).", inputSchema: { type: "object", properties: { timezone: { type: "string" }, tabId: { type: "number" } }, required: ["timezone"] } },
  { name: "chrome_emulate_network", description: "Emulate network conditions (Online, Offline, Slow3G, Fast3G).", inputSchema: { type: "object", properties: { condition: { type: "string", "enum": ["Online", "Offline", "Slow3G", "Fast3G"] }, tabId: { type: "number" } } } },

  // ===== AUTOMATION (3) =====
  { name: "chrome_batch", description: "Run multiple commands in sequence (atomic). operations: JSON array of {tool, args}.", inputSchema: { type: "object", properties: { operations: { type: "array" }, tabId: { type: "number" } }, required: ["operations"] } },
  { name: "chrome_if_exists", description: "If selector exists run thenAction, else run elseAction.", inputSchema: { type: "object", properties: { selector: { type: "string" }, thenAction: { type: "object" }, elseAction: { type: "object" }, tabId: { type: "number" } }, required: ["selector"] } },

  // ===== v0.6.0 ANTI-BOT REALISM (4) =====
  { name: "chrome_click_in_shadow", description: "Click element by CSS selector, recursing into shadow DOM (LinkedIn artdeco-* etc).", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_hover_and_reveal", description: "Hover over element and wait configurable time for hidden edit/pencil buttons to appear.", inputSchema: { type: "object", properties: { selector: { type: "string" }, waitMs: { type: "number", "default": 2000 }, tabId: { type: "number" } }, required: ["selector"] } },
  { name: "chrome_human_type", description: "Type with realistic jitter (50-150ms per char) and optional typos. Bypasses bot typing detection.", inputSchema: { type: "object", properties: { text: { type: "string" }, opts: { type: "object", properties: { minDelay: { type: "number" }, maxDelay: { type: "number" }, typoRate: { type: "number" } } }, tabId: { type: "number" } }, required: ["text"] } },
  { name: "chrome_scroll_to_element", description: "Smooth-scroll element into viewport, returns center coords.", inputSchema: { type: "object", properties: { selector: { type: "string" }, tabId: { type: "number" } }, required: ["selector"] } },
];

async function callTool(name, args) {
  switch (name) {
    // NAVIGATION
    case "chrome_tabs_list": return text(await askExtension("tabs_list"));
    case "chrome_tab_open": return text(await askExtension("tabs_new", args));
    case "chrome_tab_navigate": {
      const r = await askExtension("tab_navigate", args);
      await askExtension("tab_wait_load", { tabId: r.id }).catch(() => {});
      const tab = await askExtension("tab_navigate", { tabId: r.id });
      return text(tab);
    }
    case "chrome_tab_close": return text(await askExtension("tab_close", args));
    case "chrome_tab_switch": return text(await askExtension("tab_switch", args));
    case "chrome_tab_back": return text(await askExtension("tab_back", args));
    case "chrome_tab_forward": return text(await askExtension("tab_forward", args));
    case "chrome_tab_refresh": return text(await askExtension("tab_refresh", args));
    case "chrome_tab_wait_load": return text(await askExtension("tab_wait_load", args));

    // MOUSE
    case "chrome_click": return text(await askExtension("tab_click", args));
    case "chrome_click_coords": return text(await askExtension("tab_click_coords", args));
    case "chrome_hover": return text(await askExtension("tab_hover", args));
    case "chrome_double_click": return text(await askExtension("tab_double_click", args));
    case "chrome_right_click": return text(await askExtension("tab_right_click", args));
    case "chrome_scroll": return text(await askExtension("tab_scroll", args));
    case "chrome_drag_and_drop": return text(await askExtension("tab_drag_and_drop", args));

    // KEYBOARD
    case "chrome_fill": return text(await askExtension("tab_fill", args));
    case "chrome_type": return text(await askExtension("tab_type", args));
    case "chrome_press_key": return text(await askExtension("tab_press_key", args));

    // SELECT
    case "chrome_select": return text(await askExtension("tab_select", args));

    // READING
    case "chrome_read": return text(await askExtension("tab_read", args));
    case "chrome_get_text": return text(await askExtension("tab_get_text", args));
    case "chrome_get_attribute": return text(await askExtension("tab_get_attribute", args));
    case "chrome_get_all_links": return text(await askExtension("tab_get_all_links", args));
    case "chrome_find_elements": return text(await askExtension("tab_find_elements", args));
    case "chrome_eval": return text(await askExtension("tab_eval", args));

    // SCREENSHOTS / PDF
    case "chrome_screenshot": {
      const r = await askExtension("tab_screenshot", args);
      return { content: [
        { type: "image", data: r.base64, mimeType: "image/png" },
        { type: "text", text: `screenshot (${Math.round(r.base64.length * 3 / 4)} bytes png)` },
      ]};
    }
    case "chrome_full_page_screenshot": {
      const r = await askExtension("full_page_screenshot", args);
      return { content: [
        { type: "image", data: r.base64, mimeType: "image/png" },
        { type: "text", text: `full page screenshot (${Math.round(r.base64.length * 3 / 4)} bytes png)` },
      ]};
    }
    case "chrome_element_screenshot": {
      const r = await askExtension("element_screenshot", args);
      return { content: [
        { type: "image", data: r.base64, mimeType: "image/png" },
        { type: "text", text: `element screenshot (${Math.round(r.base64.length * 3 / 4)} bytes png)` },
      ]};
    }
    case "chrome_save_pdf": return text(await askExtension("save_pdf", args));

    // EXTRACTION
    case "chrome_get_page_source": return text(await askExtension("get_page_source", args));
    case "chrome_get_element_html": return text(await askExtension("get_element_html", args));
    case "chrome_extract_table": return text(await askExtension("extract_table", args));
    case "chrome_get_computed_style": return text(await askExtension("get_computed_style", args));

    // WAITING
    case "chrome_wait_for_element": return text(await askExtension("tab_wait_for_element", args));
    case "chrome_wait_and_retry": return text(await askExtension("wait_and_retry", args));

    // COMPOSITE
    case "chrome_click_and_wait": return text(await askExtension("tab_click_and_wait", args));
    case "chrome_fill_and_submit": return text(await askExtension("tab_fill_and_submit", args));

    // MONITORING
    case "chrome_console": return text(await askExtension("tab_console", args));

    // ADVANCED
    case "chrome_upload_file": return text(await askExtension("tab_upload_file", args));
    case "chrome_iframe_list": return text(await askExtension("iframe_list", args));
    case "chrome_iframe_eval": return text(await askExtension("iframe_eval", args));
    case "chrome_shadow_query": return text(await askExtension("shadow_query", args));

    // COOKIES / STORAGE
    case "chrome_cookies_get": return text(await askExtension("cookies_get", args));
    case "chrome_cookie_set": return text(await askExtension("cookie_set", args));
    case "chrome_local_storage": return text(await askExtension("local_storage", args));
    case "chrome_export_session": return text(await askExtension("export_session", args));

    // EMULATION
    case "chrome_set_viewport": return text(await askExtension("set_viewport", args));
    case "chrome_set_user_agent": return text(await askExtension("set_user_agent", args));
    case "chrome_set_geolocation": return text(await askExtension("set_geolocation", args));
    case "chrome_set_timezone": return text(await askExtension("set_timezone", args));
    case "chrome_emulate_network": return text(await askExtension("emulate_network", args));

    // AUTOMATION
    case "chrome_batch": return text(await askExtension("batch", args));
    case "chrome_if_exists": return text(await askExtension("if_exists", args));

    // v0.6.0 ANTI-BOT
    case "chrome_click_in_shadow": return text(await askExtension("click_in_shadow", args));
    case "chrome_hover_and_reveal": return text(await askExtension("hover_and_reveal", args));
    case "chrome_human_type": return text(await askExtension("human_type", args));
    case "chrome_scroll_to_element": return text(await askExtension("scroll_to_element", args));

    default:
      throw new Error("unknown tool: " + name);
  }
}function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
        serverInfo: { name: "opencode-chrome-bridge", version: "0.6.0" },
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