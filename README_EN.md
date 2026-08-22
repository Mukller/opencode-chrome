# OpenCode in Chrome

Let your local [opencode](https://opencode.ai) agent see and drive the browser — tabs, clicks, JS evaluation, screenshots.

A Claude-in-Chrome alternative for opencode: a Chrome extension plus a local MCP bridge. The agent controls **your live browser** with its logged-in sessions, no `--remote-debugging-port` flag, nothing in the cloud. Localhost only.

See [README.md](README.md) (Russian) for the full documentation.

## Quick start

```bash
git clone https://github.com/Mukller/opencode-chrome.git
cd opencode-chrome && npm install
node bridge/bridge.mjs          # prints token, saves to ~/.opencode-chrome/token
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`
2. Extension popup → **Settings** → paste the token → Save & reconnect (badge turns green **ON**)
3. Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "chrome": {
      "type": "local",
      "command": ["node", "<repo path>/bridge/bridge.mjs"],
      "enabled": true
    }
  }
}
```

Restart opencode — the `chrome_*` tools are available to your agent.

MIT © [Anton Petnitsky](https://antonpetnitsky.com)
