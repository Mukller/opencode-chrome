<<<<<<< HEAD
// OpenCode in Chrome - command dispatcher v0.4.0+
async function handleCommand(cmd, p) {
  switch (cmd) {
    case "ping": return {pong:true, time:Date.now()};
    case "tabs_list": { const tabs = await chrome.tabs.query({}); return tabs.map(t => ({id:t.id,title:t.title,url:t.url,active:t.active})); }
    case "tabs_new": { const tab = await chrome.tabs.create({url:p.url||"about:blank",active:p.active!==false}); return {id:tab.id}; }
    case "tab_close": { await chrome.tabs.remove(Number(p.tabId)); return {closed:Number(p.tabId)}; }
    case "tab_switch": { await chrome.tabs.update(Number(p.tabId), {active:true}); return {switched:Number(p.tabId)}; }
    case "tab_navigate": { const id = await requireTab(p); if (p.url) { await chrome.tabs.update(id, {url:p.url}); await new Promise(r=>setTimeout(r,500)); } const tab = await chrome.tabs.get(id); return {id, url:tab.url, title:tab.title, status:tab.status}; }
    case "tab_wait_load": { const id = await requireTab(p); for (let i=0;i<60;i++) { const tab = await chrome.tabs.get(id); if (tab.status==="complete") return {id,url:tab.url,status:tab.status}; await new Promise(r=>setTimeout(r,500)); } throw new Error("timeout"); }
    case "tab_back": { const id = await requireTab(p); await chrome.tabs.goBack(id); return {navigated:"back"}; }
    case "tab_forward": { const id = await requireTab(p); await chrome.tabs.goForward(id); return {navigated:"forward"}; }
    case "tab_refresh": { const id = await requireTab(p); await chrome.tabs.reload(id); return {refreshed:true}; }
    case "tab_eval": { const id = await requireTab(p); return {value: await evalInTab(id, String(p.expression), !!p.awaitPromise)}; }
    case "tab_click": { const id = await requireTab(p); return await cdpClickSelector(id, String(p.selector)); }
    case "tab_click_coords": { const id = await requireTab(p); await cdpMouseClick(id, Number(p.x), Number(p.y)); return {clicked:true,x:p.x,y:p.y}; }
    case "tab_hover": { const id = await requireTab(p); return await cdpHoverSelector(id, String(p.selector)); }
    case "tab_double_click": { const id = await requireTab(p); const r = await getElementRect(id, String(p.selector)); if (!r) throw new Error("not found"); await cdpDoubleClick(id, Math.round(r.x+r.w/2), Math.round(r.y+r.h/2)); return {doubleClicked:true}; }
    case "tab_right_click": { const id = await requireTab(p); const r = await getElementRect(id, String(p.selector)); if (!r) throw new Error("not found"); await cdpRightClick(id, Math.round(r.x+r.w/2), Math.round(r.y+r.h/2)); return {rightClicked:true}; }
    case "tab_fill": { const id = await requireTab(p); return await cdpFillSelector(id, String(p.selector), String(p.text==null?"":p.text)); }
    case "tab_type": { const id = await requireTab(p); await cdpTypeText(id, String(p.text||"")); return {typed:true}; }
    case "tab_press_key": { const id = await requireTab(p); await cdpPressKey(id, String(p.key||"Enter")); return {pressed:true,key:p.key}; }
    case "tab_select": {
      const id = await requireTab(p);
      const sel = JSON.stringify(String(p.selector));
      const val = JSON.stringify(String(p.value||""));
      const result = await evalInTab(id, `(() => { const el = document.querySelector(${sel}); if (!el || el.tagName !== 'SELECT') return JSON.stringify({ok:false,error:'not a select'}); for (const opt of el.options) { if (opt.value === ${val} || opt.text.trim() === ${val}) { el.value = opt.value; el.dispatchEvent(new Event('change', {bubbles:true})); return JSON.stringify({ok:true,selected:opt.text}); } } return JSON.stringify({ok:false,error:'option not found'}); })()`);
      return JSON.parse(result);
=======
// OpenCode in Chrome - command dispatcher v0.3.0
// ALL form interactions use CDP Input domain (real mouse/keyboard)
// NEW: hover, select, wait_for_element, get_text, get_attribute, navigation, cookies, find_elements

async function handleCommand(cmd, p) {
  switch (cmd) {
    case "ping":
      return { pong: true, time: Date.now() };

    // ===== TABS =====
    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
    }
    case "tabs_new": {
      const tab = await chrome.tabs.create({ url: p.url || "about:blank", active: p.active !== false });
      return { id: tab.id };
    }
    case "tab_close": {
      await chrome.tabs.remove(Number(p.tabId));
      return { closed: Number(p.tabId) };
    }
    case "tab_switch": {
      await chrome.tabs.update(Number(p.tabId), { active: true });
      return { switched: Number(p.tabId) };
    }

    // ===== NAVIGATION =====
    case "tab_navigate": {
      const id = await requireTab(p);
      if (p.url) {
        await chrome.tabs.update(id, { url: p.url });
        await new Promise(r => setTimeout(r, 500));
      }
      const tab = await chrome.tabs.get(id);
      return { id, url: tab.url, title: tab.title, status: tab.status };
    }
    case "tab_wait_load": {
      const id = await requireTab(p);
      for (let i = 0; i < 60; i++) {
        const tab = await chrome.tabs.get(id);
        if (tab.status === "complete") return { id, url: tab.url, status: tab.status };
        await new Promise(r => setTimeout(r, 500));
      }
      throw new Error("timeout waiting for load");
    }
    case "tab_back": {
      const id = await requireTab(p);
      await chrome.tabs.goBack(id);
      return { navigated: "back" };
    }
    case "tab_forward": {
      const id = await requireTab(p);
      await chrome.tabs.goForward(id);
      return { navigated: "forward" };
    }
    case "tab_refresh": {
      const id = await requireTab(p);
      await chrome.tabs.reload(id);
      return { refreshed: true };
    }

    // ===== JS EVALUATION =====
    case "tab_eval": {
      const id = await requireTab(p);
      return { value: await evalInTab(id, String(p.expression), !!p.awaitPromise) };
    }

    // ===== MOUSE INTERACTIONS (CDP Input = real events) =====
    case "tab_click": {
      const id = await requireTab(p);
      return await cdpClickSelector(id, String(p.selector));
    }
    case "tab_click_coords": {
      const id = await requireTab(p);
      await cdpMouseClick(id, Number(p.x), Number(p.y));
      return { clicked: true, x: p.x, y: p.y };
    }
    case "tab_hover": {
      const id = await requireTab(p);
      return await cdpHoverSelector(id, String(p.selector));
    }
    case "tab_double_click": {
      const id = await requireTab(p);
      const rect = await getElementRect(id, String(p.selector));
      if (!rect) throw new Error("element not found: " + p.selector);
      const x = Math.round(rect.x + rect.w / 2);
      const y = Math.round(rect.y + rect.h / 2);
      await cdpDoubleClick(id, x, y);
      return { doubleClicked: true, x, y };
    }
    case "tab_right_click": {
      const id = await requireTab(p);
      const rect = await getElementRect(id, String(p.selector));
      if (!rect) throw new Error("element not found: " + p.selector);
      const x = Math.round(rect.x + rect.w / 2);
      const y = Math.round(rect.y + rect.h / 2);
      await cdpRightClick(id, x, y);
      return { rightClicked: true, x, y };
    }

    // ===== KEYBOARD INTERACTIONS (CDP Input = real events) =====
    case "tab_fill": {
      const id = await requireTab(p);
      return await cdpFillSelector(id, String(p.selector), String(p.text == null ? "" : p.text));
    }
    case "tab_type": {
      const id = await requireTab(p);
      await cdpTypeText(id, String(p.text || ""));
      return { typed: true };
    }
    case "tab_press_key": {
      const id = await requireTab(p);
      await cdpPressKey(id, String(p.key || "Enter"));
      return { pressed: true, key: p.key };
    }

    // ===== SELECT DROPDOWN =====
    case "tab_select": {
      const id = await requireTab(p);
      const sel = JSON.stringify(String(p.selector));
      const val = JSON.stringify(String(p.value || ""));
      const result = await evalInTab(id, `
        (() => {
          const el = document.querySelector(${sel});
          if (!el || el.tagName !== 'SELECT') return JSON.stringify({ok: false, error: 'not a select element'});
          for (const opt of el.options) {
            if (opt.value === ${val} || opt.text.trim() === ${val}) {
              el.value = opt.value;
              el.dispatchEvent(new Event('change', {bubbles: true}));
              return JSON.stringify({ok: true, selected: opt.text});
            }
          }
          return JSON.stringify({ok: false, error: 'option not found: ' + ${val}});
        })()
      `);
      return JSON.parse(result);
    }

    // ===== WAITING =====
    case "tab_wait_for_element": {
      const id = await requireTab(p);
      const shouldExist = p.shouldExist !== false;
      return await waitForElement(id, String(p.selector), Number(p.timeout || 15000), shouldExist);
    }

    // ===== SCROLLING =====
    case "tab_scroll": {
      const id = await requireTab(p);
      const direction = p.direction || "down";
      const amount = Number(p.amount || 500);
      const x = Number(p.x || 400);
      const y = Number(p.y || 400);
      await dbgCmd(id, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: 0,
        deltaY: direction === "down" ? amount : -amount
      });
      return { scrolled: true };
    }

    // ===== READING =====
    case "tab_read": {
      const id = await requireTab(p);
      const data = await evalInTab(id, `
        ({
          title: document.title,
          url: location.href,
          text: (document.body.innerText || "").slice(0, ${Number(p.maxChars) || 12000}),
          readyState: document.readyState
        })
      `);
      data.tabId = id;
      return data;
    }
    case "tab_get_text": {
      const id = await requireTab(p);
      return { text: await evalInTab(id, `
        (document.querySelector(${JSON.stringify(String(p.selector))}) || {}).innerText || ""
      `) };
    }
    case "tab_get_attribute": {
      const id = await requireTab(p);
      return { value: await evalInTab(id, `
        (document.querySelector(${JSON.stringify(String(p.selector))}) || {}).getAttribute(${JSON.stringify(String(p.attribute))})
      `) };
    }
    case "tab_get_all_links": {
      const id = await requireTab(p);
      return { links: await evalInTab(id, `
        JSON.stringify([...document.querySelectorAll('a[href]')]
          .filter(a => a.offsetParent !== null)
          .map(a => ({text: (a.innerText||'').trim().slice(0,80), href: a.href})))
      `) };
    }
    case "tab_find_elements": {
      const id = await requireTab(p);
      return { elements: await evalInTab(id, `
        JSON.stringify([...document.querySelectorAll(${JSON.stringify(String(p.selector))})]
          .filter(el => el.offsetParent !== null)
          .slice(0, ${Number(p.limit || 20)})
          .map(el => ({
            tag: el.tagName,
            text: (el.innerText || '').trim().slice(0, 100),
            id: el.id || undefined,
            cls: (el.className || '').toString().slice(0, 50),
            href: el.href || undefined
          })))
      `) };
    }

    // ===== SCREENSHOT & CONSOLE =====
    case "tab_screenshot": {
      const id = await requireTab(p);
      const res = await dbgCmd(id, "Page.captureScreenshot", { format: "png" });
      return { base64: res.data };
    }
    case "tab_console": {
      const id = await requireTab(p);
      const buf = consoleBuffers.get(String(id)) || [];
      return { entries: buf.slice(-(Number(p.last) || 50)) };
    }

    // ===== COOKIES =====
    case "cookies_get": {
      // Get cookies via CDP (no domain filter = all)
      const id = await requireTab(p);
      const res = await dbgCmd(id, "Network.getCookies", {});
      const domain = p.domain ? p.domain.toLowerCase() : "";
      const cookies = (res.cookies || [])
          .filter(c => !domain || c.domain.includes(domain))
          .map(c => ({name: c.name, value: c.value, domain: c.domain}));
      return { cookies };
    }

    // ===== COMPOSITE =====
    case "tab_click_and_wait": {
      const id = await requireTab(p);
      const url_before = await evalInTab(id, "location.href");
      await cdpClickSelector(id, String(p.selector));
      const timeout = Number(p.timeout || 15000);
      const start = Date.now();
      while (Date.now() - start < timeout) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const url_now = await evalInTab(id, "location.href");
          if (url_now !== url_before) return { navigated: true, url: url_now };
        } catch (e) {}
      }
      return { navigated: false };
    }
    case "tab_fill_and_submit": {
      const id = await requireTab(p);
      await cdpFillSelector(id, String(p.selector), String(p.text || ""));
      await new Promise(r => setTimeout(r, 500));
      await cdpPressKey(id, "Enter");
      return { filled: true, submitted: true };
>>>>>>> ca63c4f27e5a83dfe79495756900ac4b52e14521
    }
    case "tab_scroll": { const id = await requireTab(p); const d = p.direction||"down"; const a = Number(p.amount||500); await dbgCmd(id, "Input.dispatchMouseEvent", {type:"mouseWheel",x:400,y:400,deltaX:0,deltaY:d==="down"?a:-a}); return {scrolled:true}; }
    case "tab_read": { const id = await requireTab(p); const data = await evalInTab(id, `({title:document.title,url:location.href,text:(document.body.innerText||"").slice(0,${Number(p.maxChars)||12000}),readyState:document.readyState})`); data.tabId = id; return data; }
    case "tab_get_text": { const id = await requireTab(p); return {text: await evalInTab(id, `(document.querySelector(${JSON.stringify(String(p.selector))}) || {}).innerText || ""`)}; }
    case "tab_get_attribute": { const id = await requireTab(p); return {value: await evalInTab(id, `(document.querySelector(${JSON.stringify(String(p.selector))}) || {}).getAttribute(${JSON.stringify(String(p.attribute))})`)}; }
    case "tab_get_all_links": { const id = await requireTab(p); return {links: await evalInTab(id, `JSON.stringify([...document.querySelectorAll('a[href]')].filter(a=>a.offsetParent!==null).map(a=>({text:(a.innerText||'').trim().slice(0,80),href:a.href})))`)}; }
    case "tab_find_elements": { const id = await requireTab(p); return {elements: await evalInTab(id, `JSON.stringify([...document.querySelectorAll(${JSON.stringify(String(p.selector))})].filter(el=>el.offsetParent!==null).slice(0,${Number(p.limit||20)}).map(el=>({tag:el.tagName,text:(el.innerText||'').trim().slice(0,100),id:el.id||undefined,cls:(el.className||'').toString().slice(0,50)})))`)}; }
    case "tab_screenshot": { const id = await requireTab(p); const res = await dbgCmd(id, "Page.captureScreenshot", {format:"png"}); return {base64:res.data}; }
    case "tab_console": { const id = await requireTab(p); const buf = consoleBuffers.get(String(id)) || []; return {entries: buf.slice(-(Number(p.last)||50))}; }
    // ===== v0.4 =====
    case "tab_drag_and_drop": { const id = await requireTab(p); return await cdpDragAndDrop(id, String(p.fromSelector), String(p.toSelector)); }
    case "tab_upload_file": { const id = await requireTab(p); return await cdpUploadFile(id, String(p.selector), String(p.filePath)); }
    case "iframe_list": { const id = await requireTab(p); return await cdpGetIframes(id); }
    case "iframe_eval": { const id = await requireTab(p); return await cdpEvalInIframe(id, Number(p.index||0), String(p.expression)); }
    case "shadow_query": { const id = await requireTab(p); return await cdpShadowQuery(id, String(p.selector)); }
    // ===== v0.5 =====
    case "full_page_screenshot": { const id = await requireTab(p); return await cdpFullPageScreenshot(id); }
    case "element_screenshot": { const id = await requireTab(p); return await cdpElementScreenshot(id, String(p.selector)); }
    case "save_pdf": { const id = await requireTab(p); return await cdpSavePDF(id); }
    case "get_page_source": { const id = await requireTab(p); return await cdpGetPageSource(id); }
    case "extract_table": { const id = await requireTab(p); return await cdpExtractTable(id, String(p.selector)); }
    case "get_computed_style": { const id = await requireTab(p); return await cdpGetComputedStyle(id, String(p.selector), p.properties); }
    case "get_element_html": { const id = await requireTab(p); return {html: await cdpGetElementHTML(id, String(p.selector), p.outer !== false)}; }
    // ===== v0.6 =====
    case "cookies_get": { const id = await requireTab(p); return await cdpGetCookies(id, p.domain); }
    case "local_storage": { const id = await requireTab(p); return await cdpLocalStorage(id, String(p.action||"get"), p.key, p.value); }
    // ===== v0.7 =====
    case "set_viewport": { const id = await requireTab(p); return await cdpSetViewport(id, Number(p.width||1280), Number(p.height||800)); }
    case "set_user_agent": { const id = await requireTab(p); return await cdpSetUserAgent(id, String(p.userAgent)); }
    case "set_geolocation": { const id = await requireTab(p); return await cdpSetGeolocation(id, Number(p.latitude||53.9), Number(p.longitude||27.5)); }
    case "set_timezone": { const id = await requireTab(p); return await cdpSetTimezone(id, String(p.timezone||"Europe/Minsk")); }
    case "emulate_network": { const id = await requireTab(p); return await cdpEmulateNetwork(id, String(p.condition||"3G")); }
    // ===== COMPOSITE =====
    case "tab_click_and_wait": { const id = await requireTab(p); const url_before = await evalInTab(id, "location.href"); await cdpClickSelector(id, String(p.selector)); const timeout = Number(p.timeout||15000); const start = Date.now(); while (Date.now()-start<timeout) { await new Promise(r=>setTimeout(r,1000)); try { const url_now = await evalInTab(id, "location.href"); if (url_now!==url_before) return {navigated:true,url:url_now}; } catch(e) {} } return {navigated:false}; }
    case "tab_fill_and_submit": { const id = await requireTab(p); await cdpFillSelector(id, String(p.selector), String(p.text||"")); await new Promise(r=>setTimeout(r,500)); await cdpPressKey(id, "Enter"); return {filled:true,submitted:true}; }
  }
  throw new Error("unknown command: " + cmd);
}