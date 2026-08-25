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
// ===== v0.4: DRAG AND DROP =====
async function cdpDragAndDrop(tabId, fromSel, toSel) {
  await dbgAttach(tabId);
  const fr = await getElementRect(tabId, fromSel); if (!fr) throw new Error("source not found");
  const tr = await getElementRect(tabId, toSel); if (!tr) throw new Error("target not found");
  const fx = Math.round(fr.x+fr.w/2), fy = Math.round(fr.y+fr.h/2);
  const tx = Math.round(tr.x+tr.w/2), ty = Math.round(tr.y+tr.h/2);
  await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mousePressed",x:fx,y:fy,button:"left",clickCount:1});
  await new Promise(r=>setTimeout(r,100));
  for (let i=1;i<=10;i++) {
    const ix = Math.round(fx+(tx-fx)*i/10), iy = Math.round(fy+(ty-fy)*i/10);
    await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mouseMoved",x:ix,y:iy,button:"left"});
    await new Promise(r=>setTimeout(r,30));
  }
  await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mouseReleased",x:tx,y:ty,button:"left",clickCount:1});
  return {dragged:true};
}

// ===== v0.4: FILE UPLOAD =====
async function cdpUploadFile(tabId, selector, filePath) {
  await dbgAttach(tabId);
  const doc = await dbgCmd(tabId, "DOM.getDocument", {});
  const node = await dbgCmd(tabId, "DOM.querySelector", {nodeId: doc.root.nodeId, selector});
  if (!node.nodeId) throw new Error("file input not found");
  await dbgCmd(tabId, "DOM.setFileInputFiles", {nodeId: node.nodeId, files: [filePath]});
  return {uploaded:true};
}

// ===== v0.4: IFRAME =====
async function cdpGetIframes(tabId) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `JSON.stringify([...document.querySelectorAll('iframe,frame')].map((f,i)=>({index:i,src:(f.src||'').slice(0,100)})))`).then(r=>JSON.parse(r));
}
async function cdpEvalInIframe(tabId, idx, expr) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `(() => { const f = document.querySelectorAll('iframe,frame')[${idx}]; if (!f) return JSON.stringify({error:'not found'}); try { const d = f.contentDocument; const r = eval(${JSON.stringify(expr)}); return JSON.stringify({ok:true,result:String(r).slice(0,500)}); } catch(e) { return JSON.stringify({error:e.message}); } })()`).then(r=>JSON.parse(r));
}

// ===== v0.4: SHADOW DOM =====
async function cdpShadowQuery(tabId, selector) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `(() => { function dq(r,s) { const d = r.querySelector(s); if (d) return d; for (const e of r.querySelectorAll('*')) { if (e.shadowRoot) { const f = dq(e.shadowRoot,s); if (f) return f; } } return null; } const el = dq(document, ${JSON.stringify(selector)}); if (!el) return null; return JSON.stringify({tag:el.tagName,text:(el.innerText||'').slice(0,100)}); })()`).then(r=>r?JSON.parse(r):null);
}

// ===== v0.5: FULL PAGE SCREENSHOT =====
async function cdpFullPageScreenshot(tabId) {
  await dbgAttach(tabId);
  const dims = await evalInTab(tabId, `JSON.stringify({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})`).then(r=>JSON.parse(r));
  await dbgCmd(tabId, "Emulation.setDeviceMetricsOverride", {width:dims.w, height:dims.h, deviceScaleFactor:1, mobile:false});
  await new Promise(r=>setTimeout(r,500));
  const res = await dbgCmd(tabId, "Page.captureScreenshot", {format:"png"});
  await dbgCmd(tabId, "Emulation.clearDeviceMetricsOverride");
  return {base64:res.data};
}

// ===== v0.5: ELEMENT SCREENSHOT =====
async function cdpElementScreenshot(tabId, selector) {
  await dbgAttach(tabId);
  const rect = await getElementRect(tabId, selector);
  if (!rect) throw new Error("not found");
  const res = await dbgCmd(tabId, "Page.captureScreenshot", {format:"png", clip:{x:rect.x,y:rect.y,width:rect.w,height:rect.h,scale:1}});
  return {base64:res.data};
}

// ===== v0.5: PDF =====
async function cdpSavePDF(tabId) {
  await dbgAttach(tabId);
  const res = await dbgCmd(tabId, "Page.printToPDF", {printBackground:true});
  return {base64:res.data};
}

// ===== v0.5: EXTRACT =====
async function cdpGetPageSource(tabId) { await dbgAttach(tabId); return {html: await evalInTab(tabId, "document.documentElement.outerHTML.slice(0,100000)")}; }
async function cdpExtractTable(tabId, selector) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `(() => { const t = document.querySelector(${JSON.stringify(selector)}); if (!t) return null; const h = [...t.querySelectorAll('thead th')].map(x=>x.innerText.trim()); const rows = [...t.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.innerText.trim())); return JSON.stringify({headers:h,rows}); })()`).then(r=>r?JSON.parse(r):null);
}
async function cdpGetComputedStyle(tabId, selector) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const cs = getComputedStyle(el); return JSON.stringify({display:cs.display,color:cs.color,fontSize:cs.fontSize,backgroundColor:cs.backgroundColor}); })()`).then(r=>r?JSON.parse(r):null);
}
async function cdpGetElementHTML(tabId, selector, outer) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return ''; return ${outer ? 'el.outerHTML' : 'el.innerHTML'}; })()`);
}

// ===== v0.6: COOKIES / STORAGE / SESSION =====
async function cdpGetCookies(tabId, domain) {
  await dbgAttach(tabId);
  const res = await dbgCmd(tabId, "Network.getCookies", {});
  return {cookies: (res.cookies||[]).filter(c => !domain || c.domain.includes(domain)).map(c => ({name:c.name,value:c.value,domain:c.domain}))};
}
async function cdpSetCookie(tabId, name, value, domain) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Network.setCookie", {name, value, domain: domain || ".linkedin.com", path: "/"});
  return {set:true};
}
async function cdpLocalStorage(tabId, action, key, value) {
  await dbgAttach(tabId);
  if (action === "set") { await evalInTab(tabId, `localStorage.setItem(${JSON.stringify(key||"")}, ${JSON.stringify(value||"")})`); return {set:true}; }
  if (action === "remove") { await evalInTab(tabId, `localStorage.removeItem(${JSON.stringify(key||"")})`); return {removed:true}; }
  if (action === "all") return {data: await evalInTab(tabId, `JSON.stringify(localStorage)`)};
  return {value: await evalInTab(tabId, `localStorage.getItem(${JSON.stringify(key||"")})`)};
}
async function cdpExportSession(tabId) {
  await dbgAttach(tabId);
  const ck = await dbgCmd(tabId, "Network.getCookies", {});
  return {cookies: (ck.cookies||[]).map(c=>({name:c.name,value:c.value})), localStorage: await evalInTab(tabId, "JSON.stringify(localStorage)"), url: await evalInTab(tabId, "location.href")};
}

// ===== v0.7: EMULATION =====
async function cdpSetViewport(tabId, w, h) { await dbgAttach(tabId); await dbgCmd(tabId, "Emulation.setDeviceMetricsOverride", {width:w, height:h, deviceScaleFactor:1, mobile:w<768}); return {viewport:{w,h}}; }
async function cdpSetUserAgent(tabId, ua) { await dbgAttach(tabId); await dbgCmd(tabId, "Emulation.setUserAgentOverride", {userAgent:ua}); return {userAgent:ua}; }
async function cdpSetGeolocation(tabId, lat, lng) { await dbgAttach(tabId); await dbgCmd(tabId, "Emulation.setGeolocationOverride", {latitude:lat, longitude:lng, accuracy:100}); return {geo:{lat,lng}}; }
async function cdpSetTimezone(tabId, tz) { await dbgAttach(tabId); await dbgCmd(tabId, "Emulation.setTimezoneOverride", {timezoneId:tz}); return {timezone:tz}; }
async function cdpEmulateNetwork(tabId, cond) { await dbgAttach(tabId); const c = {"3G":{downloadThroughput:750000,uploadThroughput:250000,latency:100},"offline":{offline:true}}[cond] || cond; await dbgCmd(tabId, "Network.emulateNetworkConditions", {...c, offline:false}); return {emulated:cond}; }

// ===== v0.8: BATCH / IF_EXISTS / WAIT_AND_RETRY =====
async function cdpBatch(tabId, ops) {
  const results = [];
  for (const op of ops) {
    try {
      let r;
      if (op.action === "click") r = await cdpClickSelector(tabId, op.selector);
      else if (op.action === "fill") r = await cdpFillSelector(tabId, op.selector, op.text||"");
      else if (op.action === "eval") r = await evalInTab(tabId, op.expression);
      else if (op.action === "press_key") r = await cdpPressKey(tabId, op.key||"Enter");
      else if (op.action === "wait") { await new Promise(r=>setTimeout(r,Number(op.ms||1000))); r = {waited:true}; }
      else r = {error:"unknown: "+op.action};
      results.push({op:op.action, ok:true, result:r});
    } catch(e) { results.push({op:op.action, ok:false, error:e.message}); if (op.stop_on_error) break; }
    if (op.delay_after) await new Promise(r=>setTimeout(r,Number(op.delay_after)));
  }
  return {results};
}
async function cdpIfExists(tabId, selector, thenA, elseA) {
  const exists = await evalInTab(tabId, `!!document.querySelector(${JSON.stringify(selector)})`);
  const action = exists ? thenA : elseA;
  if (!action) return {exists, executed:false};
  let r;
  if (action.click_selector) r = await cdpClickSelector(tabId, action.click_selector);
  else if (action.fill_selector) r = await cdpFillSelector(tabId, action.fill_selector, action.text||"");
  else if (action.eval) r = await evalInTab(tabId, action.eval);
  else r = {executed:true};
  return {exists, executed:true, result:r};
}
async function cdpWaitAndRetry(tabId, action, selector, text, maxRetries, delayMs) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (action === "click") return await cdpClickSelector(tabId, selector);
      if (action === "fill") return await cdpFillSelector(tabId, selector, text||"");
      if (action === "eval") return await evalInTab(tabId, selector);
    } catch(e) { if (i === maxRetries-1) throw e; }
    await new Promise(r=>setTimeout(r,delayMs));
  }
}