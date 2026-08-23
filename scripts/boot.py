#!/usr/bin/env python3
"""
OpenCode in Chrome - safe bootstrap (dedicated Edge profile).

NEVER touches the user's daily browser: no global taskkill of chrome/node,
only processes this script started (tracked via pidfile).

Usage:  python scripts/boot.py
Result: bridge on ws://127.0.0.1:8766 + dedicated Edge (profile .edge-profile)
        with the extension loaded, connected and ready for opencode tools.
"""
import json, os, subprocess, sys, time
import urllib.request
import websocket

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = 9223          # CDP port of OUR dedicated Edge
WS_PORT = 8766       # bridge ws port
PROFILE_DIR = os.path.join(ROOT, ".edge-profile")
PID_FILE = os.path.expanduser(r"~\.opencode-chrome\bridge.pid")
TOKEN_FILE = os.path.expanduser(r"~\.opencode-chrome\token")

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
EDGE = next((p for p in EDGE_CANDIDATES if os.path.exists(p)), None)

DET = 0x00000008 | 0x00000200

def cdp_up(port=PORT):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2)
        return True
    except Exception:
        return False

def pid_alive(pid):
    if not pid:
        return False
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"],
                         capture_output=True, text=True).stdout
    return str(pid) in out

def port_owner_pid(port):
    out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True,
                         text=True).stdout
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3] == "LISTENING" and parts[1].endswith(f":{port}"):
            return int(parts[4])
    return None

# ---------- 1) bridge ----------
if cdp_up(WS_PORT):
    print("[bridge] already running, reusing")
else:
    owner = port_owner_pid(WS_PORT)
    old_pid = None
    try:
        old_pid = int(open(PID_FILE).read().strip())
    except Exception:
        pass
    if owner:
        # port busy: kill only if it is OUR previous bridge (pidfile match)
        if old_pid == owner:
            subprocess.run(["taskkill", "/F", "/PID", str(owner)], capture_output=True)
            time.sleep(1)
        else:
            raise SystemExit(f"port {WS_PORT} is used by foreign process pid={owner}; aborting")
    node = None
    for p in os.environ["PATH"].split(";"):
        c = os.path.join(p, "node.exe")
        if os.path.exists(c):
            node = c
            break
    logf = os.path.join(os.environ["TEMP"], "opencode-chrome-bridge.log")
    b = subprocess.Popen([node, os.path.join(ROOT, "bridge", "bridge.mjs")],
                         stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                         stderr=open(logf, "a", encoding="utf-8"), text=True,
                         encoding="utf-8", creationflags=DET)
    os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
    open(PID_FILE, "w").write(str(b.pid))
    print("[bridge] started pid", b.pid)
    time.sleep(2)

# ---------- 2) dedicated Edge ----------
launched = False
if not cdp_up():
    if EDGE is None:
        raise SystemExit("msedge.exe not found")
    subprocess.Popen([
        EDGE,
        f"--user-data-dir={PROFILE_DIR}",
        "--profile-directory=Default",
        f"--remote-debugging-port={PORT}",
        f"--load-extension={os.path.join(ROOT, 'extension')}",
        "--no-first-run",
        "--no-default-browser-check",
    ], creationflags=DET, close_fds=True)
    launched = True
    for _ in range(40):
        if cdp_up():
            break
        time.sleep(1)
    print("[edge] launched (dedicated profile)")
else:
    print("[edge] already running with debugging, reusing")

# ---------- 3) extension loaded? ----------
EXT_ID = "keinddgpmnbjaapocdmnfbjmbhldkpml"
ver = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=10).read())
bws = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)

def bsend(method, **params):
    bsend.n += 1
    bws.send(json.dumps({"id": bsend.n, "method": method, "params": params}))
    while True:
        m = json.loads(bws.recv())
        if m.get("id") == bsend.n:
            return m.get("result", m.get("error", {}))
bsend.n = 0

r = bsend("Extensions.loadUnpacked", path=os.path.join(ROOT, "extension"))
ext_id = r.get("id") or EXT_ID
print("[ext] loadUnpacked ->", ext_id)

# ---------- 4) token into SW ----------
sw = None
for _ in range(15):
    time.sleep(2)
    tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=5).read())
    sw = [x for x in tabs if x.get("type") == "service_worker" and ext_id in x.get("url", "")]
    if sw:
        break

if sw:
    TOKEN = open(TOKEN_FILE).read().strip()
    tws = websocket.create_connection(sw[0]["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
    tws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
        "expression": ("new Promise(r => chrome.storage.sync.set({"
                       f"wsUrl:'ws://127.0.0.1:{WS_PORT}', token:'{TOKEN}'}}, "
                       "() => r('ok')))"),
        "awaitPromise": True, "returnByValue": True}}))
    while True:
        m = json.loads(tws.recv())
        if m.get("id") == 1:
            print("[ext] token ok:", m["result"]["result"].get("value"))
            break
else:
    print("[ext] service worker still asleep - will wake on first tab event")

# ---------- 5) verify via bridge log ----------
for _ in range(10):
    time.sleep(2)
    logf_b = os.path.join(os.environ["TEMP"], "opencode-chrome-bridge.log")
    try:
        log = open(logf_b, encoding="utf-8").read()
    except OSError:
        continue
    tail_after_listen = log.split("waiting for the Chrome extension to connect...")[-1]
    if "chrome extension connected" in tail_after_listen:
        print("\nSUCCESS: extension <-> bridge CONNECTED. Agent can drive this browser.")
        sys.exit(0)

print("\nNOT CONNECTED YET. Open any new tab in the dedicated Edge window - the",
      "extension wakes on tab events and connects automatically.")
