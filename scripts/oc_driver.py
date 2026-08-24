#!/usr/bin/env python3
"""OpenCode in Chrome - interactive driver CLI (dedicated Edge, never touches user browser).

Usage:
  python oc_driver.py tabs
  python oc_driver.py nav <url>
  python oc_driver.py shot <out.png> [tabId]
  python oc_driver.py click <x> <y> [tabId]
  python oc_driver.py eval "<js>" [tabId]
  python oc_driver.py read [tabId]
"""
import json, os, subprocess, sys, time
import urllib.request
import websocket

PID_FILE = os.path.expanduser(r"~\.opencode-chrome\driver.pid")
PORT = 9223
WS_PORT = 8766
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILE_DIR = os.path.join(ROOT, ".edge-profile")
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
EDGE = next((p for p in EDGE_CANDIDATES if os.path.exists(p)), None)
DET = 0x00000008 | 0x00000200

def sh(*a):
    return subprocess.run(list(a), capture_output=True)

def cdp_up():
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2)
        return True
    except Exception:
        return False

def find_node():
    for p in os.environ["PATH"].split(";"):
        c = os.path.join(p, "node.exe")
        if os.path.exists(c):
            return c
    raise SystemExit("node not found")

# bridge: respawn owned instance each run (fast, deterministic)
import json as _j
out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True).stdout
for line in out.splitlines():
    parts = line.split()
    if len(parts) >= 5 and parts[3] == "LISTENING" and parts[1].endswith(f":{WS_PORT}"):
        opid = int(parts[4])
        ci = subprocess.run(["powershell", "-Command",
            f"(Get-CimInstance Win32_Process -Filter 'ProcessId={opid}').CommandLine"],
            capture_output=True, text=True).stdout
        if "bridge.mjs" in ci:
            subprocess.run(["taskkill", "/F", "/PID", str(opid)], capture_output=True)
            print(f"[bridge] killed stale {opid}")
        else:
            raise SystemExit(f"port {PORT} busy by foreign pid {opid}: {ci[:80]}")
        break
time.sleep(1)
old = None
try:
    old = int(open(PID_FILE).read().strip())
except Exception:
    pass


node = find_node()
logf = os.path.join(os.environ["TEMP"], "opencode-chrome-bridge.log")
proc = subprocess.Popen([node, os.path.join(ROOT, "bridge", "bridge.mjs")],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=open(logf, "a", encoding="utf-8"), text=True,
                        encoding="utf-8", creationflags=DET)
open(PID_FILE, "w").write(str(proc.pid))
time.sleep(3)

def rpc(method, params):
    rpc.n += 1
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rpc.n,
                                 "method": method, "params": params}) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        msg = json.loads(line)
        if msg.get("id") == rpc.n:
            return msg
rpc.n = 0

# edge with debugging
ver = None
if not cdp_up():
    if EDGE is None:
        raise SystemExit("no edge")
    subprocess.Popen([
        EDGE,
        f"--user-data-dir={PROFILE_DIR}",
        "--profile-directory=Default",
        f"--remote-debugging-port={PORT}",
        f"--load-extension={os.path.join(ROOT, 'extension')}",
        "--no-first-run",
        "--no-default-browser-check",
    ], creationflags=DET, close_fds=True)
for _ in range(40):
    try:
        ver = json.loads(urllib.request.urlopen(
            f"http://127.0.0.1:{PORT}/json/version", timeout=3).read())
        break
    except Exception:
        time.sleep(2)

bws = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=60,
                                  suppress_origin=True)
seq = [0]
def cdp_send(method, **params):
    seq[0] += 1
    bws.send(json.dumps({"id": seq[0], "method": method, "params": params}))
    while True:
        m = json.loads(bws.recv())
        if m.get("id") == seq[0]:
            return m.get("result", m.get("error", {}))
seq = [0]; sess = [None]

def bsend(method, **params):
    seq[0] += 1
    msg = {"id": seq[0], "method": method, "params": params}
    if sess[0]:
        msg["sessionId"] = sess[0]
    bws.send(json.dumps(msg))
    while True:
        m = json.loads(bws.recv())
        if m.get("id") == seq[0]:
            return m.get("result", m.get("error", {}))

def cdp_send(method, **params):
    seq[0] += 1
    bws.send(json.dumps({"id": seq[0], "method": method, "params": params}))
    while True:
        m = json.loads(bws.recv())
        if m.get("id") == seq[0]:
            return m.get("result", m.get("error", {}))

cdp_send("Extensions.loadUnpacked",
         path=os.path.join(ROOT, "extension"))
time.sleep(2)
# wait extension connected
for _ in range(15):
    time.sleep(2)
    res = rpc("tools/call", {"name": "chrome_tabs_list", "arguments": {}})
    if "not connected" not in res["result"]["content"][0]["text"]:
        print("[connected]")
        break

L = json.loads(res["result"]["content"][0]["text"])

cmd = sys.argv[1] if len(sys.argv) > 1 else "tabs"

if cmd == "tabs":
    print(json.dumps(L, ensure_ascii=False, indent=1))
elif cmd == "nav":
    url = sys.argv[2]
    r = rpc("tools/call", {"name": "chrome_tab_open", "arguments": {"url": url}})
    print(r["result"]["content"][0]["text"])
elif cmd == "shot":
    out = sys.argv[2]
    tid = int(sys.argv[3]) if len(sys.argv) > 3 else None
    args = {"tabId": tid} if tid else {}
    r = bsend("Target.attachToTarget", targetId=tid or L[0]["id"], flatten=True)
    sess[0] = r["sessionId"]
    bsend("Page.enable")
    rr = bsend("Page.captureScreenshot", format="png")
    import base64
    open(out, "wb").write(base64.b64decode(rr["data"]))
    print("saved", out)
elif cmd == "click":
    x, y = int(sys.argv[2]), int(sys.argv[3])
    tid = int(sys.argv[4]) if len(sys.argv) > 4 else None
    r = bsend("Target.attachToTarget", targetId=tid or L[0]["id"], flatten=True)
    sess[0] = r["sessionId"]
    bsend("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=1)
    bsend("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", clickCount=1)
    print(f"clicked {x},{y}")
elif cmd == "eval":
    expr = sys.argv[2]
    tid = int(sys.argv[3]) if len(sys.argv) > 3 else None
    args = {"expression": expr, "returnByValue": True}
    if tid:
        args["tabId"] = tid
    r = rpc("tools/call", {"name": "chrome_eval", "arguments": args})
    print(r["result"]["content"][0]["text"][:2000])
elif cmd == "read":
    tid = int(sys.argv[2]) if len(sys.argv) > 2 else None
    args = {"maxChars": 1500}
    if tid:
        args["tabId"] = tid
    r = rpc("tools/call", {"name": "chrome_read", "arguments": args})
    print(r["result"]["content"][0]["text"])