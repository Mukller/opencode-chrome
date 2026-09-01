# opencode-chrome

**Give your local opencode agent full control of a real browser — clicks, types, screenshots, all via real CDP Input events that bypass bot detection.**

62 MCP tools · MV3 Chrome extension + Node.js bridge · `chrome.debugger` API for full CDP access

## What it does

`opencode-chrome` is a Chrome/Edge extension that exposes **62 browser automation tools** to any MCP-compatible agent (like opencode, Claude Code, etc.) over a localhost WebSocket. Every form interaction uses the **CDP Input domain** — real mouse and keyboard events at the browser level — so LinkedIn and other anti-bot sites can't detect automation.

Used in production to add 5/5 CI/CD skills to linkedin.com/in/anton-petnitsky and publish a v0.6.0 announcement post — both through CDP Input, not JS element.click().

## Architecture

```
┌─────────────────────┐       WS 127.0.0.1:8766       ┌──────────────────┐       stdio MCP       ┌──────────┐
│  Chrome Extension   │ ◄───────────────────────────► │  bridge.mjs      │ ◄──────────────────► │ opencode  │
│  (MV3, debugger API)│                                │  (Node.js)       │                      └──────────┘
└─────────────────────┘                                └──────────────────┘
        │
        │ CDP :9223
        ▼
   ┌──────────┐
   │  Edge    │
   └──────────┘
```

- **Extension** — MV3 service worker, uses `chrome.debugger` for full CDP (no need for `--remote-debugging-port` on default profile)
- **Bridge** — WS server (for the extension) + MCP stdio server (for the agent), token-authenticated
- **Token** — auto-generated on first run, stored in `~/.opencode-chrome/token` (chmod 600)

## Quick start

### 1. Start the bridge

```bash
node bridge/bridge.mjs
# [bridge] listening on ws://127.0.0.1:8766
# [bridge] token: a1b2c3d4...  (also saved to ~/.opencode-chrome/token)
```

### 2. Start Edge with the extension

```bash
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
  --user-data-dir=D:\Projects\opencode-chrome\.edge-profile \
  --profile-directory=Default \
  --remote-debugging-port=9223 \
  --load-extension=D:\Projects\opencode-chrome\extension \
  --no-first-run --no-default-browser-check \
  https://www.linkedin.com/in/anton-petnitsky/
```

(Edge is used because Chrome 151+ blocks CDP on default profile but Edge allows `--load-extension`. Use Chrome if you have a custom `--user-data-dir`.)

### 3. Auto-setup (recommended)

Instead of steps 1+2 manually, just run:

```bash
node scripts/auto.mjs
```

This script:
1. Starts the bridge if not running
2. Starts Edge with the extension
3. Auto-sets the extension token via CDP `chrome.storage.sync.set`
4. Waits for the extension to connect
5. Runs `tabs_list` to confirm everything works

### 4. Auto-recovery (optional)

For long-running sessions, run the watchdog in another terminal:

```bash
node scripts/watchdog.mjs
```

This monitors bridge (port 8766) and Edge (port 9223), auto-restarts them if they die.

## 62 MCP tools

All tools use **CDP Input domain** for mouse/keyboard (bypasses bot detection) and `chrome.debugger` for everything else.

### Navigation (9)
`chrome_tabs_list`, `chrome_tab_open`, `chrome_tab_navigate`, `chrome_tab_close`, `chrome_tab_switch`, `chrome_tab_wait_load`, `chrome_tab_back`, `chrome_tab_forward`, `chrome_tab_refresh`

### Mouse (7) — all real CDP Input events
`chrome_click` (selector), `chrome_click_coords` (x,y), `chrome_hover`, `chrome_double_click`, `chrome_right_click`, `chrome_scroll`, `chrome_drag_and_drop`

### Keyboard (3) — real CDP Input
`chrome_fill` (selector + text), `chrome_type` (focused element), `chrome_press_key` (Enter, Tab, etc.)

### Select (1)
`chrome_select` (dropdown by value or text)

### Reading (6)
`chrome_read` (title + url + text), `chrome_get_text`, `chrome_get_attribute`, `chrome_get_all_links`, `chrome_find_elements`, `chrome_eval` (run JS)

### Screenshots / PDF (4)
`chrome_screenshot` (image block), `chrome_full_page_screenshot`, `chrome_element_screenshot`, `chrome_save_pdf`

### Extraction (4)
`chrome_get_page_source`, `chrome_get_element_html`, `chrome_extract_table`, `chrome_get_computed_style`

### Waiting (2)
`chrome_wait_for_element`, `chrome_wait_and_retry`

### Composite (2)
`chrome_click_and_wait`, `chrome_fill_and_submit`

### Monitoring (1)
`chrome_console`

### Advanced (5)
`chrome_upload_file`, `chrome_iframe_list`, `chrome_iframe_eval`, `chrome_shadow_query`, `chrome_batch`, `chrome_if_exists`

### Cookies / Storage (4)
`chrome_cookies_get`, `chrome_cookie_set`, `chrome_local_storage`, `chrome_export_session`

### Emulation (5)
`chrome_set_viewport`, `chrome_set_user_agent`, `chrome_set_geolocation`, `chrome_set_timezone`, `chrome_emulate_network`

### v0.6.0 Anti-bot realism (4) — bypass LinkedIn et al.
`chrome_click_in_shadow` — pierces shadow DOM (artdeco-* web components)
`chrome_hover_and_reveal` — hover + wait for hidden edit buttons
`chrome_human_type` — realistic typing with jitter (50-150ms/char) and optional typo simulation
`chrome_scroll_to_element` — smooth-scroll to target

## Helper scripts

| Script | Purpose |
|--------|---------|
| `scripts/auto.mjs` | One-command setup: start bridge + Edge + set token + verify |
| `scripts/watchdog.mjs` | Auto-restart bridge/Edge if they crash |
| `scripts/post_linkedin.mjs [file]` | Copy post text to clipboard + open LinkedIn sharebox |
| `scripts/verify_skills.mjs` | Check that 5/5 CI/CD skills are still on LinkedIn profile |

## v0.6.0 changes

- **Extension**: 4 new anti-bot tools (`click_in_shadow`, `hover_and_reveal`, `human_type`, `scroll_to_element`)
- **Bridge**: was stuck at v0.1.0 (25 tools), now exposes all 62 tools via MCP. Added `askExtensionWithRetry()` for MV3 service worker lifecycle resilience
- **Background SW**: `chrome.alarms` keepalive every 24s, ping/pong every 20s, `onStartup` handler
- **auto.mjs**: full one-command setup
- **post_linkedin.mjs**: clipboard + sharebox helper
- **verify_skills.mjs**: profile skill checker

## Why CDP Input (not JS .click())?

LinkedIn, Cloudflare, and most modern sites detect `element.click()` because:
- The event has `isTrusted: false`
- No real mouse trajectory
- Instant timing

`chrome.debugger` + `Input.dispatchMouseEvent` creates events with `isTrusted: true` — the browser itself dispatches them — which bypasses these checks. The extension only uses JS `element.click()` for reading (not visible to users) and never for form interaction.

## Anti-bot features

LinkedIn's "About" section edit button is the only thing in this codebase that can't be automated. The button is rendered dynamically after a 2-3 second hover, only when the page detects a trusted mouse, and its click handler checks `event.isTrusted`. The v0.6.0 `hover_and_reveal` waits the right time, but LinkedIn's JS still blocks the synthetic click. This is a known limitation.

**Workaround**: copy-paste the text from `D:\Documents\Desktop\linkedin_pending_cicd_2026-08-22.md` into the About section manually (1-2 minutes).

## MV3 service worker lifecycle

MV3 kills idle service workers after ~30 seconds. The extension uses `chrome.alarms` (every 24s) to keep itself alive, and the bridge's `askExtensionWithRetry` waits and retries when the SW reconnects. Expect occasional 2-3 second delays on long-running sessions.

## License

MIT
