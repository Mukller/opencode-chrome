import fs from "node:fs";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const feed = list.find((t) => t.type === "page" && t.url.includes("linkedin"));
if (!feed) { console.log(JSON.stringify({ error: "no linkedin tab", tabs: list.filter(t=>t.type==="page").map(t=>({title:t.title?.slice(0,40),url:t.url?.slice(0,60)})) })); process.exit(0); }
const ws = new WebSocket(feed.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `JSON.stringify({url:location.href.slice(0,100),title:document.title,body:document.body.innerText.slice(0,600)})`, returnByValue: true } }));
};
ws.onmessage = (ev) => {
  const r = JSON.parse(ev.data);
  if (r.id === 1) {
    console.log(r.result?.result?.value || JSON.stringify(r));
    process.exit(0);
  }
};
setTimeout(() => { console.log("ws timeout"); process.exit(1); }, 15000);
