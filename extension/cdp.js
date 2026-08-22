// OpenCode in Chrome - CDP helpers over chrome.debugger
// No --remote-debugging-port needed: the extension itself speaks CDP.

const consoleBuffers = new Map(); // tabId -> [{ts,type,text}] ring buffer
const attached = new Set();

function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    if (attached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err && !/Another debugger|Already attached|already attached/i.test(err.message)) {
        return reject(new Error(err.message));
      }
      attached.add(tabId);
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable", () => void chrome.runtime.lastError);
      resolve();
    });
  });
}

function dbgCmd(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(res);
    });
  });
}

function detachAll() {
  for (const tabId of Array.from(attached)) {
    try { chrome.debugger.detach({ tabId }); } catch (e) {}
    attached.delete(tabId);
  }
}

chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId != null) attached.delete(String(src.tabId));
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (!tabId) return;
  const key = String(tabId);
  let buf = consoleBuffers.get(key);
  if (!buf) { buf = []; consoleBuffers.set(key, buf); }
  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || []).map(a => {
      if (a.value !== undefined) return String(a.value);
      return a.description || a.type || "";
    }).join(" ");
    buf.push({ ts: Date.now(), type: params.type, text: String(text).slice(0, 2000) });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    const t = (d.text || "") + " " + ((d.exception && d.exception.description) || "");
    buf.push({ ts: Date.now(), type: "exception", text: String(t).slice(0, 2000) });
  }
  while (buf.length > 200) buf.shift();
});

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("no active tab");
  return tabs[0].id;
}

async function requireTab(p) {
  const id = p && p.tabId != null ? Number(p.tabId) : await activeTabId();
  await dbgAttach(id);
  return id;
}

async function evalInTab(tabId, expression, awaitPromise) {
  const res = await dbgCmd(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: !!awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error("JS error: " + (d.text || "") + " " + ((d.exception && (d.exception.value || d.exception.description)) || ""));
  }
  return res.result && res.result.value;
}

const CLICK_HELPER = `
(sel) => {
  const els = [...document.querySelectorAll(sel)];
  const el = els.find(e => e.offsetParent !== null) || els[0];
  if (!el) return { ok: false, error: "not found: " + sel };
  el.scrollIntoView({ block: "center" });
  el.click();
  return { ok: true, tag: el.tagName, text: (el.innerText || "").slice(0, 120) };
}
`;

const FILL_HELPER = `
(sel, text) => {
  const els = [...document.querySelectorAll(sel)];
  const el = els.find(e => e.offsetParent !== null) || els[0];
  if (!el) return { ok: false, error: "not found: " + sel };
  el.focus();
  const proto = el.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value").set;
  set.call(el, "");
  document.execCommand("insertText", false, String(text));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}
`;