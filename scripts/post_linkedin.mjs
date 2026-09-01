#!/usr/bin/env node
// Quick post helper - opens LinkedIn sharebox in a new tab and posts text from clipboard or file
// Usage: node scripts/post_linkedin.mjs [text-file]
// If no file given, copies the default v0.6.0 post text to clipboard and opens the page.

import WebSocket from "ws";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "node:child_process";

const PORT = 9223;
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\//, "").replace(/^file:\/\/\//, "");

async function fetchJSON(url) {
  return JSON.parse(await (await fetch(url)).text());
}

async function main() {
  // Get the LinkedIn tab or create one
  const tabs = await fetchJSON(`http://127.0.0.1:${PORT}/json/list`);
  let tab = tabs.find(t => t.type === "page" && t.url.includes("linkedin.com"));

  if (!tab) {
    console.log("No LinkedIn tab found. Open linkedin.com first.");
    process.exit(1);
  }

  console.log("LinkedIn tab:", tab.id, tab.url);

  // Read post text
  let postText;
  const arg = process.argv[2];
  if (arg && existsSync(arg)) {
    postText = readFileSync(arg, "utf8");
    console.log("Loaded text from:", arg);
  } else {
    // Default v0.6.0 post
    postText = `✅ v0.6.0 opencode-chrome published to GitHub

The extension now has 62 MCP browser automation tools — all form interactions use the real CDP Input domain (real mouse/keyboard events, not JS element.click()), which bypasses LinkedIn's bot detection.

New v0.6.0 anti-bot tools:
• click_in_shadow — pierces shadow DOM (LinkedIn artdeco-* web components)
• hover_and_reveal — reveals hidden edit buttons after hover delay
• human_type — realistic typing with jitter (50-150ms per char) and optional typo simulation
• scroll_to_element — smooth-scroll to target

5/5 CI/CD skills verified on LinkedIn (added manually): CI/CD, GitHub Actions, Continuous Integration, Docker Compose, Release Automation.

Repo: github.com/Mukller/opencode-chrome`;
    console.log("Using default v0.6.0 post text");
  }

  // Save to clipboard via PowerShell
  try {
    const ps = spawn("powershell", ["-Command", `Set-Clipboard -Value ${JSON.stringify(postText)}`], { stdio: "ignore" });
    await new Promise(r => ps.on("exit", r));
    console.log("Post text copied to clipboard.");
  } catch {}

  // Also save to a file
  const outFile = `${ROOT}/../Desktop/linkedin_post_quick.txt`;
  if (arg === undefined) {
    try {
      writeFileSync(outFile, postText);
      console.log("Also saved to:", outFile);
    } catch {}
  }

  // Open the sharebox URL in the same tab
  const ver = await fetchJSON(`http://127.0.0.1:${PORT}/json/version`);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let sq = 0, sess = null;
  function snd(m, p = {}, timeout = 30000) {
    return new Promise((res, rej) => {
      sq++;
      const msg = { id: sq, method: m, params: p };
      if (sess) msg.sessionId = sess;
      ws.send(JSON.stringify(msg));
      const t = setTimeout(() => res({}), timeout);
      ws.on("message", function h(d) {
        const r = JSON.parse(d);
        if (r.id === sq) { clearTimeout(t); ws.off("message", h); res(r.result || {}); }
      });
    });
  }
  await new Promise(r => ws.on("open", r));
  const r = await snd("Target.attachToTarget", { targetId: tab.id, flatten: true });
  sess = r.sessionId;

  console.log("\nNavigating to sharebox...");
  await snd("Page.navigate", { url: "https://www.linkedin.com/preload/sharebox/" });
  await new Promise(r => setTimeout(r, 8000));

  console.log("\nDone. Now:");
  console.log("  1. LinkedIn sharebox should be loading");
  console.log("  2. If it opened: Ctrl+V to paste, then click Post");
  console.log("  3. If it didn't open: go to linkedin.com/feed/ manually and click 'Start a post'");
  console.log("\nPost text is in your clipboard. Length:", postText.length, "chars");

  ws.close();
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });