// OpenCode in Chrome - CDP helpers v0.4.0+
// ALL interactions use CDP Input domain + DOM domain
const consoleBuffers = new Map();
const attached = new Map();

function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    const key = Number(tabId);
    if (attached.has(key)) return resolve();
    chrome.debugger.attach({tabId: key}, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err && !/Another debugger|Already attached/i.test(err.message))
        return reject(new Error(err.message));
      attached.set(key, true);
      chrome.debugger.sendCommand({tabId: key}, "Runtime.enable", () => void chrome.runtime.lastError);
      chrome.debugger.sendCommand({tabId: key}, "Page.enable", () => void chrome.runtime.lastError);
      resolve();
    });
  });
}
function dbgCmd(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({tabId: Number(tabId)}, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(res);
    });
  });
}
function detachAll() {
  for (const [tabId] of attached) { try { chrome.debugger.detach({tabId}); } catch(e) {} attached.delete(tabId); }
}
chrome.debugger.onDetach.addListener(src => { if (src && src.tabId != null) attached.delete(Number(src.tabId)); });
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId; if (!tabId) return;
  const key = String(tabId);
  let buf = consoleBuffers.get(key); if (!buf) { buf = []; consoleBuffers.set(key, buf); }
  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type || "")).join(" ");
    buf.push({ts: Date.now(), type: params.type, text: String(text).slice(0, 2000)});
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    buf.push({ts: Date.now(), type: "exception", text: String((d.text || "") + " " + ((d.exception && d.exception.description) || "")).slice(0, 2000)});
  }
  while (buf.length > 200) buf.shift();
});

async function activeTabId() { const tabs = await chrome.tabs.query({active:true,currentWindow:true}); if (!tabs.length) throw new Error("no active tab"); return tabs[0].id; }
async function requireTab(p) { const id = p && p.tabId != null ? Number(p.tabId) : await activeTabId(); await dbgAttach(id); return id; }
async function evalInTab(tabId, expression, awaitPromise) {
  const res = await dbgCmd(tabId, "Runtime.evaluate", {expression, awaitPromise:!!awaitPromise, returnByValue:true, userGesture:true});
  if (res.exceptionDetails) { const d = res.exceptionDetails; throw new Error("JS: " + (d.text||"") + " " + ((d.exception && (d.exception.value || d.exception.description)) || "")); }
  return res.result && res.result.value;
}
async function getElementRect(tabId, selector) {
  return await evalInTab(tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`).then(r => r ? JSON.parse(r) : null);
}
async function cdpMouseClick(tabId, x, y) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Input.dispatchMouseEvent", {type:"mouseMoved",x,y,button:"none"});
  await new Promise(r=>setTimeout(r,50));
  await dbgCmd(tabId, "Input.dispatchMouseEvent", {type:"mousePressed",x,y,button:"left",clickCount:1});
  await new Promise(r=>setTimeout(r,50));
  await dbgCmd(tabId, "Input.dispatchMouseEvent", {type:"mouseReleased",x,y,button:"left",clickCount:1});
}
async function cdpTypeText(tabId, text) {
  await dbgAttach(tabId);
  for (const ch of text) {
    await dbgCmd(tabId, "Input.dispatchKeyEvent", {type:"keyDown",text:ch,key:ch,unmodifiedText:ch});
    await dbgCmd(tabId, "Input.dispatchKeyEvent", {type:"keyUp",key:ch});
    await new Promise(r=>setTimeout(r,30));
  }
}
async function cdpPressKey(tabId, key) {
  await dbgAttach(tabId);
  const km = {"Enter":{key:"Enter",code:"Enter",keyCode:13,windowsVirtualKeyCode:13,text:"\r"},"Tab":{key:"Tab",code:"Tab",keyCode:9,windowsVirtualKeyCode:9},"Escape":{key:"Escape",code:"Escape",keyCode:27,windowsVirtualKeyCode:27},"Backspace":{key:"Backspace",code:"Backspace",keyCode:8,windowsVirtualKeyCode:8}};
  const kd = km[key] || {key,code:key};
  await dbgCmd(tabId, "Input.dispatchKeyEvent", {type:"keyDown",...kd});
  await new Promise(r=>setTimeout(r,30));
  await dbgCmd(tabId, "Input.dispatchKeyEvent", {type:"keyUp",key:kd.key,code:kd.code});
}
async function cdpClickSelector(tabId, sel) { const r = await getElementRect(tabId, sel); if (!r) throw new Error("not found: "+sel); const x = Math.round(r.x+r.w/2), y = Math.round(r.y+r.h/2); await cdpMouseClick(tabId,x,y); return {clicked:true,x,y,selector:sel}; }
async function cdpFillSelector(tabId, sel, text) { await cdpClickSelector(tabId, sel); await new Promise(r=>setTimeout(r,200)); await dbgCmd(tabId,"Input.dispatchKeyEvent",{type:"keyDown",modifiers:2,key:"a",code:"KeyA",windowsVirtualKeyCode:65}); await dbgCmd(tabId,"Input.dispatchKeyEvent",{type:"keyUp",key:"a",code:"KeyA"}); await new Promise(r=>setTimeout(r,50)); await cdpTypeText(tabId, text); return {filled:true,text}; }
async function cdpHoverSelector(tabId, sel) { const r = await getElementRect(tabId, sel); if (!r) throw new Error("not found: "+sel); const x = Math.round(r.x+r.w/2), y = Math.round(r.y+r.h/2); await dbgAttach(tabId); await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mouseMoved",x,y}); return {hovered:true,x,y,selector:sel}; }
async function cdpDoubleClick(tabId, x, y) { await dbgAttach(tabId); for (let i=0;i<2;i++) { await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:i+1}); await new Promise(r=>setTimeout(r,30)); await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:i+1}); } }
async function cdpRightClick(tabId, x, y) { await dbgAttach(tabId); await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"right",clickCount:1}); await new Promise(r=>setTimeout(r,50)); await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"right",clickCount:1}); }
async function waitForElement(tabId, sel, timeoutMs=15000, shouldExist=true) { const start = Date.now(); while (Date.now()-start<timeoutMs) { const f = await evalInTab(tabId, `!!document.querySelector(${JSON.stringify(sel)})`); if (shouldExist && f) return {found:true,waited:Date.now()-start}; if (!shouldExist && !f) return {found:false,waited:Date.now()-start}; await new Promise(r=>setTimeout(r,500)); } throw new Error(`timeout ${timeoutMs}ms waiting for ${sel}`); }

// ===== v0.4 DRAG AND DROP =====
async function cdpDragAndDrop(tabId, fromSel, toSel) {
  await dbgAttach(tabId);
  const fr = await getElementRect(tabId, fromSel); if (!fr) throw new Error("source not found: "+fromSel);
  const tr = await getElementRect(tabId, toSel); if (!tr) throw new Error("target not found: "+toSel);
  const fx = Math.round(fr.x+fr.w/2), fy = Math.round(fr.y+fr.h/2);
  const tx = Math.round(tr.x+tr.w/2), ty = Math.round(tr.y+tr.h/2);
  await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mousePressed",x:fx,y:fy,button:"left",clickCount:1});
  await new Promise(r=>setTimeout(r,100));
  const steps = 10;
  for (let i=1;i<=steps;i++) {
    const ix = Math.round(fx+(tx-fx)*i/steps), iy = Math.round(fy+(ty-fy)*i/steps);
    await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mouseMoved",x:ix,y:iy,button:"left"});
    await new Promise(r=>setTimeout(r,30));
  }
  await dbgCmd(tabId,"Input.dispatchMouseEvent",{type:"mouseReleased",x:tx,y:ty,button:"left",clickCount:1});
  return {dragged:true,from:{x:fx,y:fy},to:{x:tx,y:ty}};
}

// ===== v0.4 FILE UPLOAD =====
async function cdpUploadFile(tabId, selector, filePath) {
  await dbgAttach(tabId);
  const doc = await dbgCmd(tabId, "DOM.getDocument", {});
  const node = await dbgCmd(tabId, "DOM.querySelector", {nodeId: doc.root.nodeId, selector});
  if (!node.nodeId) throw new Error("file input not found: "+selector);
  await dbgCmd(tabId, "DOM.setFileInputFiles", {nodeId: node.nodeId, files: [filePath]});
  return {uploaded:true, selector, filePath};
}

// ===== v0.4 IFRAME =====
async function cdpGetIframes(tabId) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `JSON.stringify([...document.querySelectorAll('iframe,frame')].map((f,i)=>({index:i,id:f.id||undefined,name:f.name||undefined,src:(f.src||'').slice(0,100)})))`).then(r=>JSON.parse(r));
}
async function cdpEvalInIframe(tabId, iframeIndex, expression) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `
    (() => {
      const frames = document.querySelectorAll('iframe,frame');
      const frame = frames[${iframeIndex}];
      if (!frame) return JSON.stringify({error:'iframe not found'});
      try {
        const doc = frame.contentDocument || frame.contentWindow.document;
        const result = eval(${JSON.stringify(expression)});
        return JSON.stringify({ok:true, result:String(result).slice(0,500)});
      } catch(e) { return JSON.stringify({error:e.message, crossOrigin:true}); }
    })()
  `).then(r=>JSON.parse(r));
}

// ===== v0.4 SHADOW DOM =====
async function cdpShadowQuery(tabId, selector) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `
    (() => {
      function deepQuery(root, sel) {
        const direct = root.querySelector(sel); if (direct) return direct;
        for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { const f = deepQuery(el.shadowRoot, sel); if (f) return f; } }
        return null;
      }
      const el = deepQuery(document, ${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center'});
      return JSON.stringify({tag:el.tagName, text:(el.innerText||'').trim().slice(0,100)});
    })()
  `).then(r=>r?JSON.parse(r):null);
}

// ===== v0.5 FULL PAGE SCREENSHOT =====
async function cdpFullPageScreenshot(tabId) {
  await dbgAttach(tabId);
  // Get full page dimensions
  const dims = await evalInTab(tabId, `JSON.stringify({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight,vw:window.innerWidth,vh:window.innerHeight})`).then(r=>JSON.parse(r));
  // Set viewport to full page size
  await dbgCmd(tabId, "Emulation.setDeviceMetricsOverride", {width:dims.w, height:dims.h, deviceScaleFactor:1, mobile:false});
  await new Promise(r=>setTimeout(r,500));
  // Capture
  const res = await dbgCmd(tabId, "Page.captureScreenshot", {format:"png", captureBeyondViewport:true});
  // Reset viewport
  await dbgCmd(tabId, "Emulation.clearDeviceMetricsOverride");
  return {base64:res.data, width:dims.w, height:dims.h};
}

// ===== v0.5 ELEMENT SCREENSHOT =====
async function cdpElementScreenshot(tabId, selector) {
  await dbgAttach(tabId);
  const rect = await getElementRect(tabId, selector);
  if (!rect) throw new Error("not found: "+selector);
  const res = await dbgCmd(tabId, "Page.captureScreenshot", {
    format:"png", clip:{x:rect.x, y:rect.y, width:rect.w, height:rect.h, scale:1}
  });
  return {base64:res.data};
}

// ===== v0.5 PDF =====
async function cdpSavePDF(tabId) {
  await dbgAttach(tabId);
  const res = await dbgCmd(tabId, "Page.printToPDF", {printBackground:true});
  return {base64:res.data};
}

// ===== v0.5 GET PAGE SOURCE =====
async function cdpGetPageSource(tabId) {
  await dbgAttach(tabId);
  const res = await dbgCmd(tabId, "Page.captureScreenshot", {format:"mhtml"});
  // Also get HTML via eval
  const html = await evalInTab(tabId, "document.documentElement.outerHTML");
  return {mhtml:res.data, html:html.slice(0, 100000)};
}

// ===== v0.5 EXTRACT TABLE =====
async function cdpExtractTable(tabId, selector) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `
    (() => {
      const table = document.querySelector(${JSON.stringify(selector)});
      if (!table) return null;
      const headers = [...table.querySelectorAll('thead th, thead td')].map(th => th.innerText.trim());
      const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => td.innerText.trim())
      );
      return JSON.stringify({headers, rows});
    })()
  `).then(r=>r?JSON.parse(r):null);
}

// ===== v0.5 GET COMPUTED STYLE =====
async function cdpGetComputedStyle(tabId, selector, properties) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      const props = ${JSON.stringify(properties || ['display','color','backgroundColor','fontSize','fontWeight','margin','padding'])};
      const result = {};
      for (const p of props) result[p] = cs[p] || '';
      return JSON.stringify(result);
    })()
  `).then(r=>r?JSON.parse(r):null);
}

// ===== v0.5 ELEMENT HTML =====
async function cdpGetElementHTML(tabId, selector, outer) {
  await dbgAttach(tabId);
  return await evalInTab(tabId, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      return ${outer ? 'el.outerHTML' : 'el.innerHTML'};
    })()
  `);
}

// ===== v0.6 COOKIES =====
async function cdpGetCookies(tabId, domain) {
  await dbgAttach(tabId);
  const res = await dbgCmd(tabId, "Network.getCookies", {});
  const cookies = (res.cookies || [])
    .filter(c => !domain || c.domain.includes(domain))
    .map(c => ({name:c.name, value:c.value, domain:c.domain, path:c.path, expires:c.expires, httpOnly:c.httpOnly, secure:c.secure}));
  return {cookies};
}

// ===== v0.6 LOCAL STORAGE =====
async function cdpLocalStorage(tabId, action, key, value) {
  await dbgAttach(tabId);
  if (action === "get") return {value: await evalInTab(tabId, `localStorage.getItem(${JSON.stringify(key)})`)};
  if (action === "set") { await evalInTab(tabId, `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`); return {set:true}; }
  if (action === "remove") { await evalInTab(tabId, `localStorage.removeItem(${JSON.stringify(key)})`); return {removed:true}; }
  if (action === "all") return {data: await evalInTab(tabId, `JSON.stringify(localStorage)`)};
  return {};
}

// ===== v0.7 VIEWPORT / EMULATION =====
async function cdpSetViewport(tabId, width, height) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor:1, mobile: width < 768});
  return {viewport:{width, height}};
}
async function cdpSetUserAgent(tabId, userAgent) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Emulation.setUserAgentOverride", {userAgent});
  return {userAgent};
}
async function cdpSetGeolocation(tabId, lat, lng) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Emulation.setGeolocationOverride", {latitude:lat, longitude:lng, accuracy:100});
  return {geolocation:{latitude:lat, longitude:lng}};
}
async function cdpSetTimezone(tabId, tz) {
  await dbgAttach(tabId);
  await dbgCmd(tabId, "Emulation.setTimezoneOverride", {timezoneId:tz});
  return {timezone:tz};
}
async function cdpEmulateNetwork(tabId, condition) {
  await dbgAttach(tabId);
  const conditions = {"3G":{"downloadThroughput":750000,"uploadThroughput":250000,"latency":100},"offline":{"offline":true},"slow3G":{"downloadThroughput":400000,"uploadThroughput":400000,"latency":200}};
  const c = conditions[condition] || condition;
  await dbgCmd(tabId, "Network.emulateNetworkConditions", {...c, offline:false});
  return {emulated:condition};
}