#!/usr/bin/env node
// Minimal CDP driver for the dedicated automation Edge (port 9223).
//   node cdp.mjs targets
//   node cdp.mjs open   <url>
//   node cdp.mjs nav    <url>
//   node cdp.mjs eval   '<js>'        [--raw]
//   node cdp.mjs fill   <selector> <text>
//   node cdp.mjs click  <selector>
//   node cdp.mjs read
//   node cdp.mjs waitload [timeoutMs]
//   node cdp.mjs shot   [file.png]
const PORT = process.env.CDP_PORT || 9223;
import fs from "node:fs";

async function httpJson(pathname, method = "GET") {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method });
  return r.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    let events = [];
    ws.addEventListener("open", () => {
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
          }),
        waitEvent: (method, timeoutMs = 20000) =>
          new Promise((res, rej) => {
            const idx = events.findIndex((e) => e.method === method);
            if (idx >= 0) return res(events.splice(idx, 1)[0].params);
            const timer = setTimeout(() => rej(new Error("event timeout " + method)), timeoutMs);
            const check = setInterval(() => {
              const idx2 = events.findIndex((e) => e.method === method);
              if (idx2 >= 0) {
                clearInterval(check);
                clearTimeout(timer);
                res(events.splice(idx2, 1)[0].params);
              }
            }, 50);
          }),
        drainEvents: () => {
          const out = events.splice(0, events.length);
          return out;
        },
        sessions: [],
        close: () => ws.close(),
      });
    });
    const origOn = (fn) => ws.addEventListener("message", fn);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
    ws.addEventListener("error", (e) => reject(new Error("ws error")));
  });
}

async function attachAll(c) {
  await c.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
}

async function pageWs() {
  if (process.env.CDP_WS) return { wsUrl: process.env.CDP_WS };
  const list = await httpJson("/json/list");
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return { wsUrl: page.webSocketDebuggerUrl, info: page };
}

const HELPERS = `
window.__ccg = {
  q(sel){ const el=document.querySelector(sel); return el; },
  visible(el){ const r=el.getBoundingClientRect(); return r.width>0&&r.height>0; },
  clickSel(sel){
    const els=[...document.querySelectorAll(sel)].filter(e=>this.visible(e));
    if(!els.length) throw new Error('not found: '+sel);
    els[0].click(); return true;
  },
  clickText(txt,scope='button, [role="button"], a'){
    const want=txt.toLowerCase();
    const el=[...document.querySelectorAll(scope)].filter(e=>this.visible(e)&&e.textContent.trim().toLowerCase().includes(want))[0];
    if(!el) throw new Error('no button with text '+txt);
    el.click(); return true;
  },
  fillCE(sel,text){
    const el=this.q(sel); if(!el) throw new Error('not found: '+sel);
    el.focus();
    document.execCommand('selectAll',false,null);
    document.execCommand('insertText',false,text);
    el.dispatchEvent(new InputEvent('input',{bubbles:true}));
    return true;
  },
  setInput(sel,text){
    const el=this.q(sel); if(!el) throw new Error('not found: '+sel);
    const proto = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  },
};
true;
`;

const cmd = process.argv[2];
const a = process.argv.slice(3);

async function evalIn(expr, opts = {}) {
  const { wsUrl } = await pageWs();
  const c = await connect(wsUrl);
  await c.send("Runtime.enable");
  try {
    await c.send("Runtime.evaluate", { expression: HELPERS });
  } catch {}
  const r = await c.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: !!opts.awaitPromise,
  });
  c.close();
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
}

async function main() {
  switch (cmd) {
    case "targets": {
      console.log(JSON.stringify(await httpJson("/json/list"), null, 2));
      break;
    }
    case "open": {
      const t = await httpJson("/json/new?" + encodeURIComponent(a[0]), "PUT");
      console.log(JSON.stringify({ id: t.id, url: t.url }));
      break;
    }
    case "nav": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      await c.send("Page.enable");
      const loadP = c.waitEvent("Page.loadEventFired", 30000).catch(() => null);
      await c.send("Page.navigate", { url: a[0] });
      await loadP;
      c.close();
      console.log("navigated:", a[0]);
      break;
    }
    case "waitload": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      await c.send("Page.enable");
      await c.waitEvent("Page.loadEventFired", Number(a[0]) || 30000);
      c.close();
      console.log("loaded");
      break;
    }
    case "eval": {
      let expr = a[0];
      if (expr.startsWith("@")) expr = (await import("node:fs")).readFileSync(expr.slice(1), "utf8");
      const r = await evalIn(expr, { awaitPromise: process.argv.includes("--await") });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "fill": {
      const sel = JSON.stringify(a[0]);
      const text = JSON.stringify(a[1] || "");
      console.log(JSON.stringify(await evalIn(`__ccg.setInput(${sel}, ${text})`)));
      break;
    }
    case "fillce": {
      const sel = JSON.stringify(a[0]);
      const text = JSON.stringify(a[1] || "");
      console.log(JSON.stringify(await evalIn(`__ccg.fillCE(${sel}, ${text})`)));
      break;
    }
    case "click": {
      console.log(JSON.stringify(await evalIn(`__ccg.clickSel(${JSON.stringify(a[0])})`)));
      break;
    }
    case "paste": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      const seq = [
        { type: "keyDown", modifiers: 2, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
        { type: "keyDown", modifiers: 2, key: "v", code: "KeyV", windowsVirtualKeyCode: 86 },
        { type: "keyUp", modifiers: 2, key: "v", code: "KeyV", windowsVirtualKeyCode: 86 },
        { type: "keyUp", modifiers: 0, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
      ];
      for (const ev of seq) await c.send("Input.dispatchKeyEvent", ev);
      c.close();
      console.log("paste dispatched");
      break;
    }
    case "metrics": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      const m = await c.send("Page.getLayoutMetrics");
      c.close();
      console.log(JSON.stringify(m, null, 1));
      break;
    }
    case "probe": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      const attached = [];
      c.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => {});
      const needle = process.env.NEEDLE || "What do you want to talk about";
      const probeExpr = `JSON.stringify({url:location.href.slice(0,60), has:${JSON.stringify(needle)} ? document.body.innerText.includes(${JSON.stringify(needle)}) : false, ces:[...document.querySelectorAll('[contenteditable=true],[role=textbox],.ql-editor')].length, ph:!!document.querySelector("[data-placeholder]")})`;
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const evs = c.drainEvents().filter((e) => e.method === "Target.attachedToTarget");
        for (const ev of evs) {
          const sid = ev.params.sessionId;
          if (!attached.includes(sid)) {
            attached.push(sid);
            try {
              await c.send("Runtime.enable", {}, sid);
              const r = await c.send("Runtime.evaluate", { expression: probeExpr, returnByValue: true }, sid);
              console.log("session", sid.slice(0, 8), "type", ev.params.targetInfo.type, "→", r.result.value);
            } catch (e2) {
              console.log("session", sid.slice(0, 8), "eval err", e2.message);
            }
          }
        }
      }
      const rMain = await c.send(
        "Runtime.evaluate",
        { expression: probeExpr, returnByValue: true },
      );
      console.log("MAIN →", JSON.stringify(rMain.result.value));
      c.close();
      break;
    }
    case "feval": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      const file = a[0].startsWith("@") ? a[0].slice(1) : null;
      const expr = file ? fs.readFileSync(file, "utf8") : a[0];
      const awaitP = process.argv.includes("--await");
      await c.send("Page.enable");
      await c.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      const results = [];
      const tried = new Set();
      const runIn = async (sessionId, label) => {
        try {
          const opts = sessionId ? { sessionId } : {};
          await c.send("Runtime.enable", {}, sessionId);
          const r = await c.send(
            "Runtime.evaluate",
            { expression: expr, returnByValue: true, awaitPromise: awaitP },
            sessionId,
          );
          results.push({ target: label, value: r.result.value });
        } catch (e) {
          results.push({ target: label, err: e.message.slice(0, 80) });
        }
      };
      await runIn(undefined, "main");
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        for (const ev of c.drainEvents().filter((e) => e.method === "Target.attachedToTarget")) {
          const { sessionId, targetInfo } = ev.params;
          if (tried.has(sessionId)) continue;
          tried.add(sessionId);
          await runIn(sessionId, targetInfo.type + ":" + (targetInfo.url || "").slice(0, 70));
        }
      }
      c.close();
      console.log(JSON.stringify(results, null, 1));
      break;
    }
    case "mouse": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      await c.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: Number(a[0]), y: Number(a[1]),
        button: "left", clickCount: 1,
      });
      await c.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: Number(a[0]), y: Number(a[1]),
        button: "left", clickCount: 1,
      });
      c.close();
      console.log("mouse clicked at", a[0], a[1]);
      break;
    }
    case "key": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      await c.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown" === a[0] ? "rawKeyDown" : "keyDown",
        key: a[0] === "rawKeyDown" ? "" : a[0], windowsVirtualKeyCode: a[0] === "Return" ? 13 : 0, code: a[0] === "Return" ? "Enter" : "",
      });
      await c.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: a[0] === "rawKeyDown" ? "" : a[0], windowsVirtualKeyCode: a[0] === "Return" ? 13 : 0,
      });
      c.close();
      console.log("key:", a[0]);
      break;
    }
    case "type": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      const text = fs.readFileSync(a[0].startsWith("@") ? a[0].slice(1) : "/dev/null", "utf8").replace(/\n$/, "");
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) await c.send("Input.insertText", { text: parts[i] });
        if (i < parts.length - 1) {
          await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        }
      }
      c.close();
      console.log("typed", text.length, "chars,", parts.length, "lines");
      break;
    }
    case "clicktext": {
      console.log(JSON.stringify(await evalIn(`__ccg.clickText(${JSON.stringify(a[0])})`)));
      break;
    }
    case "read": {
      const limit = Number(a[0]) || 3000;
      const v = await evalIn(
        `(()=>{return {title:document.title,url:location.href,text:document.body.innerText.slice(0,${limit})}})()`,
      );
      console.log(JSON.stringify(v, null, 2));
      break;
    }
    case "shot": {
      const { wsUrl } = await pageWs();
      const c = await connect(wsUrl);
      const r = await c.send("Page.captureScreenshot", { format: "png" });
      c.close();
      const file = a[0] || "oc-shot.png";
      (await import("node:fs")).writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log("saved", file);
      break;
    }
    default:
      console.error("unknown command:", cmd || "(none)");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
