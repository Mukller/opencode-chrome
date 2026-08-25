// OpenCode in Chrome - CDP helpers v0.3.0
// ALL form interactions use CDP Input domain (real mouse/keyboard)
// NEW: hover, select, wait_for_element, get_text, get_attribute, navigation, cookies

const consoleBuffers = new Map();
const attached = new Map();

function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    const key = Number(tabId);
    if (attached.has(key)) return resolve();
    chrome.debugger.attach({ tabId: key }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err && !/Another debugger|Already attached|already attached/i.test(err.message)) {
        return reject(new Error(err.message));
      }
      attached.set(key, true);
      chrome.debugger.sendCommand({ tabId: key }, "Runtime.enable", () => void chrome.runtime.lastError);
      chrome.debugger.sendCommand({ tabId: key }, "Page.enable", () => void chrome.runtime.lastError);
      resolve();
    });
  });
}

function dbgCmd(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(res);
    });
  });
}

function detachAll() {
  for (const [tabId] of attached) {
    try { chrome.debugger.detach({ tabId }); } catch (e) {}
    attached.delete(tabId);
  }
}

chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId != null) attached.delete(Number(src.tabId));
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (!tabId) return;
  const key = String(tabId);
  let buf = consoleBuffers.get(key);
  if (!buf) { buf = []; consoleBuffers.set(key, buf); }
  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type || "")).join(" ");
    buf.push({ ts: Date.now(), type: params.type, text: String(text).slice(0, 2000) });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    buf.push({ ts: Date.now(), type: "exception", text: String((d.text || "") + " " + ((d.exception && d.exception.description) || "")).slice(0, 2000) });
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
    expression, awaitPromise: !!awaitPromise, returnByValue: true, userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error("JS: " + (d.text || "") + " " + ((d.exception && (d.exception.value || d.exception.description)) || ""));
  }
  return res.result && res.result.value;
}

async function getElementRect(tabId, selector) {
  return await evalInTab(tabId, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({ x: rect.x, y: rect.y, w: rect.width, h: rect.height });
    })()
  `).then(r => r ? JSON.parse(r) : null);
}

async function cdpMouseClick(tabId, x, y) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await new Promise(r => setTimeout(r, 50));
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function cdpTypeText(tabId, text) {
  await dbgAttach(tabId);
  for (const ch of text) {
    await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
    await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await new Promise(r => setTimeout(r, 30));
  }
}

async function cdpPressKey(tabId, key) {
  await dbgAttach(tabId);
  const keyMap = {
    "Enter": { key: "Enter", code: "Enter", keyCode: 13, windowsVirtualKeyCode: 13, text: "\r" },
    "Tab": { key: "Tab", code: "Tab", keyCode: 9, windowsVirtualKeyCode: 9 },
    "Escape": { key: "Escape", code: "Escape", keyCode: 27, windowsVirtualKeyCode: 27 },
    "Backspace": { key: "Backspace", code: "Backspace", keyCode: 8, windowsVirtualKeyCode: 8 },
  };
  const kd = keyMap[key] || { key, code: key };
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...kd });
  await new Promise(r => setTimeout(r, 30));
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: kd.key, code: kd.code });
}

async function cdpInsertText(tabId, text) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Input.insertText", { text });
}

async function cdpClickSelector(tabId, selector) {
  const rect = await getElementRect(tabId, selector);
  if (!rect) throw new Error("element not found: " + selector);
  const x = Math.round(rect.x + rect.w / 2);
  const y = Math.round(rect.y + rect.h / 2);
  await cdpMouseClick(tabId, x, y);
  return { clicked: true, x, y, selector };
}

async function cdpFillSelector(tabId, selector, text) {
  await cdpClickSelector(tabId, selector);
  await new Promise(r => setTimeout(r, 200));
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
  await new Promise(r => setTimeout(r, 50));
  await cdpTypeText(tabId, text);
  return { filled: true, text };
}

// ===== NEW v0.3.0 HELPERS =====

// Hover over element (real mouse move to element center)
async function cdpHoverSelector(tabId, selector) {
  const rect = await getElementRect(tabId, selector);
  if (!rect) throw new Error("element not found: " + selector);
  const x = Math.round(rect.x + rect.w / 2);
  const y = Math.round(rect.y + rect.h / 2);
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  return { hovered: true, x, y, selector };
}

// Double click
async function cdpDoubleClick(tabId, x, y) {
  await dbgAttach(tabId);
  for (let i = 0; i < 2; i++) {
    await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: i + 1 });
    await new Promise(r => setTimeout(r, 30));
    await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: i + 1 });
  }
}

// Right click
async function cdpRightClick(tabId, x, y) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
}

// Wait for element to appear (poll with evalInTab)
async function waitForElement(tabId, selector, timeoutMs = 15000, shouldExist = true) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evalInTab(tabId, `!!document.querySelector(${JSON.stringify(selector)})`);
    if (shouldExist && found) return { found: true, waited: Date.now() - start };
    if (!shouldExist && !found) return { found: false, waited: Date.now() - start };
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`timeout ${timeoutMs}ms waiting for element ${selector} (${shouldExist ? "appear" : "disappear"})`);
}