// OpenCode in Chrome - CDP helpers over chrome.debugger
// ALL interactions use CDP Input domain (real mouse/keyboard events)
// This makes them indistinguishable from real user input.

const consoleBuffers = new Map();
const attached = new Map(); // tabId -> true

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
      // Enable required domains
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

// Console capture
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

// ============ HIGH-LEVEL CDP HELPERS ============

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

// Get bounding rect of an element by selector
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

// REAL mouse click at coordinates via CDP Input
async function cdpMouseClick(tabId, x, y) {
  await dbgAttach(tabId);
  // Move mouse to position
  await dbgCmd(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none"
  });
  await new Promise(r => setTimeout(r, 50));
  // Press
  await dbgCmd(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1
  });
  await new Promise(r => setTimeout(r, 50));
  // Release
  await dbgCmd(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1
  });
}

// REAL keyboard typing via CDP Input (character by character)
async function cdpTypeText(tabId, text) {
  await dbgAttach(tabId);
  for (const ch of text) {
    // Key down
    await dbgCmd(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown", text: ch, key: ch, unmodifiedText: ch
    });
    // Key up
    await dbgCmd(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: ch
    });
    // Small delay between characters for React to process
    await new Promise(r => setTimeout(r, 30));
  }
}

// REAL key press (Enter, Tab, Escape, etc.)
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

// REAL text insertion (for focused input)
async function cdpInsertText(tabId, text) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Input.insertText", { text });
}

// Click element by selector using REAL mouse events
async function cdpClickSelector(tabId, selector) {
  const rect = await getElementRect(tabId, selector);
  if (!rect) throw new Error("element not found: " + selector);
  const x = Math.round(rect.x + rect.w / 2);
  const y = Math.round(rect.y + rect.h / 2);
  await cdpMouseClick(tabId, x, y);
  return { clicked: true, x, y, selector };
}

// Fill input by selector using REAL click + typing
async function cdpFillSelector(tabId, selector, text) {
  // Click to focus
  await cdpClickSelector(tabId, selector);
  await new Promise(r => setTimeout(r, 200));
  // Clear existing content
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  // Select all existing text (Ctrl+A)
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
  await new Promise(r => setTimeout(r, 50));
  // Type the text
  await cdpTypeText(tabId, text);
  return { filled: true, text };
}