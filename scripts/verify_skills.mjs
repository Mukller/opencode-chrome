#!/usr/bin/env node
// Verify LinkedIn CI/CD skills are still present on the profile.
// Usage: node scripts/verify_skills.mjs
// Exits 0 if all 5 skills found, 1 if missing.

import WebSocket from "ws";

const PORT = 9223;
const EXPECTED = [
  "CI/CD",
  "GitHub Actions",
  "Continuous Integration",
  "Docker Compose",
  "Release Automation",
];

function log(m) { console.log(`[verify] ${m}`); }

const ver = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).text());
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
      if (r.id === sq) { clearTimeout(t); ws.off("message", h); if (r.error) rej(new Error(JSON.stringify(r.error))); else res(r.result || {}); }
    });
  });
}

async function ev(expr) {
  const r = await snd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

ws.on("open", async () => {
  const list = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).text());
  const tab = list.find(t => t.type === "page" && t.url.includes("linkedin.com/in/anton-petnitsky"));
  if (!tab) {
    log("LinkedIn profile tab not found. Open https://www.linkedin.com/in/anton-petnitsky/ first.");
    process.exit(2);
  }

  const r = await snd("Target.attachToTarget", { targetId: tab.id, flatten: true });
  sess = r.sessionId;
  await snd("Page.enable");

  log("Navigating to skills page...");
  await snd("Page.navigate", { url: "https://www.linkedin.com/in/anton-petnitsky/details/skills/" });
  await new Promise(r => setTimeout(r, 15000));

  // Wait for content
  for (let i = 0; i < 5; i++) {
    const text = await ev("document.body.innerText || ''");
    if (text.includes("Skills") || text.includes("Endorsement")) break;
    await new Promise(r => setTimeout(r, 3000));
  }

  // Check each expected skill
  const text = await ev("document.body.innerText || ''");
  log("Checking 5 expected skills:");
  let missing = [];
  for (const skill of EXPECTED) {
    const found = text.toLowerCase().includes(skill.toLowerCase());
    log(`  ${found ? "OK" : "MISSING"}: ${skill}`);
    if (!found) missing.push(skill);
  }

  if (missing.length === 0) {
    log("\nAll 5/5 skills verified! LinkedIn profile is up to date.");
    process.exit(0);
  } else {
    log(`\nMissing: ${missing.join(", ")}`);
    log("Add them manually: LinkedIn → Add skill → search and add");
    process.exit(1);
  }
});