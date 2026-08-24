// OpenCode in Chrome - command dispatcher
// ALL form interactions use CDP Input domain (real mouse/keyboard)

async function handleCommand(cmd, p) {
  switch (cmd) {
    case "ping":
      return { pong: true, time: Date.now() };

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

    // JS evaluation (for reading, not for form interactions)
    case "tab_eval": {
      const id = await requireTab(p);
      return { value: await evalInTab(id, String(p.expression), !!p.awaitPromise) };
    }

    // ===== FORM INTERACTIONS (all use CDP Input = real events) =====

    case "tab_click": {
      // Click by CSS selector using REAL mouse events
      const id = await requireTab(p);
      return await cdpClickSelector(id, String(p.selector));
    }

    case "tab_click_coords": {
      // Click at exact coordinates using REAL mouse events
      const id = await requireTab(p);
      await cdpMouseClick(id, Number(p.x), Number(p.y));
      return { clicked: true, x: p.x, y: p.y };
    }

    case "tab_fill": {
      // Fill input by CSS selector using REAL click + REAL typing
      const id = await requireTab(p);
      return await cdpFillSelector(id, String(p.selector), String(p.text == null ? "" : p.text));
    }

    case "tab_type": {
      // Type text into currently focused element using REAL keyboard
      const id = await requireTab(p);
      await cdpTypeText(id, String(p.text || ""));
      return { typed: true };
    }

    case "tab_press_key": {
      // Press a key using REAL keyboard events
      const id = await requireTab(p);
      await cdpPressKey(id, String(p.key || "Enter"));
      return { pressed: true, key: p.key };
    }

    case "tab_scroll": {
      // Scroll using CDP
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

    // ===== COMPOSITE OPERATIONS =====

    case "tab_click_and_wait": {
      // Click then wait for navigation
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
        } catch (e) { /* page might be loading */ }
      }
      return { navigated: false };
    }

    case "tab_fill_and_submit": {
      // Fill input, then press Enter to submit
      const id = await requireTab(p);
      await cdpFillSelector(id, String(p.selector), String(p.text || ""));
      await new Promise(r => setTimeout(r, 500));
      await cdpPressKey(id, "Enter");
      return { filled: true, submitted: true };
    }
  }
  throw new Error("unknown command: " + cmd);
}