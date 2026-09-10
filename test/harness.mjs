// E2E harness: simulates BOTH sides.
// 1) A fake Chrome extension connecting over WS and answering commands.
// 2) An MCP client talking JSON-RPC over the bridge's stdin/stdout.
//
// Usage: node test/harness.mjs
// Exits 0 when all checks pass.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const PORT = 8899;
process.env.OPENCODE_CHROME_PORT = String(PORT);
const TOKEN = "testtoken123";
process.env.OPENCODE_CHROME_TOKEN = TOKEN;

let passed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { console.error(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
}

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/test
const bridgeSpawn = spawn(process.execPath, [path.join(here, "..", "bridge", "bridge.mjs")], {
  env: process.env,
});
bridgeSpawn.stderr.on("data", (d) => process.stderr.write("[bridge] " + d));
const bridge = bridgeSpawn;

// wait for ws server
await new Promise((r) => setTimeout(r, 1200));

// ---- fake extension ----
const ext = new WebSocket(`ws://127.0.0.1:${PORT}`);
let helloOk = false;
ext.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "hello_ok") { helloOk = true; return; }
  if (msg.type === "hello_err") { console.error("auth failed in fake ext"); return; }
  if (msg.type === "req") {
    const reply = (ok, data) =>
      ext.send(JSON.stringify({ type: "res", id: msg.id, ok, data }));
    switch (msg.cmd) {
      case "tabs_list":
        return reply(true, [{ id: 11, title: "Example", url: "https://example.com/", active: true }]);
      case "tab_eval":
        return reply(true, { value: `eval:${msg.params.expression.length}` });
      case "tab_read":
        return reply(true, { title: "T", url: "u", text: "hello world" });
      case "tab_screenshot":
        return reply(true, { base64: Buffer.from("fakepng").toString("base64") });
      // v0.6.0 anti-bot tools
      case "click_in_shadow":
        return reply(true, { clicked: true, x: 100, y: 100, tag: "DIV", via: "shadow" });
      case "hover_and_reveal":
        return reply(true, { hovered: true, x: 100, y: 100, waitMs: 2000 });
      case "human_type":
        return reply(true, { typed: true, chars: msg.params.text?.length || 0, human: true });
      case "scroll_to_element":
        return reply(true, { x: 200, y: 200, ok: true });
      default:
        return reply(false, null);
    }
  }
});

await new Promise((r) => ext.on("open", r));
ext.send(JSON.stringify({ type: "hello", token: TOKEN }));
await new Promise((r) => setTimeout(r, 400));
ok("extension authenticated (hello_ok)", helloOk);

// bad token must be rejected
{
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}`);
  let errd = false;
  bad.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "hello_err") errd = true;
  });
  await new Promise((r) => bad.on("open", r));
  bad.send(JSON.stringify({ type: "hello", token: "WRONG" }));
  await new Promise((r) => setTimeout(r, 400));
  ok("bad token rejected", errd);
  bad.close();
}

// ---- MCP client over stdio ----
let rpcId = 0;
const waiters = new Map();
bridge.stdout.setEncoding("utf8");
let buf = "";
bridge.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    } catch {}
  }
});

function rpc(method, params) {
  return new Promise((resolve) => {
    const id = ++rpcId;
    waiters.set(id, resolve);
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

await new Promise((r) => setTimeout(r, 300));
{
  const res = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  ok("mcp initialize", res.result && res.result.serverInfo.name === "opencode-chrome-bridge");
}
{
  const res = await rpc("tools/list", {});
  ok("tools/list >= 10 tools", res.result.tools.length >= 10, `got ${res.result.tools?.length}`);
}
{
  const res = await rpc("tools/call", { name: "chrome_tabs_list", arguments: {} });
  ok("chrome_tabs_list roundtrip", res.result.content[0].text.includes("example.com"));
}
{
  const res = await rpc("tools/call", { name: "chrome_eval", arguments: { expression: "1+1" } });
  ok("chrome_eval roundtrip", res.result.content[0].text.includes("eval:3"));
}
{
  const res = await rpc("tools/call", { name: "chrome_screenshot", arguments: {} });
  const hasImg = res.result.content.some(c => c.type === "image");
  ok("screenshot returns image block", hasImg);
}
{
  // unknown tool -> clean MCP error result
  const res = await rpc("tools/call", { name: "nope", arguments: {} });
  ok("unknown tool -> isError", res.result.isError === true);
}
{
  // v0.6.0 click_in_shadow
  const res = await rpc("tools/call", { name: "chrome_click_in_shadow", arguments: { selector: ".foo" } });
  ok("click_in_shadow -> returns clicked coords", res.result.content[0].text.includes("clicked"));
}
{
  // v0.6.0 hover_and_reveal
  const res = await rpc("tools/call", { name: "chrome_hover_and_reveal", arguments: { selector: ".bar", waitMs: 1500 } });
  ok("hover_and_reveal -> returns hovered", res.result.content[0].text.includes("hovered"));
}
{
  // v0.6.0 human_type
  const res = await rpc("tools/call", { name: "chrome_human_type", arguments: { text: "hello world" } });
  ok("human_type -> returns typed", res.result.content[0].text.includes("typed"));
}
{
  // v0.6.0 scroll_to_element
  const res = await rpc("tools/call", { name: "chrome_scroll_to_element", arguments: { selector: "#target" } });
  ok("scroll_to_element -> returns coords", res.result.content[0].text.includes("200"));
}
{
  // extension offline -> friendly error
  ext.close();
  await new Promise((r) => setTimeout(r, 400));
  const res = await rpc("tools/call", { name: "chrome_tabs_list", arguments: {} });
  ok("offline -> friendly message", res.result.isError && /not connected/.test(res.result.content[0].text));
}

console.log(`\n${passed} checks passed`);
bridge.kill();
process.exit(processExit());
function processExit() { return process.exitCode || 0; }