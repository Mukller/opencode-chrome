import fs from "node:fs";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const out = list
  .filter((t) => t.type === "page")
  .map((t) => ({ title: (t.title || "").slice(0, 50), url: t.url.slice(0, 80), ws: t.webSocketDebuggerUrl }));
fs.writeFileSync("targets.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
