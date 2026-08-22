// OpenCode in Chrome - command dispatcher
// Each handler receives params, returns JSON-safe data.

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

    case "tab_navigate": {
      const id = await requireTab(p);
      if (p.url) {
        await chrome.tabs.update(id, { url: p.url });
        // give the page a moment; caller can poll via tab_read
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

    case "tab_eval": {
      const id = await requireTab(p);
      return { value: await evalInTab(id, String(p.expression), !!p.awaitPromise) };
    }

    case "tab_click": {
      const id = await requireTab(p);
      return await evalInTab(id, "(" + CLICK_HELPER + ")(" + JSON.stringify(p.selector) + ")");
    }

    case "tab_fill": {
      const id = await requireTab(p);
      return await evalInTab(
        id,
        "(" + FILL_HELPER + ")(" + JSON.stringify(p.selector) + ", " + JSON.stringify(String(p.text == null ? "" : p.text)) + ")"
      );
    }

    case "tab_press_key": {
      const id = await requireTab(p);
      const key = String(p.key || "Enter");
      return await evalInTab(id, `
        (() => {
          const el = document.activeElement || document.body;
          const ev = new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true });
          el.dispatchEvent(ev);
          el.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(key)}, bubbles: true }));
          return { ok: true, focused: (el.tagName || "") + "." + (el.className || "").toString().slice(0, 40) };
        })()
      `);
    }

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

    case "tab_close": {
      await chrome.tabs.remove(Number(p.tabId));
      return { closed: Number(p.tabId) };
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
  }
  throw new Error("unknown command: " + cmd);
}