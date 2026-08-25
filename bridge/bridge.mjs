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
<<<<<<< HEAD
  // Navigation & Tabs (7)
  {name:"chrome_tabs_list",description:"List all open browser tabs",inputSchema:{type:"object",properties:{}}},
  {name:"chrome_tab_open",description:"Open URL in new tab",inputSchema:{type:"object",properties:{url:{type:"string"},active:{type:"boolean"}},required:["url"]}},
  {name:"chrome_tab_navigate",description:"Navigate tab to URL",inputSchema:{type:"object",properties:{url:{type:"string"},tabId:{type:"number"}},required:["url"]}},
  {name:"chrome_tab_close",description:"Close tab",inputSchema:{type:"object",properties:{tabId:{type:"number"}},required:["tabId"]}},
  {name:"chrome_tab_switch",description:"Switch focus to tab",inputSchema:{type:"object",properties:{tabId:{type:"number"}},required:["tabId"]}},
  {name:"chrome_tab_wait_load",description:"Wait for tab to load",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  {name:"chrome_tab_refresh",description:"Reload page",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  // History (2)
  {name:"chrome_tab_back",description:"Go back",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  {name:"chrome_tab_forward",description:"Go forward",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  // Mouse (6)
  {name:"chrome_click",description:"Click element by CSS selector (REAL mouse)",inputSchema:{type:"object",properties:{selector:{type:"string"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_click_coords",description:"Click at viewport coordinates (REAL mouse)",inputSchema:{type:"object",properties:{x:{type:"number"},y:{type:"number"},tabId:{type:"number"}},required:["x","y"]}},
  {name:"chrome_hover",description:"Hover over element (REAL mouse move)",inputSchema:{type:"object",properties:{selector:{type:"string"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_double_click",description:"Double click element",inputSchema:{type:"object",properties:{selector:{type:"string"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_right_click",description:"Right click element",inputSchema:{type:"object",properties:{selector:{type:"string"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_scroll",description:"Scroll page (mouse wheel)",inputSchema:{type:"object",properties:{direction:{type:"string",enum:["up","down"]},amount:{type:"number",default:500},tabId:{type:"number"}}}},
  // Keyboard (3)
  {name:"chrome_fill",description:"Fill input by CSS selector (REAL click + type)",inputSchema:{type:"object",properties:{selector:{type:"string"},text:{type:"string"},tabId:{type:"number"}},required:["selector","text"]}},
  {name:"chrome_type",description:"Type text into focused element (REAL keyboard)",inputSchema:{type:"object",properties:{text:{type:"string"},tabId:{type:"number"}},required:["text"]}},
  {name:"chrome_press_key",description:"Press key (Enter, Tab, Escape, etc)",inputSchema:{type:"object",properties:{key:{type:"string",default:"Enter"},tabId:{type:"number"}}}},
  // Select (1)
  {name:"chrome_select",description:"Select option from <select> dropdown",inputSchema:{type:"object",properties:{selector:{type:"string"},value:{type:"string"},tabId:{type:"number"}},required:["selector","value"]}},
  // Reading (6)
  {name:"chrome_read",description:"Read page title, URL, visible text",inputSchema:{type:"object",properties:{tabId:{type:"number"},maxChars:{type:"number"}}}},
  {name:"chrome_get_text",description:"Get innerText of specific element",inputSchema:{type:"object",properties:{selector:{type:"string"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_get_attribute",description:"Get attribute value of element (href, src, value)",inputSchema:{type:"object",properties:{selector:{type:"string"},attribute:{type:"string"},tabId:{type:"number"}},required:["selector","attribute"]}},
  {name:"chrome_get_all_links",description:"Extract all visible links",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  {name:"chrome_find_elements",description:"Find all visible elements by CSS selector",inputSchema:{type:"object",properties:{selector:{type:"string"},limit:{type:"number"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_eval",description:"Run JavaScript in page",inputSchema:{type:"object",properties:{expression:{type:"string"},tabId:{type:"number"},awaitPromise:{type:"boolean"}},required:["expression"]}},
  // Screenshots & PDF (4)
  {name:"chrome_screenshot",description:"Viewport screenshot (PNG)",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  {name:"chrome_full_page_screenshot",description:"Full page screenshot (entire scrollable area)",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  {name:"chrome_element_screenshot",description:"Screenshot specific element",inputSchema:{type:"object",properties:{selector:{type:"string"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_save_pdf",description:"Save page as PDF",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  // Page source & extraction (4)
  {name:"chrome_get_page_source",description:"Get full HTML source of page",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  {name:"chrome_get_element_html",description:"Get innerHTML/outerHTML of element",inputSchema:{type:"object",properties:{selector:{type:"string"},outer:{type:"boolean"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_extract_table",description:"Parse HTML table to JSON",inputSchema:{type:"object",properties:{selector:{type:"string"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_get_computed_style",description:"Get computed CSS properties of element",inputSchema:{type:"object",properties:{selector:{type:"string"},properties:{type:"array"},tabId:{type:"number"}},required:["selector"]}},
  // Waiting (2)
  {name:"chrome_wait_for_element",description:"Wait for element to appear/disappear",inputSchema:{type:"object",properties:{selector:{type:"string"},timeout:{type:"number"},shouldExist:{type:"boolean"},tabId:{type:"number"}},required:["selector"]}},
  {name:"chrome_click_and_wait",description:"Click element and wait for navigation",inputSchema:{type:"object",properties:{selector:{type:"string"},timeout:{type:"number"},tabId:{type:"number"}},required:["selector"]}},
  // Composite (1)
  {name:"chrome_fill_and_submit",description:"Fill input and press Enter",inputSchema:{type:"object",properties:{selector:{type:"string"},text:{type:"string"},tabId:{type:"number"}},required:["selector","text"]}},
  // Console (1)
  {name:"chrome_console",description:"Get console logs and exceptions",inputSchema:{type:"object",properties:{tabId:{type:"number"},last:{type:"number",default:50}}}},
  // v0.4 Drag & Drop, Upload, Iframe, Shadow DOM (5)
  {name:"chrome_drag_and_drop",description:"Drag element A to element B",inputSchema:{type:"object",properties:{fromSelector:{type:"string"},toSelector:{type:"string"},tabId:{type:"number"}},required:["fromSelector","toSelector"]}},
  {name:"chrome_upload_file",description:"Upload file via input[type=file]",inputSchema:{type:"object",properties:{selector:{type:"string"},filePath:{type:"string"},tabId:{type:"number"}},required:["selector","filePath"]}},
  {name:"chrome_iframe_list",description:"List iframes on page",inputSchema:{type:"object",properties:{tabId:{type:"number"}}}},
  {name:"chrome_iframe_eval",description:"Run JS inside iframe by index",inputSchema:{type:"object",properties:{index:{type:"number"},expression:{type:"string"},tabId:{type:"number"}},required:["expression"]}},
  {name:"chrome_shadow_query",description:"Query element inside Shadow DOM",inputSchema:{type:"object",properties:{selector:{type:"string"},tabId:{type:"number"}},required:["selector"]}},
  // v0.6 Cookies & Storage (2)
  {name:"chrome_cookies_get",description:"Get cookies for domain",inputSchema:{type:"object",properties:{domain:{type:"string"},tabId:{type:"number"}}}},
  {name:"chrome_local_storage",description:"localStorage get/set/remove/all",inputSchema:{type:"object",properties:{action:{type:"string",enum:["get","set","remove","all"]},key:{type:"string"},value:{type:"string"},tabId:{type:"number"}}}},
  // v0.7 Emulation (5)
  {name:"chrome_set_viewport",description:"Set viewport size (mobile/tablet/desktop)",inputSchema:{type:"object",properties:{width:{type:"number"},height:{type:"number"},tabId:{type:"number"}},required:["width","height"]}},
  {name:"chrome_set_user_agent",description:"Change User-Agent",inputSchema:{type:"object",properties:{userAgent:{type:"string"},tabId:{type:"number"}},required:["userAgent"]}},
  {name:"chrome_set_geolocation",description:"Set GPS location",inputSchema:{type:"object",properties:{latitude:{type:"number"},longitude:{type:"number"},tabId:{type:"number"}}}},
  {name:"chrome_set_timezone",description:"Set timezone",inputSchema:{type:"object",properties:{timezone:{type:"string"},tabId:{type:"number"}},required:["timezone"]}},
  {name:"chrome_emulate_network",description:"Throttle network (3G, slow3G, offline)",inputSchema:{type:"object",properties:{condition:{type:"string"},tabId:{type:"number"}},required:["condition"]}},
];

async function callTool(name, args) {
  const cmdMap = {
    "chrome_tabs_list": "tabs_list", "chrome_tab_open": "tabs_new",
    "chrome_tab_navigate": "tab_navigate", "chrome_tab_close": "tab_close",
    "chrome_tab_switch": "tab_switch", "chrome_tab_wait_load": "tab_wait_load",
    "chrome_tab_back": "tab_back", "chrome_tab_forward": "tab_forward",
    "chrome_tab_refresh": "tab_refresh",
    "chrome_click": "tab_click", "chrome_click_coords": "tab_click_coords",
    "chrome_hover": "tab_hover", "chrome_double_click": "tab_double_click",
    "chrome_right_click": "tab_right_click", "chrome_scroll": "tab_scroll",
    "chrome_fill": "tab_fill", "chrome_type": "tab_type",
    "chrome_press_key": "tab_press_key", "chrome_select": "tab_select",
    "chrome_read": "tab_read", "chrome_get_text": "tab_get_text",
    "chrome_get_attribute": "tab_get_attribute",
    "chrome_get_all_links": "tab_get_all_links",
    "chrome_find_elements": "tab_find_elements",
    "chrome_eval": "tab_eval",
    "chrome_screenshot": "tab_screenshot",
    "chrome_full_page_screenshot": "full_page_screenshot",
    "chrome_element_screenshot": "element_screenshot",
    "chrome_save_pdf": "save_pdf",
    "chrome_get_page_source": "get_page_source",
    "chrome_get_element_html": "get_element_html",
    "chrome_extract_table": "extract_table",
    "chrome_get_computed_style": "get_computed_style",
    "chrome_wait_for_element": "tab_wait_for_element",
    "chrome_click_and_wait": "tab_click_and_wait",
    "chrome_fill_and_submit": "tab_fill_and_submit",
    "chrome_console": "tab_console",
    "chrome_drag_and_drop": "tab_drag_and_drop",
    "chrome_upload_file": "tab_upload_file",
    "chrome_iframe_list": "iframe_list",
    "chrome_iframe_eval": "iframe_eval",
    "chrome_shadow_query": "shadow_query",
    "chrome_cookies_get": "cookies_get",
    "chrome_local_storage": "local_storage",
    "chrome_set_viewport": "set_viewport",
    "chrome_set_user_agent": "set_user_agent",
    "chrome_set_geolocation": "set_geolocation",
    "chrome_set_timezone": "set_timezone",
    "chrome_emulate_network": "emulate_network",
  };
  
  const cmd = cmdMap[name];
  if (!cmd) throw new Error("unknown tool: " + name);
  
  const result = await askExtension(cmd, args);
  
  // Screenshot returns image content
  if (result.base64) {
    return {content: [{type: "image", data: result.base64, mimeType: "image/png"}]};
=======
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
>>>>>>> ca63c4f27e5a83dfe79495756900ac4b52e14521
  }
  // PDF returns base64 too
  if (result.mhtml) {
    return {content: [{type: "text", text: JSON.stringify(result).slice(0, 5000)}]};
  }
  // Page source returns large HTML
  if (result.html) {
    return {content: [{type: "text", text: JSON.stringify({html: result.html.slice(0, 50000)}).slice(0, 50000)}]};
  }
  
  return {content: [{type: "text", text: JSON.stringify(result, null, 2)}]};
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