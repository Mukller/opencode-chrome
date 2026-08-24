import fs from "node:fs";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const feed = list.find((t) => t.type === "page" && t.url.startsWith("https://www.linkedin.com/feed/"));
if (!feed) {
  console.error("no feed tab");
  process.exit(1);
}
fs.writeFileSync("feed-ws.txt", feed.webSocketDebuggerUrl);
console.log(feed.webSocketDebuggerUrl);
