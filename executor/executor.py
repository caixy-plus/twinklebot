import base64
import fnmatch
import getpass
import hashlib
import hmac
import http.server
import json
import os
import re
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

os.environ.setdefault("DISPLAY", ":1")

def _current_username() -> str:
    try:
        return getpass.getuser() or os.path.basename(os.path.expanduser("~"))
    except Exception:
        return os.path.basename(os.path.expanduser("~"))


_CURRENT_USER = _current_username()
DENIED_DIRS = tuple(
    dict.fromkeys(
        p
        for p in (
            os.path.expanduser("~/.ssh"),
            f"/Users/{_CURRENT_USER}/.ssh" if _CURRENT_USER else "",
            f"/home/{_CURRENT_USER}/.ssh" if _CURRENT_USER else "",
        )
        if p
    )
)

MAX_SHELL_OUTPUT = 20000
MAX_FILE_CHARS = 200000
DEFAULT_BROWSER = "/usr/local/bin/google-chrome"
DEFAULT_CDP_PORT = 9222


def _compute_self_sha256() -> str:
    try:
        with open(os.path.abspath(__file__), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:16]
    except Exception:
        return ""


EXECUTOR_FILE_SHA256 = _compute_self_sha256()
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_IGNORED_CDP_PREFIXES = ("devtools://", "chrome-extension://", "chrome://omnibox")
_BLANK_CDP_URLS = ("", "about:blank", "chrome://newtab/", "chrome://new-tab-page/", "edge://newtab/")
DISPLAY_MAP_PATH = os.environ.get("TWINKLEBOT_DISPLAY_MAP", "/opt/twinklebot/display-map.json")
PRIMARY_PROFILE_DIR = "/opt/twinklebot/chrome-profile"
ABSOLUTE_MIN_CONCURRENT_SCREENS = 1
ABSOLUTE_MAX_CONCURRENT_SCREENS = 16
BROWSER_IDLE_RECLAIM_SEC = max(60, int(os.environ.get("TWINKLEBOT_BROWSER_IDLE_SEC", str(5 * 60))))
BROWSER_SUSPEND_IDLE_SEC = max(
    BROWSER_IDLE_RECLAIM_SEC,
    int(os.environ.get("TWINKLEBOT_BROWSER_SUSPEND_SEC", str(10 * 60))),
)


def compute_screen_pool_budget(total_mem_bytes: int = None, cpu_cores: int = None) -> dict:
    if total_mem_bytes is None:
        try:
            with open("/proc/meminfo", "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        kb = int(line.split()[1])
                        # Linux container/WSL2 typically sees ~50% of host RAM; scale to equivalent budget
                        total_mem_bytes = kb * 1024 * 2
                        break
        except Exception:
            pass
    if not total_mem_bytes or total_mem_bytes <= 0:
        total_mem_bytes = 16 * (1024 ** 3)
    if cpu_cores is None:
        cpu_cores = os.cpu_count() or 8
    safe_cores = max(1, int(cpu_cores))
    mem_gib = max(1, int(round(total_mem_bytes / float(1024 ** 3))))

    min_screens = 1 if (mem_gib < 6 or safe_cores <= 2) else 2
    if mem_gib < 6:
        mem_cap = 3
    elif mem_gib < 12:
        mem_cap = 5
    elif mem_gib < 20:
        mem_cap = 8
    elif mem_gib < 28:
        mem_cap = 10
    elif mem_gib < 48:
        mem_cap = 12
    else:
        mem_cap = ABSOLUTE_MAX_CONCURRENT_SCREENS

    cpu_cap = max(3, min(ABSOLUTE_MAX_CONCURRENT_SCREENS, int((safe_cores * 5 + 3) // 4)))
    max_screens = max(min_screens + 2, min(ABSOLUTE_MAX_CONCURRENT_SCREENS, min(mem_cap, cpu_cap)))
    default_balanced = max(min_screens, min(max_screens, int(round(max_screens * 0.5))))
    return {
        "min": min_screens,
        "defaultBalanced": default_balanced,
        "max": max_screens,
        "totalMemGiB": mem_gib,
        "cpuCores": safe_cores,
    }


def _load_proxy_env() -> str:
    try:
        if os.path.isfile("/etc/twinklebot/proxy.env"):
            with open("/etc/twinklebot/proxy.env", "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("TWINKLE_PROXY="):
                        return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return os.environ.get("TWINKLE_PROXY", "").strip()


def desktop_env(display: str = None, cdp_port: int = None, profile_dir: str = None):
    env = os.environ.copy()
    env.pop("WAYLAND_DISPLAY", None)
    env.pop("PULSE_SERVER", None)
    raw_display = display or os.environ.get("TWINKLEBOT_DISPLAY") or os.environ.get("DISPLAY", "")
    resolved_display = raw_display if raw_display and raw_display != ":0" else ":1"
    env["DISPLAY"] = resolved_display
    env["TWINKLEBOT_DISPLAY"] = resolved_display
    if cdp_port:
        env["TWINKLEBOT_CDP_PORT"] = str(cdp_port)
    else:
        env.setdefault("TWINKLEBOT_CDP_PORT", str(DEFAULT_CDP_PORT))
    if profile_dir:
        env["TWINKLEBOT_PROFILE_DIR"] = str(profile_dir)
    proxy_url = _load_proxy_env()
    if proxy_url:
        env.setdefault("TWINKLE_PROXY", proxy_url)
        env.setdefault("HTTP_PROXY", proxy_url)
        env.setdefault("HTTPS_PROXY", proxy_url)
        env.setdefault("NO_PROXY", "127.0.0.1,localhost")
    env.setdefault("HOME", os.path.expanduser("~") or "/root")
    env.setdefault("XDG_SESSION_TYPE", "x11")
    env.setdefault("GDK_BACKEND", "x11")
    env.setdefault("QT_QPA_PLATFORM", "xcb")
    runtime_dir = f"/run/user/{os.getuid()}"
    if not os.path.isdir(runtime_dir):
        runtime_dir = f"/tmp/runtime-{os.getuid()}"
        try:
            os.makedirs(runtime_dir, mode=0o700, exist_ok=True)
        except Exception:
            pass
    env.setdefault("XDG_RUNTIME_DIR", runtime_dir)
    if resolved_display == ":1" and "DBUS_SESSION_BUS_ADDRESS" not in env:
        try:
            proc = subprocess.run(
                ["pgrep", "-n", "xfce4-panel"],
                capture_output=True,
                timeout=2,
            )
            pid = proc.stdout.decode("utf-8", errors="replace").strip()
            if pid:
                with open(f"/proc/{pid}/environ", "rb") as f:
                    for item in f.read().split(b"\0"):
                        if item.startswith(b"DBUS_SESSION_BUS_ADDRESS="):
                            env["DBUS_SESSION_BUS_ADDRESS"] = item.split(b"=", 1)[1].decode(
                                "utf-8", errors="replace"
                            )
                            break
        except Exception:
            pass
    return env


def default_run(argv, input=None, timeout=None, display: str = None, cdp_port: int = None, profile_dir: str = None, cwd: str = None):
    env = desktop_env(display=display, cdp_port=cdp_port, profile_dir=profile_dir)
    run_cwd = cwd if (cwd and os.path.isdir(cwd)) else None
    if input is not None:
        return subprocess.run(
            argv,
            input=input,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout or 10,
            env=env,
            cwd=run_cwd,
        )
    return subprocess.run(argv, input=input, capture_output=True, timeout=timeout or 15, env=env, cwd=run_cwd)


def default_spawn(argv, start_new_session=True, display: str = None, cdp_port: int = None, profile_dir: str = None):
    proc = subprocess.Popen(
        argv,
        start_new_session=start_new_session,
        env=desktop_env(display=display, cdp_port=cdp_port, profile_dir=profile_dir),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.25)
    return proc


def check_read_path_allowed(path: str):
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute string")

    paths_to_check = {path, os.path.normpath(path)}
    try:
        paths_to_check.add(os.path.realpath(path))
    except Exception:
        pass

    for p in paths_to_check:
        for denied_dir in DENIED_DIRS:
            if p == denied_dir or p.startswith(denied_dir + "/"):
                raise PermissionError(f"access to {path} is denied")
        if ".ssh" in p.replace("\\", "/").split("/"):
            raise PermissionError(f"access to {path} is denied")

        base = os.path.basename(p)
        if base == ".env":
            raise PermissionError(f"access to {path} is denied")
        if fnmatch.fnmatch(base, "*auth*.json"):
            raise PermissionError(f"access to {path} is denied")


def validate_coord(val, max_val, name):
    if type(val) is not int or isinstance(val, bool):
        raise ValueError(f"{name} must be an integer, got {type(val).__name__}")
    if not (0 <= val < max_val):
        raise ValueError(f"{name} out of range: {val} (must be 0 <= {name} < {max_val})")
    return val


def validate_point(x, y):
    validate_coord(x, 1440, "x")
    validate_coord(y, 900, "y")


def normalize_element_ref(ref) -> str:
    if not isinstance(ref, str) or not ref.strip():
        raise ValueError("ref must be a non-empty string (e.g. 'e1')")
    s = ref.strip().lstrip("[").rstrip("]").strip()
    if s.isdigit():
        s = f"e{s}"
    if not re.fullmatch(r"e\d+", s):
        raise ValueError(f"invalid element ref: {ref} (expected 'e1', 'e2', ...)")
    return s


def _is_blank_cdp_url(url: str) -> bool:
    s = str(url or "").strip().lower()
    return s in _BLANK_CDP_URLS


def select_cdp_page_target(targets):
    if not isinstance(targets, list):
        return None
    pages = [
        t
        for t in targets
        if isinstance(t, dict)
        and t.get("type") == "page"
        and isinstance(t.get("webSocketDebuggerUrl"), str)
    ]
    for t in pages:
        u = str(t.get("url") or "").strip()
        if u.startswith(_IGNORED_CDP_PREFIXES) or u.startswith("chrome://"):
            continue
        if not _is_blank_cdp_url(u):
            return t
    for t in pages:
        u = str(t.get("url") or "").strip()
        if not u.startswith(_IGNORED_CDP_PREFIXES):
            return t
    return pages[0] if pages else None


def _ws_send_frame(sock: socket.socket, payload: bytes, opcode: int = 0x1):
    mask_key = os.urandom(4)
    length = len(payload)
    header = bytearray([0x80 | (opcode & 0x0F)])
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack(">H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack(">Q", length))
    header.extend(mask_key)
    masked = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def _ws_recv_exact(sock: socket.socket, buf: bytearray, n: int) -> bytes:
    while len(buf) < n:
        chunk = sock.recv(max(4096, n - len(buf)))
        if not chunk:
            raise ConnectionError("unexpected EOF on CDP WebSocket")
        buf.extend(chunk)
    out = bytes(buf[:n])
    del buf[:n]
    return out


def _ws_recv_message(sock: socket.socket, buf: bytearray) -> str:
    fragments = []
    while True:
        b0, b1 = _ws_recv_exact(sock, buf, 2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        if length == 126:
            (length,) = struct.unpack(">H", _ws_recv_exact(sock, buf, 2))
        elif length == 127:
            (length,) = struct.unpack(">Q", _ws_recv_exact(sock, buf, 8))
        mask_key = _ws_recv_exact(sock, buf, 4) if masked else None
        payload = _ws_recv_exact(sock, buf, length)
        if mask_key:
            payload = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))

        if opcode == 0x8:  # Close
            raise ConnectionError("CDP WebSocket closed by browser")
        if opcode == 0x9:  # Ping -> Pong
            _ws_send_frame(sock, payload, opcode=0xA)
            continue
        if opcode == 0xA:  # Pong
            continue

        fragments.append(payload)
        if fin:
            return b"".join(fragments).decode("utf-8", errors="replace")


def fetch_cdp_targets(port: int = DEFAULT_CDP_PORT, timeout: float = 4.0):
    list_url = f"http://127.0.0.1:{port}/json/list"
    with urllib.request.urlopen(list_url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def activate_cdp_target(target: dict, port: int = DEFAULT_CDP_PORT, timeout: float = 3.0):
    target_id = target.get("id") if isinstance(target, dict) else None
    if not target_id:
        return
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/json/activate/{urllib.parse.quote(str(target_id))}",
            timeout=timeout,
        ) as resp:
            resp.read()
    except Exception:
        pass


def cdp_ws_session(ws_url: str, callback, timeout: float = 12.0):
    parsed = urllib.parse.urlparse(ws_url)
    host = parsed.hostname or "127.0.0.1"
    if host not in ("127.0.0.1", "localhost"):
        raise PermissionError(f"CDP only permitted on loopback, got {host}")
    port = parsed.port or DEFAULT_CDP_PORT
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    sec_key = base64.b64encode(os.urandom(16)).decode("ascii")
    expected_accept = base64.b64encode(
        hashlib.sha1((sec_key + _WS_GUID).encode("ascii")).digest()
    ).decode("ascii")

    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {sec_key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(req.encode("ascii"))

        buf = bytearray()
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("CDP WebSocket handshake failed (EOF)")
            buf.extend(chunk)

        idx = buf.index(b"\r\n\r\n") + 4
        header_text = bytes(buf[:idx]).decode("latin1", errors="replace")
        del buf[:idx]

        status_line = header_text.splitlines()[0] if header_text else ""
        if " 101 " not in status_line:
            raise ConnectionError(f"CDP WebSocket upgrade rejected: {status_line}")
        if expected_accept.lower() not in header_text.lower():
            raise ConnectionError("CDP WebSocket Sec-WebSocket-Accept mismatch")

        next_id = 0

        def call(method: str, params: dict = None):
            nonlocal next_id
            next_id += 1
            msg_id = next_id
            rpc = json.dumps({"id": msg_id, "method": method, "params": params or {}}).encode("utf-8")
            _ws_send_frame(sock, rpc, opcode=0x1)

            while True:
                raw_msg = _ws_recv_message(sock, buf)
                data = json.loads(raw_msg)
                if data.get("id") == msg_id:
                    if "error" in data:
                        err_msg = data["error"].get("message", str(data["error"]))
                        raise RuntimeError(f"CDP error: {err_msg}")
                    return data.get("result", {})

        return callback(call)


def cdp_ws_call(ws_url: str, method: str, params: dict = None, timeout: float = 12.0):
    return cdp_ws_session(ws_url, lambda call: call(method, params), timeout=timeout)


def _eval_on_session(call, expression: str):
    res = call(
        "Runtime.evaluate",
        {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        },
    )
    if "exceptionDetails" in res:
        exc = res["exceptionDetails"]
        desc = exc.get("exception", {}).get("description") or exc.get("text") or "JS evaluation error"
        raise RuntimeError(f"Browser JS error: {desc}")
    return res.get("result", {}).get("value")


def default_cdp_session(callback, port: int = DEFAULT_CDP_PORT, timeout: float = 12.0):
    try:
        targets = fetch_cdp_targets(port=port, timeout=timeout)
    except Exception as e:
        raise RuntimeError(f"Chromium CDP (127.0.0.1:{port}) unreachable: {e}")

    target = select_cdp_page_target(targets)
    if not target:
        raise RuntimeError(f"No active Chromium page tab found on CDP port {port}")

    activate_cdp_target(target, port=port, timeout=min(timeout, 3.0))
    return cdp_ws_session(target["webSocketDebuggerUrl"], callback, timeout=timeout)


def default_cdp_eval(expression: str, port: int = DEFAULT_CDP_PORT, timeout: float = 12.0):
    return default_cdp_session(lambda call: _eval_on_session(call, expression), port=port, timeout=timeout)


def bring_cdp_target_to_front(
    target_id: str,
    window_id: int = None,
    port: int = DEFAULT_CDP_PORT,
    display: str = ":1",
    timeout: float = 2.5,
) -> bool:
    """
    Ensure both the CDP tab AND its dedicated X11 Chrome window are raised to the foreground
    before X11 coordinate operations (`/screenshot`, `/click`, `/type`, `/key`, `/scroll`, `/drag`).
    """
    tid = str(target_id or "").strip()
    if not tid:
        return False
    raised = False
    ws_url = ""
    title = ""
    try:
        targets = fetch_cdp_targets(port=port, timeout=min(timeout, 1.5))
        if isinstance(targets, list):
            for t in targets:
                if isinstance(t, dict) and str(t.get("id") or "") == tid:
                    ws_url = str(t.get("webSocketDebuggerUrl") or "")
                    title = str(t.get("title") or "").strip()
                    break
    except Exception:
        pass
    if not ws_url:
        ws_url = f"ws://127.0.0.1:{port}/devtools/page/{tid}"

    # 1. Un-minimize the Bot's Chrome window via Browser.setWindowBounds if window_id is known
    if window_id is not None:
        try:
            set_cdp_window_bounds(int(window_id), {"windowState": "normal"}, port=port, timeout=min(timeout, 1.5))
        except Exception:
            pass

    # 2. Ask Chrome itself to focus/bring this page to front via CDP Page.bringToFront
    try:
        cdp_ws_call(ws_url, "Page.bringToFront", {}, timeout=min(timeout, 2.0))
        raised = True
    except Exception:
        pass

    # 3. Ask XFCE/X11 window manager (`wmctrl`) to raise the matching Chrome window by title
    if title:
        try:
            proc = default_run(["wmctrl", "-l"], timeout=1.5, display=display, cdp_port=port)
            out = (
                proc.stdout.decode("utf-8", errors="replace")
                if isinstance(proc.stdout, bytes)
                else str(proc.stdout or "")
            )
            title_lower = title.lower()
            matched_xid = None
            for line in out.splitlines():
                parts = line.strip().split(None, 3)
                if len(parts) < 4:
                    continue
                xid, wtitle = parts[0], parts[3]
                wlower = wtitle.lower()
                if title_lower in wlower and ("chrome" in wlower or "chromium" in wlower or wlower.startswith(title_lower)):
                    matched_xid = xid
                    break
            if matched_xid:
                default_run(["wmctrl", "-i", "-a", matched_xid], timeout=1.5, display=display, cdp_port=port)
                raised = True
        except Exception:
            pass

    return raised


def fetch_cdp_browser_ws(port: int = DEFAULT_CDP_PORT, timeout: float = 2.0):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as resp:
            info = json.loads(resp.read().decode("utf-8", errors="replace"))
            ws = info.get("webSocketDebuggerUrl") if isinstance(info, dict) else None
            return ws if isinstance(ws, str) and ws else None
    except Exception:
        return None


def close_cdp_target(target_id: str, port: int = DEFAULT_CDP_PORT, timeout: float = 2.0):
    tid = str(target_id or "").strip()
    if not tid:
        return
    browser_ws = fetch_cdp_browser_ws(port=port, timeout=min(timeout, 1.0))
    if browser_ws:
        try:
            cdp_ws_call(browser_ws, "Target.closeTarget", {"targetId": tid}, timeout=timeout)
            return
        except Exception:
            pass
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/json/close/{urllib.parse.quote(tid)}",
            timeout=timeout,
        ) as resp:
            resp.read()
    except Exception:
        pass


def get_cdp_window_for_target(
    target_id: str,
    port: int = DEFAULT_CDP_PORT,
    timeout: float = 2.0,
):
    tid = str(target_id or "").strip()
    if not tid:
        return None
    browser_ws = fetch_cdp_browser_ws(port=port, timeout=min(timeout, 1.5))
    if not browser_ws:
        return None
    try:
        res = cdp_ws_call(browser_ws, "Browser.getWindowForTarget", {"targetId": tid}, timeout=timeout)
        if isinstance(res, dict) and res.get("windowId") is not None:
            return res
    except Exception:
        return None
    return None


def set_cdp_window_bounds(
    window_id: int,
    bounds: dict,
    port: int = DEFAULT_CDP_PORT,
    timeout: float = 2.0,
) -> bool:
    if window_id is None or not isinstance(bounds, dict):
        return False
    browser_ws = fetch_cdp_browser_ws(port=port, timeout=min(timeout, 1.5))
    if not browser_ws:
        return False
    try:
        cdp_ws_call(
            browser_ws,
            "Browser.setWindowBounds",
            {"windowId": int(window_id), "bounds": bounds},
            timeout=timeout,
        )
        return True
    except Exception:
        return False


def create_cdp_target(
    url: str = "about:blank",
    port: int = DEFAULT_CDP_PORT,
    timeout: float = 4.0,
    new_window: bool = True,
    background: bool = False,
) -> dict:
    start_url = url if isinstance(url, str) and url.strip() else "about:blank"
    browser_ws = fetch_cdp_browser_ws(port=port, timeout=min(timeout, 2.0))
    if browser_ws:
        if new_window:
            param_variants = [
                {"url": start_url, "newWindow": True, "background": bool(background)},
                {"url": start_url, "newWindow": True},
                {"url": start_url},
            ]
        else:
            param_variants = [
                {"url": start_url, "newWindow": False, "background": bool(background)},
                {"url": start_url},
            ]
        for params in param_variants:
            try:
                res = cdp_ws_call(browser_ws, "Target.createTarget", params, timeout=timeout)
                tid = str((res or {}).get("targetId") or "").strip()
                if tid:
                    try:
                        for t in fetch_cdp_targets(port=port, timeout=min(timeout, 2.0)):
                            if isinstance(t, dict) and str(t.get("id") or "") == tid:
                                return t
                    except Exception:
                        pass
                    return {
                        "id": tid,
                        "type": "page",
                        "url": start_url,
                        "title": "",
                        "webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/devtools/page/{tid}",
                    }
            except Exception:
                continue

    encoded = urllib.parse.quote(start_url, safe=":/?&=#%")
    req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?{encoded}", method="PUT")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def create_cdp_tab_in_window(
    parent_target: dict,
    url: str = "about:blank",
    port: int = DEFAULT_CDP_PORT,
    window_id: int = None,
    timeout: float = 4.0,
    targets_fn=fetch_cdp_targets,
    window_for_target_fn=get_cdp_window_for_target,
):
    """
    Create a new tab strictly inside `parent_target`'s Chrome window (`window_id`),
    preferring `window.open(url, '_blank')` with `userGesture=True` on `parent_target`
    so the new tab opens in that exact window even while the window is in the background.
    """
    start_url = url if isinstance(url, str) and url.strip() else "about:blank"
    parent_tid = str((parent_target or {}).get("id") or "").strip()
    parent_ws = str((parent_target or {}).get("webSocketDebuggerUrl") or "").strip()
    if not parent_ws and parent_tid:
        parent_ws = f"ws://127.0.0.1:{port}/devtools/page/{parent_tid}"

    try:
        before_raw = targets_fn(port=port, timeout=min(timeout, 2.0)) or []
    except Exception:
        before_raw = []
    before_ids = {
        str(t.get("id") or "")
        for t in before_raw
        if isinstance(t, dict) and t.get("type") == "page" and t.get("id")
    }

    if parent_ws:
        try:
            cdp_ws_call(
                parent_ws,
                "Runtime.evaluate",
                {
                    "expression": f"Boolean(window.open({json.dumps(start_url)}, '_blank'))",
                    "userGesture": True,
                    "returnByValue": True,
                },
                timeout=min(timeout, 3.0),
            )
            deadline = time.time() + min(1.5, max(0.3, float(timeout)))
            while time.time() < deadline:
                try:
                    after_raw = targets_fn(port=port, timeout=min(timeout, 2.0)) or []
                except Exception:
                    after_raw = []
                new_pages = [
                    t
                    for t in after_raw
                    if isinstance(t, dict)
                    and t.get("type") == "page"
                    and t.get("id")
                    and str(t.get("id")) not in before_ids
                    and not str(t.get("url") or "").startswith(_IGNORED_CDP_PREFIXES)
                ]
                for cand in reversed(new_pages):
                    cid = str(cand["id"])
                    if window_id is not None and window_for_target_fn is not None:
                        winfo = window_for_target_fn(cid, port=port, timeout=1.5)
                        if isinstance(winfo, dict) and winfo.get("windowId") is not None:
                            if int(winfo["windowId"]) != int(window_id):
                                continue
                    return cand
                time.sleep(0.06)
        except Exception:
            pass

    # Fallback when parent page is a restricted scheme (e.g. chrome://) where window.open is disallowed
    if parent_tid:
        activate_cdp_target(parent_target, port=port, timeout=min(timeout, 1.5))
    return create_cdp_target(start_url, port=port, timeout=timeout, new_window=False, background=False)


def close_redundant_blank_tabs(port: int = DEFAULT_CDP_PORT, timeout: float = 2.0, protected_ids=None):
    protected = {str(x) for x in (protected_ids or ()) if x}
    try:
        targets = fetch_cdp_targets(port=port, timeout=timeout)
    except Exception:
        return 0
    if not isinstance(targets, list):
        return 0
    pages = [t for t in targets if isinstance(t, dict) and t.get("type") == "page"]
    non_blanks = [
        t
        for t in pages
        if not _is_blank_cdp_url(t.get("url", ""))
        and not str(t.get("url") or "").startswith(_IGNORED_CDP_PREFIXES)
    ]
    if not non_blanks:
        return 0
    closed = 0
    for t in pages:
        tid = str(t.get("id") or "")
        if tid and tid not in protected and _is_blank_cdp_url(t.get("url", "")):
            close_cdp_target(tid, port=port, timeout=timeout)
            closed += 1
    return closed


def reset_chrome_crash_state(profile_dir: str) -> None:
    for lock_name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        try:
            os.unlink(os.path.join(profile_dir, lock_name))
        except OSError:
            pass
    pref_path = os.path.join(profile_dir, "Default", "Preferences")
    if not os.path.isfile(pref_path):
        return
    try:
        with open(pref_path, "r", encoding="utf-8", errors="ignore") as f:
            data = json.load(f)
        if isinstance(data, dict):
            prof = data.setdefault("profile", {})
            changed = False
            if prof.get("exit_type") != "Normal":
                prof["exit_type"] = "Normal"
                changed = True
            if prof.get("exited_cleanly") is not True:
                prof["exited_cleanly"] = True
                changed = True
            if changed:
                with open(pref_path, "w", encoding="utf-8") as f:
                    json.dump(data, f)
    except Exception:
        pass


def display_resources(
    display_num: int = 1,
    primary_profile_dir: str = PRIMARY_PROFILE_DIR,
    display: str = ":1",
    cdp_port: int = DEFAULT_CDP_PORT,
    **_kwargs,
) -> dict:
    return {
        "display_num": 1,
        "display": str(display or ":1"),
        "vnc_port": 5901,
        "novnc_port": 6080,
        "cdp_port": int(cdp_port or DEFAULT_CDP_PORT),
        "profile_dir": primary_profile_dir,
    }


def _read_proc_listening_ports(
    proc_files: tuple = ("/proc/net/tcp", "/proc/net/tcp6"),
) -> set:
    ports = set()
    readable = False
    for path in proc_files:
        try:
            with open(path, "r", encoding="utf-8") as f:
                readable = True
                for line in f.readlines()[1:]:
                    cols = line.split()
                    if len(cols) >= 4 and cols[3] == "0A":
                        addr_parts = cols[1].split(":", 1)
                        if len(addr_parts) == 2:
                            try:
                                ports.add(int(addr_parts[1], 16))
                            except ValueError:
                                pass
        except OSError:
            continue
    return ports if readable else None


def _default_tcp_open(port: int, host: str = "127.0.0.1", timeout: float = 0.25) -> bool:
    if host in ("127.0.0.1", "localhost", "::1"):
        listening_ports = _read_proc_listening_ports()
        if listening_ports is not None:
            return int(port) in listening_ports
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _has_active_vnc_client(ports=(5901,)) -> bool:
    """
    Returns True when an active VNC client currently holds an ESTABLISHED TCP connection
    to TigerVNC/x11vnc (`:1` -> port 5901) so idle Chrome auto-suspend never interrupts
    a human user actively viewing or interacting through noVNC.
    """
    target_ports = {int(p) for p in ports}
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f.readlines()[1:]:
                    cols = line.split()
                    if len(cols) >= 4 and cols[3] == "01":
                        addr_parts = cols[1].split(":", 1)
                        if len(addr_parts) == 2:
                            try:
                                if int(addr_parts[1], 16) in target_ports:
                                    return True
                            except ValueError:
                                pass
        except OSError:
            continue
    return False


def navigate_cdp_target(
    target_id: str,
    url: str = "about:blank",
    port: int = DEFAULT_CDP_PORT,
    timeout: float = 2.0,
) -> bool:
    tid = str(target_id or "").strip()
    if not tid:
        return False
    ws_url = f"ws://127.0.0.1:{int(port)}/devtools/page/{tid}"
    try:
        cdp_ws_call(ws_url, "Page.navigate", {"url": str(url or "about:blank")}, timeout=timeout)
        return True
    except Exception:
        return False


def _find_profile_chrome_pids(profile_dir: str) -> list:
    pdir = str(profile_dir or "").strip()
    if not pdir or not os.path.isdir("/proc"):
        return []
    needle = f"--user-data-dir={pdir}"
    my_pid = os.getpid()
    matched = []
    try:
        for ent in os.listdir("/proc"):
            if not ent.isdigit():
                continue
            pid = int(ent)
            if pid == my_pid:
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    raw = f.read()
                if not raw:
                    continue
                parts = [p.decode("utf-8", errors="ignore") for p in raw.split(b"\0") if p]
                if not parts:
                    continue
                exe_base = os.path.basename(parts[0]).lower()
                if not any(tok in exe_base for tok in ("chrome", "chromium")):
                    continue
                if any(needle in arg for arg in parts[1:]):
                    matched.append(pid)
            except OSError:
                continue
    except OSError:
        return []
    return matched


def _terminate_profile_chrome_procs(profile_dir: str, grace_sec: float = 1.5) -> int:
    pids = _find_profile_chrome_pids(profile_dir)
    if not pids:
        return 0
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.time() + max(0.1, float(grace_sec))
    while time.time() < deadline:
        alive = _find_profile_chrome_pids(profile_dir)
        if not alive:
            return len(pids)
        time.sleep(0.1)
    for pid in _find_profile_chrome_pids(profile_dir):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return len(pids)


def close_cdp_browser(
    port: int = DEFAULT_CDP_PORT,
    profile_dir: str = None,
    timeout: float = 3.0,
) -> bool:
    """
    Gracefully shuts down the managed Chrome instance via CDP `Browser.close` so cookies,
    localStorage, and session state flush cleanly to `profile_dir`, then reaps any straggler
    processes still bound to `profile_dir`.
    """
    closed = False
    try:
        browser_ws = fetch_cdp_browser_ws(port=port, timeout=1.5)
        if browser_ws:
            try:
                cdp_ws_call(browser_ws, "Browser.close", {}, timeout=2.0)
                closed = True
            except Exception:
                pass
    except Exception:
        pass

    deadline = time.time() + max(0.2, float(timeout))
    while time.time() < deadline:
        if not _default_tcp_open(port):
            break
        time.sleep(0.15)

    reaped = _terminate_profile_chrome_procs(profile_dir or "", grace_sec=1.5) if profile_dir else 0
    return bool(closed or reaped > 0 or not _default_tcp_open(port))


class TabManager:
    """
    Multi-Bot Chrome Window Manager (1 Bot <-> 1 dedicated Chrome window) over a SINGLE official
    Google Chrome instance (`:1`, CDP `9222`) sharing the Primary Profile
    (`/opt/twinklebot/chrome-profile`) for 100% native shared login state.

    - Bot count is unlimited.
    - Each active Bot owns a dedicated maximized Chrome Window (`windowId` via CDP
      `Browser.getWindowForTarget`) that natively supports multiple tabs inside that window
      (user tabs, `target="_blank"` / `window.open()` popups, and `/browser/tabs` operations).
    - Concurrently active Bot windows are bounded by `max_concurrent_screens` (hardware-budgeted
      default); idle windows are reclaimed (closing all tabs in that window while preserving the
      last URL) when the pool is full, and in-flight overflows queue FIFO.
    """

    def __init__(
        self,
        map_path: str = DISPLAY_MAP_PATH,
        primary_profile_dir: str = PRIMARY_PROFILE_DIR,
        max_concurrent_screens: int = None,
        browser_idle_sec: int = BROWSER_IDLE_RECLAIM_SEC,
        browser_suspend_sec: int = None,
        browser_boot_timeout_sec: float = 8.0,
        cdp_port: int = DEFAULT_CDP_PORT,
        display: str = None,
        spawn_fn=subprocess.Popen,
        tcp_open_fn=_default_tcp_open,
        cdp_ws_fn=fetch_cdp_browser_ws,
        targets_fn=fetch_cdp_targets,
        create_tab_fn=create_cdp_target,
        close_tab_fn=close_cdp_target,
        navigate_tab_fn=None,
        close_browser_fn=None,
        vnc_active_fn=_has_active_vnc_client,
        activate_tab_fn=activate_cdp_target,
        window_for_target_fn=None,
        set_window_bounds_fn=None,
        create_tab_in_window_fn=None,
        browser_bin: str = None,
        **_legacy_kwargs,
    ):
        self.map_path = map_path
        self.primary_profile_dir = primary_profile_dir
        self.cdp_port = int(cdp_port or DEFAULT_CDP_PORT)
        self.display = str(display or os.environ.get("DISPLAY") or ":1")
        if self.display == ":0":
            self.display = ":1"
        self.budget = compute_screen_pool_budget()
        env_cap = os.environ.get("TWINKLEBOT_MAX_CONCURRENT_SCREENS", "").strip()
        initial_cap = (
            max_concurrent_screens
            if max_concurrent_screens is not None
            else (int(env_cap) if env_cap.isdigit() else self.budget["defaultBalanced"])
        )
        self.max_concurrent_screens = max(
            ABSOLUTE_MIN_CONCURRENT_SCREENS,
            min(ABSOLUTE_MAX_CONCURRENT_SCREENS, int(initial_cap)),
        )
        self.browser_idle_sec = max(1, int(browser_idle_sec))
        if browser_suspend_sec is not None:
            self.browser_suspend_sec = max(0, int(browser_suspend_sec))
        elif self.browser_idle_sec == BROWSER_IDLE_RECLAIM_SEC:
            self.browser_suspend_sec = BROWSER_SUSPEND_IDLE_SEC
        else:
            self.browser_suspend_sec = max(self.browser_idle_sec * 3, self.browser_idle_sec + 1)
        self.browser_boot_timeout_sec = max(0.05, float(browser_boot_timeout_sec))
        self.spawn_fn = spawn_fn
        self.tcp_open_fn = tcp_open_fn
        self.cdp_ws_fn = cdp_ws_fn
        self.targets_fn = targets_fn
        self.create_tab_fn = create_tab_fn
        self.close_tab_fn = close_tab_fn
        self.activate_tab_fn = activate_tab_fn
        is_real_cdp = cdp_ws_fn is fetch_cdp_browser_ws and create_tab_fn is create_cdp_target
        self.navigate_tab_fn = (
            navigate_tab_fn
            if navigate_tab_fn is not None
            else (navigate_cdp_target if is_real_cdp else None)
        )
        self.close_browser_fn = (
            close_browser_fn
            if close_browser_fn is not None
            else (close_cdp_browser if is_real_cdp else None)
        )
        self.vnc_active_fn = vnc_active_fn
        self.window_for_target_fn = (
            window_for_target_fn
            if window_for_target_fn is not None
            else (get_cdp_window_for_target if is_real_cdp else None)
        )
        self.set_window_bounds_fn = (
            set_window_bounds_fn
            if set_window_bounds_fn is not None
            else (set_cdp_window_bounds if is_real_cdp else None)
        )
        self.create_tab_in_window_fn = (
            create_tab_in_window_fn
            if create_tab_in_window_fn is not None
            else (create_cdp_tab_in_window if is_real_cdp else None)
        )
        self.browser_bin = browser_bin or DEFAULT_BROWSER
        self._lock = threading.RLock()
        self._slot_cond = threading.Condition(self._lock)
        self._browser_boot_lock = threading.RLock()
        self.x11_lock = threading.RLock()
        self._bot_targets = {}  # bot_key -> active target_id inside its window
        self._bot_windows = {}  # bot_key -> Chrome CDP windowId (int)
        self._bot_is_admin = {}  # bot_key -> bool
        self._bot_last_urls = {}  # bot_key -> last non-blank URL for seamless wake
        self._last_tab_at = {}  # bot_key -> timestamp
        self._last_activity_at = time.time()
        self._in_flight = {}  # bot_key -> active request count
        self._load_map()

    @staticmethod
    def _normalize_bot_key(bot_id: str = None, is_admin: bool = False) -> str:
        bid = str(bot_id or "").strip()
        if bid:
            return bid
        return "__admin__" if is_admin else "__default__"

    def _get_target_window_id(self, target_id: str):
        if not target_id or self.window_for_target_fn is None:
            return None
        try:
            info = self.window_for_target_fn(str(target_id), port=self.cdp_port, timeout=2.0)
            if isinstance(info, dict) and info.get("windowId") is not None:
                return int(info["windowId"])
        except Exception:
            return None
        return None

    def _maximize_window(self, window_id) -> bool:
        if window_id is None or self.set_window_bounds_fn is None:
            return False
        try:
            return bool(
                self.set_window_bounds_fn(
                    int(window_id),
                    {"windowState": "maximized"},
                    port=self.cdp_port,
                    timeout=2.0,
                )
            )
        except Exception:
            return False

    def _call_create_tab(self, url: str, new_window: bool = True, background: bool = False) -> dict:
        try:
            return self.create_tab_fn(
                url,
                port=self.cdp_port,
                new_window=new_window,
                background=background,
            )
        except TypeError:
            try:
                return self.create_tab_fn(url, port=self.cdp_port, new_window=new_window)
            except TypeError:
                return self.create_tab_fn(url, port=self.cdp_port)

    def _map_targets_by_window(self, live_pages: list) -> dict:
        by_win = {}
        if self.window_for_target_fn is None:
            return by_win
        for t in live_pages:
            tid = str(t.get("id") or "").strip()
            if not tid:
                continue
            wid = self._get_target_window_id(tid)
            if wid is not None:
                by_win.setdefault(wid, []).append(t)
        return by_win

    def list_bot_window_targets(self, bot_key: str, live_pages: list = None) -> list:
        """Return ONLY the live page targets belonging to `bot_key`'s bound Chrome window."""
        if not bot_key:
            return []
        pages = live_pages if live_pages is not None else self._live_page_targets()
        live_by_id = {str(t["id"]): t for t in pages}
        with self._lock:
            wid = self._bot_windows.get(bot_key)
            active_tid = self._bot_targets.get(bot_key)

        if self.window_for_target_fn is not None:
            if wid is None and active_tid and active_tid in live_by_id:
                wid = self._get_target_window_id(active_tid)
                if wid is not None:
                    with self._lock:
                        self._bot_windows[bot_key] = wid
            if wid is not None:
                matched = []
                for t in pages:
                    tid = str(t.get("id") or "")
                    if not tid:
                        continue
                    twid = self._get_target_window_id(tid)
                    if twid == wid:
                        matched.append(t)
                if matched:
                    return matched

        if active_tid and active_tid in live_by_id:
            return [live_by_id[active_tid]]
        return []

    def set_bot_active_target(self, bot_key: str, target_id: str, url: str = None) -> bool:
        tid = str(target_id or "").strip()
        if not bot_key or not tid:
            return False
        twid = self._get_target_window_id(tid)
        with self._lock:
            bound_wid = self._bot_windows.get(bot_key)
            if bound_wid is not None and twid is not None and twid != bound_wid:
                return False
            self._bot_targets[bot_key] = tid
            if twid is not None and bound_wid is None:
                self._bot_windows[bot_key] = twid
            u = str(url or "").strip()
            if u and not _is_blank_cdp_url(u):
                self._bot_last_urls[bot_key] = u
            now_ts = time.time()
            self._last_tab_at[bot_key] = now_ts
            self._last_activity_at = now_ts
            self._save_map()
        return True

    def _collect_window_close_ids(self, window_id, fallback_tid: str, live_pages: list, protected_other_tids: set) -> list:
        close_ids = []
        seen = set()
        if window_id is not None and self.window_for_target_fn is not None:
            for t in live_pages:
                tid = str(t.get("id") or "")
                if not tid or tid in protected_other_tids or tid in seen:
                    continue
                if self._get_target_window_id(tid) == window_id:
                    close_ids.append(tid)
                    seen.add(tid)
        if fallback_tid and fallback_tid not in protected_other_tids and fallback_tid not in seen:
            close_ids.append(fallback_tid)
        return close_ids

    def _load_map(self):
        try:
            if os.path.isfile(self.map_path):
                with open(self.map_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    raw_tabs = data.get("bot_targets")
                    if isinstance(raw_tabs, dict):
                        for k, v in raw_tabs.items():
                            bk = str(k or "").strip()
                            tid = str(v or "").strip()
                            if bk and tid:
                                self._bot_targets[bk] = tid
                    raw_wins = data.get("bot_windows")
                    if isinstance(raw_wins, dict):
                        for k, v in raw_wins.items():
                            bk = str(k or "").strip()
                            try:
                                wid = int(v)
                            except (TypeError, ValueError):
                                continue
                            if bk:
                                self._bot_windows[bk] = wid
                    raw_urls = data.get("bot_last_urls")
                    if isinstance(raw_urls, dict):
                        for k, v in raw_urls.items():
                            bk = str(k or "").strip()
                            u = str(v or "").strip()
                            if bk and u:
                                self._bot_last_urls[bk] = u
        except Exception:
            self._bot_targets = {}
            self._bot_windows = {}
            self._bot_last_urls = {}

    def _save_map(self):
        try:
            parent = os.path.dirname(self.map_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            bindings = {
                k: f"窗口 #{idx + 1}"
                for idx, (k, _tid) in enumerate(sorted(self._bot_targets.items()))
            }
            payload = {
                "mode": "shared-profile-multi-tab",
                "window_isolation": "cdp-window",
                "profile_dir": self.primary_profile_dir,
                "cdp_port": self.cdp_port,
                "max_concurrent_screens": self.max_concurrent_screens,
                "budget": self.budget,
                "bot_targets": dict(sorted(self._bot_targets.items())),
                "bot_windows": dict(sorted(self._bot_windows.items())),
                "bot_last_urls": dict(sorted(self._bot_last_urls.items())),
                "bindings": bindings,
            }
            tmp_path = f"{self.map_path}.tmp.{os.getpid()}"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, self.map_path)
        except Exception:
            pass

    def _live_page_targets(self) -> list:
        try:
            raw = self.targets_fn(port=self.cdp_port, timeout=2.5)
        except Exception:
            return []
        if not isinstance(raw, list):
            return []
        return [
            t
            for t in raw
            if isinstance(t, dict)
            and t.get("type") == "page"
            and t.get("id")
            and not str(t.get("url") or "").startswith(_IGNORED_CDP_PREFIXES)
        ]

    def ensure_browser(self) -> dict:
        res = display_resources(
            1,
            primary_profile_dir=self.primary_profile_dir,
            display=self.display,
            cdp_port=self.cdp_port,
        )
        with self._browser_boot_lock:
            self._last_activity_at = time.time()
            if self.cdp_ws_fn(port=self.cdp_port, timeout=1.5):
                return res
            os.makedirs(self.primary_profile_dir, exist_ok=True)
            reset_chrome_crash_state(self.primary_profile_dir)
            env = desktop_env(display=self.display, cdp_port=self.cdp_port, profile_dir=self.primary_profile_dir)
            # Keep Chrome strictly inside executor's systemd cgroup instead of escaping into
            # orphaned user@*.service `app-com.google.Chrome-*.scope` units on restart/shutdown.
            env.pop("DBUS_SESSION_BUS_ADDRESS", None)
            env.pop("XDG_ACTIVATION_TOKEN", None)
            argv = [
                self.browser_bin,
                "--ozone-platform=x11",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--use-gl=angle",
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
                "--num-raster-threads=1",
                "--disable-blink-features=AutomationControlled",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
                "--metrics-recording-only",
                "--no-pings",
                "--password-store=basic",
                "--window-position=0,0",
                "--window-size=1440,900",
                f"--remote-debugging-port={self.cdp_port}",
                "--remote-allow-origins=*",
                f"--user-data-dir={self.primary_profile_dir}",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-session-crashed-bubble",
                "--hide-crash-restore-bubble",
                "--process-per-site",
                "--no-first-run",
                "--no-default-browser-check",
                "about:blank",
            ]
            try:
                self.spawn_fn(
                    argv,
                    start_new_session=True,
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except OSError:
                return res

            deadline = time.time() + self.browser_boot_timeout_sec
            while time.time() < deadline:
                if self.cdp_ws_fn(port=self.cdp_port, timeout=1.2):
                    break
                time.sleep(0.2)
            return res

    def _reconcile_live_targets_locked(self, live_pages: list, live_by_id: dict, by_win: dict):
        """
        Reconcile stale active target_ids:
        - If a Bot's active tab was closed, but its bound `windowId` still has surviving tabs,
          automatically re-bind its active target to a surviving tab in that same window.
        - Only drop the Bot from `_bot_targets` / `_bot_windows` if its entire window is gone.
        """
        if not live_by_id:
            return
        changed = False
        for bk, tid in list(self._bot_targets.items()):
            if tid in live_by_id:
                continue
            wid = self._bot_windows.get(bk)
            survivors = by_win.get(wid, []) if wid is not None else []
            if survivors:
                self._bot_targets[bk] = str(survivors[-1]["id"])
                changed = True
            else:
                self._bot_targets.pop(bk, None)
                self._bot_windows.pop(bk, None)
                changed = True
        if changed:
            self._save_map()

    def set_max_concurrent_screens(self, limit: int) -> dict:
        clamped = max(
            ABSOLUTE_MIN_CONCURRENT_SCREENS,
            min(ABSOLUTE_MAX_CONCURRENT_SCREENS, int(limit)),
        )
        evicted_entries = []
        live_pages = self._live_page_targets()
        live_by_id = {str(t["id"]): t for t in live_pages}
        by_win = self._map_targets_by_window(live_pages)
        with self._lock:
            self.max_concurrent_screens = clamped
            self._reconcile_live_targets_locked(live_pages, live_by_id, by_win)
            if len(self._bot_targets) > clamped:
                idle_bots = [
                    bk
                    for bk in self._bot_targets
                    if self._in_flight.get(bk, 0) <= 0 and not self._bot_is_admin.get(bk, False)
                ]
                idle_bots.sort(key=lambda bk: self._last_tab_at.get(bk, 0.0))
                while len(self._bot_targets) > clamped and idle_bots:
                    victim = idle_bots.pop(0)
                    vtid = self._bot_targets.pop(victim, None)
                    vwid = self._bot_windows.pop(victim, None)
                    vt = live_by_id.get(vtid or "")
                    if vt and not _is_blank_cdp_url(vt.get("url", "")):
                        self._bot_last_urls[victim] = str(vt.get("url"))
                    if vtid or vwid is not None:
                        evicted_entries.append((vwid, vtid))
            protected_other = set(self._bot_targets.values())
            self._save_map()
            self._slot_cond.notify_all()
        remaining_live = len(live_pages)
        for vwid, vtid in evicted_entries:
            close_ids = self._collect_window_close_ids(vwid, vtid, live_pages, protected_other)
            for cid in close_ids:
                if remaining_live > 1:
                    self.close_tab_fn(cid, port=self.cdp_port)
                    remaining_live -= 1
        return {
            "ok": True,
            "max_concurrent_screens": self.max_concurrent_screens,
            "budget": self.budget,
        }

    def acquire_bot_tab(
        self,
        bot_id: str = None,
        is_admin: bool = False,
        activate: bool = False,
        create_if_missing: bool = True,
        wait_timeout: float = 45.0,
    ) -> dict:
        self.ensure_browser()
        bot_key = self._normalize_bot_key(bot_id, is_admin=is_admin)
        deadline = time.time() + max(0.0, float(wait_timeout))

        evicted_tid = None
        evicted_wid = None
        evicted_live_pages = []
        restore_url = "about:blank"
        chosen_target = None
        promote_old_tid = None

        while True:
            live_pages = self._live_page_targets()
            live_by_id = {str(t["id"]): t for t in live_pages}
            by_win = self._map_targets_by_window(live_pages) if self.window_for_target_fn is not None else {}

            with self._lock:
                self._bot_is_admin[bot_key] = bool(is_admin)
                self._reconcile_live_targets_locked(live_pages, live_by_id, by_win)

                existing_tid = self._bot_targets.get(bot_key)
                if existing_tid and (existing_tid in live_by_id or not live_by_id):
                    now_ts = time.time()
                    self._in_flight[bot_key] = self._in_flight.get(bot_key, 0) + 1
                    self._last_tab_at[bot_key] = now_ts
                    self._last_activity_at = now_ts
                    chosen_target = live_by_id.get(existing_tid) or {
                        "id": existing_tid,
                        "type": "page",
                        "url": self._bot_last_urls.get(bot_key, "about:blank"),
                        "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.cdp_port}/devtools/page/{existing_tid}",
                    }
                    cur_u = str(chosen_target.get("url") or "")
                    if cur_u and not _is_blank_cdp_url(cur_u):
                        self._bot_last_urls[bot_key] = cur_u
                    break

                if not create_if_missing:
                    base = display_resources(
                        1,
                        primary_profile_dir=self.primary_profile_dir,
                        display=self.display,
                        cdp_port=self.cdp_port,
                    )
                    return {**base, "bot_key": bot_key, "target_id": None, "window_id": None, "acquired": False}

                if len(self._bot_targets) < self.max_concurrent_screens:
                    now_ts = time.time()
                    self._in_flight[bot_key] = self._in_flight.get(bot_key, 0) + 1
                    self._last_tab_at[bot_key] = now_ts
                    self._last_activity_at = now_ts
                    restore_url = self._bot_last_urls.get(bot_key, "about:blank")
                    owned_ids = set(self._bot_targets.values())
                    owned_wids = set(self._bot_windows.values())
                    # Only claim an initial startup blank window when no other Bot already owns that window
                    if restore_url == "about:blank" and len(self._bot_targets) == 0:
                        for p in live_pages:
                            pid = str(p["id"])
                            if pid not in owned_ids and _is_blank_cdp_url(p.get("url", "")):
                                pwid = self._get_target_window_id(pid) if self.window_for_target_fn is not None else None
                                if pwid is not None and pwid in owned_wids:
                                    continue
                                chosen_target = p
                                self._bot_targets[bot_key] = pid
                                if pwid is not None:
                                    self._bot_windows[bot_key] = pwid
                                self._save_map()
                                break
                    break

                # Pool is at max_concurrent_screens: reclaim an IDLE window if any exists; otherwise wait FIFO!
                idle_candidates = [
                    bk
                    for bk in self._bot_targets
                    if self._in_flight.get(bk, 0) <= 0
                ]
                if idle_candidates:
                    idle_candidates.sort(
                        key=lambda bk: (1 if self._bot_is_admin.get(bk, False) else 0, self._last_tab_at.get(bk, 0.0))
                    )
                    victim_bot = idle_candidates[0]
                    evicted_tid = self._bot_targets.pop(victim_bot, None)
                    evicted_wid = self._bot_windows.pop(victim_bot, None)
                    evicted_live_pages = list(live_pages)
                    vt = live_by_id.get(evicted_tid or "")
                    if vt and not _is_blank_cdp_url(vt.get("url", "")):
                        self._bot_last_urls[victim_bot] = str(vt.get("url"))
                    now_ts = time.time()
                    self._in_flight[bot_key] = self._in_flight.get(bot_key, 0) + 1
                    self._last_tab_at[bot_key] = now_ts
                    self._last_activity_at = now_ts
                    restore_url = self._bot_last_urls.get(bot_key, "about:blank")
                    break

                remaining = deadline - time.time()
                if remaining <= 0:
                    raise RuntimeError(
                        f"All {self.max_concurrent_screens} concurrent Chrome windows are busy; timed out waiting in queue"
                    )
                self._slot_cond.wait(timeout=min(remaining, 0.4))

        try:
            # Verify an existing/claimed target owns a dedicated Chrome window (no sharing across Bots).
            # If it shares a window with another Bot (e.g. legacy pre-upgrade tab), promote it into its own window!
            if chosen_target is not None and self.window_for_target_fn is not None:
                ctid = str(chosen_target.get("id") or "").strip()
                cwid = self._get_target_window_id(ctid) if ctid else None
                if cwid is not None:
                    with self._lock:
                        other_owned_wids = {
                            w for bk, w in self._bot_windows.items() if bk != bot_key and w is not None
                        }
                        # Also check if another bound bot's target is sitting in the same window
                        other_tids_in_same_win = [
                            bk
                            for bk, otid in self._bot_targets.items()
                            if bk != bot_key and otid and otid != ctid and self._get_target_window_id(otid) == cwid
                        ]
                        shared_conflict = (cwid in other_owned_wids) or (bool(other_tids_in_same_win) and not is_admin)
                        if not shared_conflict:
                            if self._bot_windows.get(bot_key) != cwid:
                                self._bot_windows[bot_key] = cwid
                                self._save_map()
                    if shared_conflict:
                        promote_old_tid = ctid
                        restore_url = str(chosen_target.get("url") or "").strip() or "about:blank"
                        chosen_target = None
                    else:
                        self._maximize_window(cwid)

            # Spawn a dedicated maximized Chrome window FIRST (so Chrome never hits 0 tabs)
            if chosen_target is None:
                try:
                    created = self._call_create_tab(
                        restore_url,
                        new_window=True,
                        background=(not activate),
                    )
                    tid = str((created or {}).get("id") or "").strip()
                    if tid:
                        chosen_target = created
                        new_wid = self._get_target_window_id(tid)
                        with self._lock:
                            self._bot_targets[bot_key] = tid
                            if new_wid is not None:
                                self._bot_windows[bot_key] = new_wid
                            self._save_map()
                        if new_wid is not None:
                            self._maximize_window(new_wid)
                except Exception:
                    # Fallback to best available page if CDP /json/new isn't mocked in legacy tests
                    fallback_page = select_cdp_page_target(self._live_page_targets())
                    if fallback_page:
                        chosen_target = fallback_page
                        f_tid = str(fallback_page["id"])
                        f_wid = self._get_target_window_id(f_tid)
                        with self._lock:
                            self._bot_targets[bot_key] = f_tid
                            if f_wid is not None:
                                self._bot_windows[bot_key] = f_wid
                            self._save_map()

            if promote_old_tid and (not chosen_target or str(chosen_target.get("id")) != promote_old_tid):
                self.close_tab_fn(promote_old_tid, port=self.cdp_port)

            if evicted_tid or evicted_wid is not None:
                with self._lock:
                    protected_other = set(self._bot_targets.values())
                if isinstance(chosen_target, dict) and chosen_target.get("id"):
                    protected_other.add(str(chosen_target["id"]))
                close_ids = self._collect_window_close_ids(
                    evicted_wid,
                    evicted_tid,
                    evicted_live_pages or self._live_page_targets(),
                    protected_other,
                )
                for cid in close_ids:
                    self.close_tab_fn(cid, port=self.cdp_port)

            if activate and isinstance(chosen_target, dict) and chosen_target.get("id"):
                self.activate_tab_fn(chosen_target, port=self.cdp_port)

            with self._lock:
                bound_wid = self._bot_windows.get(bot_key)

            base = display_resources(
                1,
                primary_profile_dir=self.primary_profile_dir,
                display=self.display,
                cdp_port=self.cdp_port,
            )
            return {
                **base,
                "bot_key": bot_key,
                "target_id": str(chosen_target.get("id")) if isinstance(chosen_target, dict) and chosen_target.get("id") else None,
                "window_id": bound_wid,
                "ws_url": str(chosen_target.get("webSocketDebuggerUrl") or "") if isinstance(chosen_target, dict) else "",
                "tab_url": str(chosen_target.get("url") or "") if isinstance(chosen_target, dict) else "",
                "tab_title": str(chosen_target.get("title") or "") if isinstance(chosen_target, dict) else "",
                "acquired": True,
            }
        except Exception:
            self.release_bot_tab_in_flight(bot_key)
            raise

    def manage_bot_tabs(
        self,
        bot_key: str,
        action: str = "list",
        url: str = None,
        target_id: str = None,
        index: int = None,
    ) -> dict:
        """
        Window-scoped multi-Tab management strictly restricted to `bot_key`'s own Chrome `windowId`.
        Supports: `list`, `new`, `switch`, `close`.
        """
        act = str(action or "list").strip().lower()
        if act not in ("list", "new", "switch", "close"):
            raise ValueError(f"unsupported browser_tabs action: {action!r} (expected list/new/switch/close)")

        def _format_tabs(tabs_list, active_id):
            return [
                {
                    "index": i,
                    "target_id": str(t.get("id") or ""),
                    "url": str(t.get("url") or ""),
                    "title": str(t.get("title") or ""),
                    "active": str(t.get("id") or "") == active_id,
                }
                for i, t in enumerate(tabs_list)
            ]

        def _pick_target(tabs_list, req_tid, req_idx):
            if req_tid is not None and str(req_tid).strip():
                want = str(req_tid).strip()
                for t in tabs_list:
                    if str(t.get("id") or "") == want:
                        return t
                raise ValueError(f"target_id {want!r} not found in this bot's window")
            if req_idx is not None:
                if type(req_idx) is not int or isinstance(req_idx, bool):
                    raise ValueError("index must be an integer")
                if req_idx < 0 or req_idx >= len(tabs_list):
                    raise ValueError(f"tab index {req_idx} out of range (0..{max(0, len(tabs_list) - 1)})")
                return tabs_list[req_idx]
            return None

        live_pages = self._live_page_targets()
        win_tabs = self.list_bot_window_targets(bot_key, live_pages=live_pages)
        with self._lock:
            wid = self._bot_windows.get(bot_key)
            active_tid = self._bot_targets.get(bot_key)

        if act == "list":
            return {
                "ok": True,
                "action": "list",
                "window_id": wid,
                "active_target_id": active_tid,
                "tab_count": len(win_tabs),
                "tabs": _format_tabs(win_tabs, active_tid),
            }

        if act == "new":
            start_url = "about:blank"
            if url is not None and str(url).strip():
                if not isinstance(url, str):
                    raise TypeError("url must be a string")
                u = url.strip()
                if u != "about:blank":
                    parsed = urllib.parse.urlparse(u)
                    if parsed.scheme not in ("http", "https"):
                        raise ValueError(f"invalid scheme: {parsed.scheme}")
                start_url = u

            parent_target = None
            for t in win_tabs:
                if str(t.get("id") or "") == active_tid:
                    parent_target = t
                    break
            if parent_target is None and win_tabs:
                parent_target = win_tabs[-1]

            if self.create_tab_in_window_fn is not None and parent_target is not None:
                created = self.create_tab_in_window_fn(
                    parent_target,
                    url=start_url,
                    port=self.cdp_port,
                    window_id=wid,
                    targets_fn=self.targets_fn,
                    window_for_target_fn=self.window_for_target_fn,
                )
            else:
                created = self._call_create_tab(start_url, new_window=False, background=True)

            new_tid = str((created or {}).get("id") or "").strip()
            if not new_tid:
                raise RuntimeError("Failed to open new tab in bot window")
            with self._lock:
                self._bot_targets[bot_key] = new_tid
                if wid is None:
                    nwid = self._get_target_window_id(new_tid)
                    if nwid is not None:
                        self._bot_windows[bot_key] = nwid
                        wid = nwid
                if not _is_blank_cdp_url(start_url):
                    self._bot_last_urls[bot_key] = start_url
                now_ts = time.time()
                self._last_tab_at[bot_key] = now_ts
                self._last_activity_at = now_ts
                self._save_map()
            updated_tabs = self.list_bot_window_targets(bot_key)
            return {
                "ok": True,
                "action": "new",
                "window_id": wid,
                "active_target_id": new_tid,
                "target_id": new_tid,
                "url": str((created or {}).get("url") or start_url),
                "tab_count": len(updated_tabs),
                "tabs": _format_tabs(updated_tabs, new_tid),
            }

        if act == "switch":
            chosen = _pick_target(win_tabs, target_id, index)
            if chosen is None:
                raise ValueError("switch requires target_id or index")
            cid = str(chosen["id"])
            with self._lock:
                self._bot_targets[bot_key] = cid
                cu = str(chosen.get("url") or "")
                if cu and not _is_blank_cdp_url(cu):
                    self._bot_last_urls[bot_key] = cu
                now_ts = time.time()
                self._last_tab_at[bot_key] = now_ts
                self._last_activity_at = now_ts
                self._save_map()
            self.activate_tab_fn(chosen, port=self.cdp_port)
            return {
                "ok": True,
                "action": "switch",
                "window_id": wid,
                "active_target_id": cid,
                "target_id": cid,
                "url": str(chosen.get("url") or ""),
                "title": str(chosen.get("title") or ""),
                "tab_count": len(win_tabs),
                "tabs": _format_tabs(win_tabs, cid),
            }

        # act == "close"
        if len(win_tabs) <= 1:
            return {
                "ok": False,
                "action": "close",
                "window_id": wid,
                "active_target_id": active_tid,
                "tab_count": len(win_tabs),
                "tabs": _format_tabs(win_tabs, active_tid),
                "error": "cannot close the last remaining tab in this bot's window; navigate it instead",
            }
        chosen = _pick_target(win_tabs, target_id, index)
        if chosen is None:
            for t in win_tabs:
                if str(t.get("id") or "") == active_tid:
                    chosen = t
                    break
            if chosen is None:
                chosen = win_tabs[-1]
        close_tid = str(chosen["id"])
        close_idx = next((i for i, t in enumerate(win_tabs) if str(t.get("id") or "") == close_tid), 0)
        remaining_win_tabs = [t for t in win_tabs if str(t.get("id") or "") != close_tid]
        next_active_tid = active_tid
        if close_tid == active_tid and remaining_win_tabs:
            next_idx = min(close_idx, len(remaining_win_tabs) - 1)
            next_active = remaining_win_tabs[next_idx]
            next_active_tid = str(next_active["id"])
            with self._lock:
                self._bot_targets[bot_key] = next_active_tid
                nu = str(next_active.get("url") or "")
                if nu and not _is_blank_cdp_url(nu):
                    self._bot_last_urls[bot_key] = nu
                self._save_map()
        self.close_tab_fn(close_tid, port=self.cdp_port)
        updated_tabs = self.list_bot_window_targets(bot_key)
        deadline = time.time() + 0.6
        while any(str(t.get("id") or "") == close_tid for t in updated_tabs) and time.time() < deadline:
            time.sleep(0.04)
            updated_tabs = self.list_bot_window_targets(bot_key)
        updated_tabs = [t for t in updated_tabs if str(t.get("id") or "") != close_tid]
        return {
            "ok": True,
            "action": "close",
            "window_id": wid,
            "closed_target_id": close_tid,
            "active_target_id": next_active_tid,
            "tab_count": len(updated_tabs),
            "tabs": _format_tabs(updated_tabs, next_active_tid),
        }

    def release_bot_tab_in_flight(self, bot_key: str) -> None:
        if not bot_key:
            return
        with self._lock:
            cur = self._in_flight.get(bot_key, 0)
            if cur <= 1:
                self._in_flight.pop(bot_key, None)
            else:
                self._in_flight[bot_key] = cur - 1
            now_ts = time.time()
            self._last_tab_at[bot_key] = now_ts
            self._last_activity_at = now_ts
            self._slot_cond.notify_all()

    def record_bot_url(self, bot_key: str, url: str) -> None:
        u = str(url or "").strip()
        if not bot_key or not u or _is_blank_cdp_url(u):
            return
        with self._lock:
            self._last_activity_at = time.time()
            self._last_tab_at[bot_key] = self._last_activity_at
            if self._bot_last_urls.get(bot_key) != u:
                self._bot_last_urls[bot_key] = u
                self._save_map()

    def peek_bound_target_id(self, bot_id: str = None, is_admin: bool = False):
        bot_key = self._normalize_bot_key(bot_id, is_admin=is_admin)
        with self._lock:
            return self._bot_targets.get(bot_key)

    def focus_bot_tab_if_exists(self, bot_id: str = None, is_admin: bool = False) -> bool:
        bot_key = self._normalize_bot_key(bot_id, is_admin=is_admin)
        with self._lock:
            tid = self._bot_targets.get(bot_key)
            wid = self._bot_windows.get(bot_key)
            if tid:
                now_ts = time.time()
                self._last_tab_at[bot_key] = now_ts
                self._last_activity_at = now_ts
        if not tid:
            return False
        self.activate_tab_fn({"id": tid}, port=self.cdp_port)
        # Also bring the dedicated Chrome window to X11 foreground so multi-Bot screenshots/clicks
        # hit this Bot's window instead of whichever window happened to be on top.
        raise_fn = getattr(self, "raise_window_fn", None)
        if raise_fn is not None:
            try:
                raise_fn(tid, window_id=wid, port=self.cdp_port, display=self.display)
            except Exception:
                pass
        elif self.activate_tab_fn is activate_cdp_target:
            try:
                bring_cdp_target_to_front(
                    tid,
                    window_id=wid,
                    port=self.cdp_port,
                    display=self.display,
                )
            except Exception:
                pass
        return True

    def protected_target_ids(self) -> set:
        with self._lock:
            protected = set(self._bot_targets.values())
            owned_wids = set(self._bot_windows.values())
        if owned_wids and self.window_for_target_fn is not None:
            for t in self._live_page_targets():
                tid = str(t.get("id") or "")
                if tid and tid not in protected:
                    if self._get_target_window_id(tid) in owned_wids:
                        protected.add(tid)
        return protected

    def suspend_browser(self, reason: str = "idle", live_pages: list = None) -> dict:
        """
        Gracefully closes the shared Chrome browser when all Bots are idle (or on executor
        shutdown), preserving every Bot's last non-blank URL in `display-map.json` and keeping
        `/opt/twinklebot/chrome-profile` (cookies & logins) completely intact.
        """
        if live_pages is None:
            live_pages = self._live_page_targets()
        live_by_id = {str(t["id"]): t for t in live_pages}
        with self._lock:
            if reason != "shutdown" and any(v > 0 for v in self._in_flight.values()):
                return {"ok": False, "suspended": False, "reason": "in_flight"}
            saved_bots = []
            for bk, tid in list(self._bot_targets.items()):
                vt = live_by_id.get(tid or "")
                if vt and not _is_blank_cdp_url(vt.get("url", "")):
                    self._bot_last_urls[bk] = str(vt.get("url"))
                saved_bots.append(bk)
            self._bot_targets.clear()
            self._bot_windows.clear()
            self._save_map()
            self._slot_cond.notify_all()
        closed = False
        if self.close_browser_fn is not None:
            try:
                closed = bool(
                    self.close_browser_fn(
                        port=self.cdp_port,
                        profile_dir=self.primary_profile_dir,
                    )
                )
            except Exception:
                closed = False
        return {
            "ok": True,
            "suspended": True,
            "closed": closed,
            "reason": reason,
            "saved_bots": saved_bots,
        }

    def reclaim_idle_browsers(self, now: float = None) -> list:
        cur = now if now is not None else time.time()
        live_pages = self._live_page_targets()
        live_by_id = {str(t["id"]): t for t in live_pages}
        to_close = []
        with self._lock:
            for bk, last_ts in list(self._last_tab_at.items()):
                if self._bot_is_admin.get(bk, False):
                    continue
                if self._in_flight.get(bk, 0) > 0:
                    continue
                if (cur - last_ts) >= self.browser_idle_sec and bk in self._bot_targets:
                    tid = self._bot_targets.pop(bk, None)
                    wid = self._bot_windows.pop(bk, None)
                    vt = live_by_id.get(tid or "")
                    if vt and not _is_blank_cdp_url(vt.get("url", "")):
                        self._bot_last_urls[bk] = str(vt.get("url"))
                    if tid or wid is not None:
                        to_close.append((bk, wid, tid))
            protected_other = set(self._bot_targets.values())
            if to_close:
                self._save_map()
        remaining = len(live_pages)
        reclaimed_bots = []
        for bk, wid, tid in to_close:
            close_ids = self._collect_window_close_ids(wid, tid, live_pages, protected_other)
            for cid in close_ids:
                if remaining > 1:
                    self.close_tab_fn(cid, port=self.cdp_port)
                    remaining -= 1
                elif self.navigate_tab_fn is not None:
                    # Never leave a heavy SPA (e.g. YouTube Studio) spinning on SwiftShader as
                    # the sole surviving tab after idle eviction — reset it to `about:blank`.
                    vt = live_by_id.get(cid)
                    if not vt or not _is_blank_cdp_url(vt.get("url", "")):
                        try:
                            self.navigate_tab_fn(cid, "about:blank", port=self.cdp_port)
                        except Exception:
                            pass
            reclaimed_bots.append(bk)

        # Stage 2: Full-idle Chrome auto-suspend — when ALL Bots (including admin) are idle for
        # >= browser_suspend_sec and no human is actively viewing noVNC, gracefully close Chrome
        # (keeping profile/login state intact) so VM CPU & RAM drop back to ~0%.
        if self.browser_suspend_sec > 0 and self.close_browser_fn is not None:
            with self._lock:
                has_in_flight = any(v > 0 for v in self._in_flight.values())
                activity_points = [self._last_activity_at] + list(self._last_tab_at.values())
                latest_activity = max(activity_points) if activity_points else 0.0
                idle_elapsed = cur - latest_activity
            if not has_in_flight and idle_elapsed >= self.browser_suspend_sec:
                vnc_busy = False
                if self.vnc_active_fn is not None:
                    try:
                        vnc_busy = bool(self.vnc_active_fn())
                    except Exception:
                        vnc_busy = False
                if vnc_busy:
                    with self._lock:
                        self._last_activity_at = max(self._last_activity_at, cur)
                else:
                    browser_alive = bool(live_pages)
                    if not browser_alive:
                        try:
                            browser_alive = bool(self.cdp_ws_fn(port=self.cdp_port, timeout=0.8))
                        except Exception:
                            browser_alive = False
                    if browser_alive:
                        res = self.suspend_browser(reason="idle_timeout", live_pages=live_pages)
                        for sbk in res.get("saved_bots") or []:
                            if sbk not in reclaimed_bots:
                                reclaimed_bots.append(sbk)

        return reclaimed_bots

    def release_bot(self, bot_id: str, **_kwargs) -> dict:
        bid = str(bot_id or "").strip()
        if not bid:
            return {"ok": False, "error": "missing bot_id"}
        live_pages = self._live_page_targets()
        with self._lock:
            if self._bot_is_admin.get(bid, False):
                return {"ok": True, "released": False, "reason": "admin primary tab kept"}
            tid = self._bot_targets.pop(bid, None)
            wid = self._bot_windows.pop(bid, None)
            self._bot_last_urls.pop(bid, None)
            self._last_tab_at.pop(bid, None)
            protected_other = set(self._bot_targets.values())
            self._save_map()
            self._slot_cond.notify_all()
        if tid or wid is not None:
            close_ids = self._collect_window_close_ids(wid, tid, live_pages, protected_other)
            live_by_id = {str(t["id"]): t for t in live_pages}
            remaining = len(live_pages)
            closed_count = 0
            for cid in close_ids:
                if remaining > 1:
                    self.close_tab_fn(cid, port=self.cdp_port)
                    remaining -= 1
                    closed_count += 1
                elif self.navigate_tab_fn is not None:
                    vt = live_by_id.get(cid)
                    if not vt or not _is_blank_cdp_url(vt.get("url", "")):
                        try:
                            self.navigate_tab_fn(cid, "about:blank", port=self.cdp_port)
                        except Exception:
                            pass
            return {
                "ok": True,
                "released": True,
                "target_id": tid,
                "window_id": wid,
                "closed_tabs": closed_count,
            }
        return {"ok": True, "released": False}

    def list_displays(self) -> dict:
        live_pages = self._live_page_targets()
        live_by_id = {str(t["id"]): t for t in live_pages}
        by_win = self._map_targets_by_window(live_pages) if self.window_for_target_fn is not None else {}
        with self._lock:
            self._reconcile_live_targets_locked(live_pages, live_by_id, by_win)
            bindings = {
                bk: f"窗口 #{idx + 1}"
                for idx, (bk, _tid) in enumerate(sorted(self._bot_targets.items()))
            }
            tabs_info = []
            for bk, tid in sorted(self._bot_targets.items()):
                wid = self._bot_windows.get(bk)
                win_tabs = by_win.get(wid, []) if wid is not None else ([live_by_id[tid]] if tid in live_by_id else [])
                tabs_info.append(
                    {
                        "bot_id": bk,
                        "target_id": tid,
                        "window_id": wid,
                        "tab_count": len(win_tabs),
                        "url": str((live_by_id.get(tid) or {}).get("url") or self._bot_last_urls.get(bk, "")),
                        "title": str((live_by_id.get(tid) or {}).get("title") or ""),
                        "in_flight": self._in_flight.get(bk, 0),
                        "last_active_at": self._last_tab_at.get(bk),
                    }
                )
            max_screens = self.max_concurrent_screens
            budget = dict(self.budget)

        base_disp = display_resources(
            1,
            primary_profile_dir=self.primary_profile_dir,
            display=self.display,
            cdp_port=self.cdp_port,
        )
        return {
            "ok": True,
            "mode": "shared-profile-multi-tab",
            "window_isolation": "cdp-window",
            "max_concurrent_screens": max_screens,
            "budget": budget,
            "bindings": bindings,
            "tabs": tabs_info,
            "displays": [
                {
                    **base_disp,
                    "vnc_online": bool(self.tcp_open_fn(5901)),
                    "novnc_online": bool(self.tcp_open_fn(6080)),
                    "cdp_online": bool(self.cdp_ws_fn(port=self.cdp_port, timeout=0.8)),
                    "open_tabs": len(live_pages),
                }
            ],
        }


# Backward-compatible alias
DisplayManager = TabManager


_JS_FIND_REF_HELPER = r"""
function findGbRef(ref) {
  try {
    const topDirect = document.querySelector('[data-gb-ref="' + ref + '"]');
    if (topDirect) {
      return { el: topDirect, win: window, doc: document, root: document, offsetX: 0, offsetY: 0 };
    }
  } catch (e) {}
  function searchRoot(root, win, doc, offsetX, offsetY, depth) {
    if (!root || depth > 6) return null;
    try {
      const direct = root.querySelector('[data-gb-ref="' + ref + '"]');
      if (direct) {
        return { el: direct, win: win, doc: doc, root: root, offsetX: offsetX, offsetY: offsetY };
      }
    } catch (e) {}
    let all = [];
    try {
      all = root.querySelectorAll('*');
    } catch (e) {
      return null;
    }
    for (let i = 0; i < all.length; i++) {
      const node = all[i];
      if (node.shadowRoot) {
        const hit = searchRoot(node.shadowRoot, win, doc, offsetX, offsetY, depth + 1);
        if (hit) return hit;
      }
      if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
        try {
          const idoc = node.contentDocument;
          const iwin = node.contentWindow;
          if (idoc && iwin) {
            const fr = node.getBoundingClientRect();
            const hit = searchRoot(
              idoc,
              iwin,
              idoc,
              offsetX + (fr ? fr.left : 0),
              offsetY + (fr ? fr.top : 0),
              depth + 1
            );
            if (hit) return hit;
          }
        } catch (e) {}
      }
    }
    return null;
  }
  return searchRoot(document, window, document, 0, 0, 0);
}
"""

_JS_SNAPSHOT_HELPER = _JS_FIND_REF_HELPER + r"""
function collectGbSnapshot(maxElements, maxText) {
  maxElements = maxElements || 80;
  maxText = maxText || 3000;
  const selector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="treeitem"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]'
  ].join(',');

  const vw = window.innerWidth || 1440;
  const vh = window.innerHeight || 900;
  const docEl = document.documentElement;
  const docBody = document.body;
  const scrollH = Math.max(
    (docEl && docEl.scrollHeight) || 0,
    (docBody && docBody.scrollHeight) || 0,
    vh
  );

  const seen = new WeakSet();
  const inViewportCandidates = [];
  const offscreenCandidates = [];
  const iframes = [];
  const shadowTextParts = [];
  let shadowDomDetected = false;
  let hiddenFileCount = 0;
  const MAX_SCAN = Math.max(maxElements * 5, 400);
  const STRUCTURAL_TAGS = { div: 1, section: 1, main: 1, article: 1, body: 1, html: 1, aside: 1, nav: 1, header: 1, footer: 1 };

  function extractShadowText(sr) {
    if (!sr || shadowTextParts.length >= 60) return;
    try {
      const walker = document.createTreeWalker(sr, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const p = n.parentElement;
        if (p) {
          const pt = (p.tagName || '').toUpperCase();
          if (pt === 'STYLE' || pt === 'SCRIPT' || pt === 'NOSCRIPT' || pt === 'TEMPLATE') continue;
        }
        const s = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (s.length >= 2) {
          shadowTextParts.push(s);
          if (shadowTextParts.length >= 60) break;
        }
      }
    } catch (e) {}
  }

  function scanRoot(root, win, offsetX, offsetY, depth) {
    if (!root || depth > 6) return;
    if (inViewportCandidates.length + offscreenCandidates.length >= MAX_SCAN) return;

    try {
      const stale = root.querySelectorAll('[data-gb-ref]');
      for (let i = 0; i < stale.length; i++) {
        stale[i].removeAttribute('data-gb-ref');
      }
    } catch (e) {}

    let matched = [];
    try {
      matched = Array.from(root.querySelectorAll(selector));
    } catch (e) {
      matched = [];
    }

    for (const el of matched) {
      if (inViewportCandidates.length + offscreenCandidates.length >= MAX_SCAN) break;
      if (seen.has(el)) continue;
      seen.add(el);

      const tag = (el.tagName || '').toLowerCase();
      const inpType = tag === 'input' ? (el.getAttribute('type') || '').toLowerCase() : '';
      const isFileInput = tag === 'input' && inpType === 'file';
      let style = null;
      try {
        style = win.getComputedStyle(el);
      } catch (e) {}
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const visuallyHidden =
        !style ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        parseFloat(style.opacity || '1') === 0 ||
        !r ||
        r.width < 3 ||
        r.height < 3;

      if (visuallyHidden) {
        if (isFileInput && hiddenFileCount < 10) {
          hiddenFileCount += 1;
          inViewportCandidates.push({
            el: el,
            tag: tag,
            inpType: inpType,
            r: r || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 },
            offsetX: offsetX,
            offsetY: offsetY,
            inViewport: false,
            hiddenFileInput: true,
          });
        }
        continue;
      }

      // Skip huge structural containers that only matched via tabindex="0"
      if (
        STRUCTURAL_TAGS[tag] &&
        !el.getAttribute('role') &&
        !el.hasAttribute('onclick') &&
        !el.isContentEditable &&
        r.width * r.height > vw * vh * 0.35
      ) {
        continue;
      }

      const absLeft = r.left + offsetX;
      const absTop = r.top + offsetY;
      const absRight = r.right + offsetX;
      const absBottom = r.bottom + offsetY;
      const inVp = absBottom > 0 && absTop < vh && absRight > 0 && absLeft < vw;

      const entry = {
        el: el,
        tag: tag,
        inpType: inpType,
        r: r,
        offsetX: offsetX,
        offsetY: offsetY,
        inViewport: inVp,
        hiddenFileInput: false,
      };
      if (inVp) {
        inViewportCandidates.push(entry);
      } else {
        offscreenCandidates.push(entry);
      }
    }

    // Walk nested Shadow DOM hosts and iframes
    let allNodes = [];
    try {
      allNodes = root.querySelectorAll('*');
    } catch (e) {
      allNodes = [];
    }
    for (let i = 0; i < allNodes.length; i++) {
      const node = allNodes[i];
      if (node.shadowRoot) {
        shadowDomDetected = true;
        extractShadowText(node.shadowRoot);
        scanRoot(node.shadowRoot, win, offsetX, offsetY, depth + 1);
      }
      if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
        let fr = null;
        try {
          fr = node.getBoundingClientRect();
        } catch (e) {}
        const visibleFrame = fr && fr.width >= 10 && fr.height >= 10;
        let sameOriginDoc = null;
        let sameOriginWin = null;
        try {
          sameOriginDoc = node.contentDocument;
          sameOriginWin = node.contentWindow;
        } catch (e) {
          sameOriginDoc = null;
          sameOriginWin = null;
        }
        if (visibleFrame && iframes.length < 20) {
          const fInfo = {
            src: String(node.getAttribute('src') || node.src || '').slice(0, 160),
            cross_origin: !sameOriginDoc,
            rect: {
              x: Math.round(fr.left + offsetX + fr.width / 2),
              y: Math.round(fr.top + offsetY + fr.height / 2),
              w: Math.round(fr.width),
              h: Math.round(fr.height),
            },
          };
          const fTitle = String(node.getAttribute('title') || node.getAttribute('name') || '').trim();
          if (fTitle) fInfo.title = fTitle.slice(0, 80);
          iframes.push(fInfo);
        }
        if (sameOriginDoc && sameOriginWin && fr) {
          scanRoot(sameOriginDoc, sameOriginWin, offsetX + fr.left, offsetY + fr.top, depth + 1);
        }
      }
    }
  }

  scanRoot(document, window, 0, 0, 0);

  const chosen = inViewportCandidates.concat(offscreenCandidates).slice(0, maxElements);
  const elements = [];
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    const el = c.el;
    const ref = 'e' + (i + 1);
    try {
      el.setAttribute('data-gb-ref', ref);
    } catch (e) {}

    const tag = c.tag;
    const role = el.getAttribute('role') || c.inpType || tag;
    const rawName = (
      el.innerText ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.getAttribute('name') ||
      el.value ||
      ''
    ).replace(/\s+/g, ' ').trim().slice(0, 80);

    const item = {
      ref: ref,
      tag: tag,
      role: role,
      name: rawName,
      rect: {
        x: Math.round(c.r.left + c.offsetX + c.r.width / 2),
        y: Math.round(c.r.top + c.offsetY + c.r.height / 2),
        w: Math.round(c.r.width),
        h: Math.round(c.r.height),
      },
      in_viewport: Boolean(c.inViewport),
    };

    if (c.hiddenFileInput) {
      item.hidden_file_input = true;
      const acc = el.getAttribute('accept');
      if (acc) item.accept = String(acc).slice(0, 80);
      if (el.multiple) item.multiple = true;
    } else if (tag === 'input' && c.inpType === 'file') {
      const acc = el.getAttribute('accept');
      if (acc) item.accept = String(acc).slice(0, 80);
      if (el.multiple) item.multiple = true;
    }

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      item.value = c.inpType === 'password' ? (el.value ? '***' : '') : String(el.value || '').slice(0, 80);
      const ph = el.getAttribute('placeholder');
      if (ph) item.placeholder = String(ph).slice(0, 60);
    }
    if (tag === 'select' && el.options) {
      const opts = [];
      const limit = Math.min(el.options.length, 15);
      for (let oi = 0; oi < limit; oi++) {
        const o = el.options[oi];
        opts.push({
          value: String(o.value || '').slice(0, 60),
          label: String(o.text || '').trim().slice(0, 60),
          selected: Boolean(o.selected),
        });
      }
      item.options = opts;
    }
    if (
      (tag === 'input' && (c.inpType === 'checkbox' || c.inpType === 'radio')) ||
      role === 'checkbox' ||
      role === 'switch' ||
      role === 'radio'
    ) {
      const checkedAttr = el.getAttribute('aria-checked');
      item.checked = typeof el.checked === 'boolean' ? Boolean(el.checked) : checkedAttr === 'true';
    }
    if (tag === 'a' && el.href) {
      item.href = String(el.href).slice(0, 120);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      item.disabled = true;
    }
    elements.push(item);
  }

  let rawText = (docBody && docBody.innerText ? docBody.innerText : '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (shadowDomDetected && rawText.length < 300 && shadowTextParts.length > 0) {
    const extra = shadowTextParts.join(' ').replace(/\s+/g, ' ').trim();
    rawText = rawText ? (rawText + '\n' + extra) : extra;
  }

  let focused = null;
  try {
    let ae = document.activeElement;
    let guard = 0;
    while (ae && guard < 8) {
      guard += 1;
      if (ae.shadowRoot && ae.shadowRoot.activeElement) {
        ae = ae.shadowRoot.activeElement;
        continue;
      }
      if (ae.tagName === 'IFRAME' || ae.tagName === 'FRAME') {
        try {
          if (ae.contentDocument && ae.contentDocument.activeElement) {
            ae = ae.contentDocument.activeElement;
            continue;
          }
        } catch (e) {}
      }
      break;
    }
    if (ae && ae !== docBody && ae !== docEl) {
      const ftag = (ae.tagName || '').toLowerCase();
      focused = {
        ref: ae.getAttribute ? (ae.getAttribute('data-gb-ref') || null) : null,
        tag: ftag,
        role: (ae.getAttribute && ae.getAttribute('role')) || ftag,
        name: String(
          (ae.getAttribute && (ae.getAttribute('aria-label') || ae.getAttribute('placeholder') || ae.getAttribute('name'))) ||
          ae.innerText ||
          ''
        ).replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    }
  } catch (e) {}

  let challengeDetected = null;
  try {
    const tLow = String(document.title || '').toLowerCase();
    const uLow = String(location.href || '').toLowerCase();
    const bLow = rawText.slice(0, 1200).toLowerCase();
    if (
      tLow.includes('just a moment') ||
      tLow.includes('attention required') ||
      uLow.includes('__cf_chl_') ||
      Boolean(document.querySelector('#challenge-running, #cf-challenge-running, #challenge-stage, .cf-turnstile'))
    ) {
      challengeDetected = { type: 'cloudflare', reason: 'Cloudflare human verification / challenge page detected' };
    } else {
      for (const f of iframes) {
        const fsrc = String(f.src || '').toLowerCase();
        if (fsrc.includes('challenges.cloudflare.com')) {
          challengeDetected = { type: 'turnstile', reason: 'Cloudflare Turnstile challenge detected' };
          break;
        }
        if (fsrc.includes('google.com/recaptcha') || fsrc.includes('recaptcha.net')) {
          challengeDetected = { type: 'recaptcha', reason: 'Google reCAPTCHA challenge detected' };
          break;
        }
        if (fsrc.includes('hcaptcha.com')) {
          challengeDetected = { type: 'hcaptcha', reason: 'hCaptcha challenge detected' };
          break;
        }
      }
      if (!challengeDetected && Boolean(document.querySelector('.g-recaptcha, #recaptcha, .h-captcha'))) {
        challengeDetected = { type: 'captcha', reason: 'CAPTCHA challenge widget detected' };
      } else if (
        !challengeDetected &&
        bLow.length < 1000 &&
        (bLow.includes('verify you are human') ||
          bLow.includes('checking your browser') ||
          bLow.includes('enable javascript and cookies to continue'))
      ) {
        challengeDetected = { type: 'bot_challenge', reason: 'Anti-bot human verification page detected' };
      }
    }
  } catch (e) {}

  const out = {
    ok: true,
    url: String(location.href || ''),
    title: String(document.title || ''),
    scroll: {
      y: Math.round(window.scrollY || 0),
      max_y: Math.max(0, Math.round(scrollH - vh)),
      viewport_h: vh,
    },
    element_count: elements.length,
    elements: elements,
    text_excerpt: rawText.slice(0, maxText),
  };
  if (iframes.length > 0) out.iframes = iframes;
  if (focused) out.focused = focused;
  if (challengeDetected) out.challenge_detected = challengeDetected;
  if (shadowDomDetected) out.shadow_dom_detected = true;
  return out;
}
"""


def resolve_default_browser(explicit=None) -> str:
    if explicit:
        return explicit
    env_browser = os.environ.get("TWINKLEBOT_BROWSER", "").strip()
    if env_browser and env_browser != "/usr/bin/firefox":
        if env_browser == "/usr/local/bin/chromium" and os.path.exists(DEFAULT_BROWSER):
            return DEFAULT_BROWSER
        return env_browser
    return DEFAULT_BROWSER


SAFE_LOCAL_PREVIEW_EXTS = {
    ".html",
    ".htm",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".pdf",
    ".txt",
    ".md",
}


class Actions:
    BUTTON_MAP = {
        "left": "1",
        "middle": "2",
        "right": "3",
    }

    SCROLL_MAP = {
        "up": "4",
        "down": "5",
        "left": "6",
        "right": "7",
    }

    def __init__(
        self,
        run=None,
        browser=None,
        spawn=None,
        cdp_eval=None,
        cdp_session=None,
        display: str = ":1",
        cdp_port: int = DEFAULT_CDP_PORT,
        profile_dir: str = None,
        target_id: str = None,
        target_ws_url: str = None,
        window_id: int = None,
        targets_fn=None,
        protected_targets_fn=None,
        list_window_targets_fn=None,
        on_target_switch_fn=None,
        cwd: str = None,
        bot_workspace: str = None,
    ):
        self.display = str(display or ":1")
        self.cdp_port = int(cdp_port or DEFAULT_CDP_PORT)
        self.profile_dir = profile_dir
        self.cwd = str(cwd or "").strip() or None
        self.bot_workspace = str(bot_workspace or "").strip() or self.cwd
        self.target_id = str(target_id or "").strip() or None
        self.target_ws_url = str(target_ws_url or "").strip() or None
        self.window_id = window_id
        self.targets_fn = targets_fn or fetch_cdp_targets
        self.protected_targets_fn = protected_targets_fn
        self.list_window_targets_fn = list_window_targets_fn
        self.on_target_switch_fn = on_target_switch_fn
        self._custom_run = run
        self._custom_spawn = spawn
        self._custom_cdp_eval = cdp_eval
        self._custom_cdp_session = cdp_session
        self.run = run or (
            lambda argv, input=None, timeout=None: default_run(
                argv,
                input=input,
                timeout=timeout,
                display=self.display,
                cdp_port=self.cdp_port,
                profile_dir=self.profile_dir,
                cwd=self.cwd,
            )
        )
        self.browser = resolve_default_browser(browser)
        self.spawn = spawn or (
            lambda argv, start_new_session=True: default_spawn(
                argv,
                start_new_session=start_new_session,
                display=self.display,
                cdp_port=self.cdp_port,
                profile_dir=self.profile_dir,
            )
        )
        self.cdp_eval = cdp_eval or default_cdp_eval
        if cdp_session is not None:
            self.cdp_session = cdp_session
        elif self.target_id:
            self.cdp_session = self._target_cdp_session
        else:
            self.cdp_session = lambda callback, port=None, timeout=12.0: default_cdp_session(
                callback, port=(port or self.cdp_port), timeout=timeout
            )

    def _resolve_target_ws_url(self, eff_port: int, timeout: float = 3.0) -> str:
        ws_url = ""
        try:
            targets = self.targets_fn(port=eff_port, timeout=min(timeout, 3.0))
            if isinstance(targets, list):
                for t in targets:
                    if isinstance(t, dict) and str(t.get("id") or "") == self.target_id:
                        ws_url = str(t.get("webSocketDebuggerUrl") or "")
                        break
        except Exception:
            pass
        if not ws_url:
            ws_url = self.target_ws_url or f"ws://127.0.0.1:{eff_port}/devtools/page/{self.target_id}"
        return ws_url

    def _target_cdp_session(self, callback, port=None, timeout=12.0):
        eff_port = port or self.cdp_port

        def _with_focus_emulation(call):
            try:
                call("Emulation.setFocusEmulationEnabled", {"enabled": True})
            except Exception:
                pass
            return callback(call)

        ws_url = self._resolve_target_ws_url(eff_port, timeout=timeout)
        try:
            return cdp_ws_session(ws_url, _with_focus_emulation, timeout=timeout)
        except (ConnectionError, TimeoutError, OSError):
            # Retry once on transient WebSocket handshake/connection failures by refreshing the target URL
            time.sleep(0.15)
            fresh_ws = self._resolve_target_ws_url(eff_port, timeout=timeout)
            self.target_ws_url = fresh_ws
            return cdp_ws_session(fresh_ws, _with_focus_emulation, timeout=timeout)

    def screenshot(self):
        proc = self.run(["import", "-window", "root", "png:-"])
        raw = proc.stdout if isinstance(proc.stdout, bytes) else str(proc.stdout).encode()
        png_b64 = base64.b64encode(raw).decode("ascii")
        return {"png_base64": png_b64, "width": 1440, "height": 900}

    def click(self, x, y, button="left", double=False):
        validate_point(x, y)
        if button not in self.BUTTON_MAP:
            raise ValueError(f"invalid button: {button}")

        btn_code = self.BUTTON_MAP[button]
        if double:
            cmd = ["xdotool", "mousemove", str(x), str(y), "click", "--repeat", "2", btn_code]
        else:
            cmd = ["xdotool", "mousemove", str(x), str(y), "click", btn_code]

        self.run(cmd)
        return {"ok": True}

    def type_text(self, text, sensitive=False, press_enter=False):
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        if not isinstance(press_enter, bool):
            raise ValueError("press_enter must be a boolean")

        # Pure single-line printable ASCII (non-sensitive, <= 120 chars) uses direct xdotool keystrokes
        # so custom inputs that intercept or ignore clipboard paste (e.g. tag chips, comboboxes)
        # receive real keyboard events instead of silently dropping Ctrl+V.
        is_direct_ascii = (
            not sensitive
            and 0 < len(text) <= 120
            and all(32 <= ord(ch) <= 126 for ch in text)
        )
        if is_direct_ascii:
            self.run(["xdotool", "type", "--clearmodifiers", "--delay", "12", "--", text])
        else:
            self.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"))
            # Brief settle so X11 clipboard selection ownership is registered before Ctrl+V
            time.sleep(0.05)
            try:
                self.run(["xdotool", "key", "--clearmodifiers", "ctrl+v"])
            finally:
                if sensitive:
                    # Give target app a brief moment to read the clipboard on paste, then wipe X11 clipboard
                    time.sleep(0.08)
                    try:
                        self.run(["xclip", "-selection", "clipboard"], input=b"")
                    except Exception:
                        pass
        if press_enter:
            self.run(["xdotool", "key", "--clearmodifiers", "Return"])
        return {"ok": True}

    def key(self, combo):
        if not isinstance(combo, str) or not combo.strip():
            raise ValueError("combo must be a non-empty string")
        self.run(["xdotool", "key", "--clearmodifiers", combo])
        return {"ok": True}

    def scroll(self, x, y, direction, amount=3):
        validate_point(x, y)
        if direction not in self.SCROLL_MAP:
            raise ValueError(f"invalid direction: {direction}")
        if type(amount) is not int or isinstance(amount, bool) or not (1 <= amount <= 20):
            raise ValueError(f"amount must be an integer between 1 and 20, got {amount}")

        cmd = ["xdotool", "mousemove", str(x), str(y), "click", "--repeat", str(amount), self.SCROLL_MAP[direction]]
        self.run(cmd)
        return {"ok": True}

    def drag(self, x1, y1, x2, y2):
        validate_coord(x1, 1440, "x1")
        validate_coord(y1, 900, "y1")
        validate_coord(x2, 1440, "x2")
        validate_coord(y2, 900, "y2")

        cmd = [
            "xdotool",
            "mousemove",
            str(x1),
            str(y1),
            "mousedown",
            "1",
            "mousemove",
            str(x2),
            str(y2),
            "mouseup",
            "1",
        ]
        self.run(cmd)
        return {"ok": True}

    def list_windows(self):
        proc = self.run(["wmctrl", "-l"])
        out = proc.stdout.decode("utf-8", errors="replace") if isinstance(proc.stdout, bytes) else str(proc.stdout)
        windows = []
        for line in out.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 3)
            win_id = parts[0]
            win_title = parts[3] if len(parts) >= 4 else ""
            windows.append({"id": win_id, "title": win_title})
        return {"windows": windows}

    def focus_window(self, win_id):
        if not win_id:
            raise ValueError("window id is required")
        self.run(["wmctrl", "-i", "-a", str(win_id)])
        return {"ok": True}

    def shell(self, command, timeout=120):
        if not isinstance(command, str):
            raise TypeError("command must be a string")
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError("timeout must be a positive number")

        try:
            proc = self.run(["bash", "-lc", command], timeout=timeout)
            stdout = (
                proc.stdout.decode("utf-8", errors="replace")
                if isinstance(proc.stdout, bytes)
                else str(proc.stdout or "")
            )
            stderr = (
                proc.stderr.decode("utf-8", errors="replace")
                if isinstance(proc.stderr, bytes)
                else str(proc.stderr or "")
            )
            returncode = proc.returncode
        except subprocess.TimeoutExpired as e:
            stdout = e.stdout or ""
            if isinstance(stdout, bytes):
                stdout = stdout.decode("utf-8", errors="replace")
            else:
                stdout = str(stdout)
            stderr = f"timed out after {timeout}s"
            returncode = 124

        truncated = (len(stdout) > MAX_SHELL_OUTPUT) or (len(stderr) > MAX_SHELL_OUTPUT)
        return {
            "exit_code": returncode,
            "stdout": stdout[:MAX_SHELL_OUTPUT],
            "stderr": stderr[:MAX_SHELL_OUTPUT],
            "truncated": truncated,
        }

    def read_file(self, path, start_line=None, end_line=None):
        check_read_path_allowed(path)
        for fname, fval in (("start_line", start_line), ("end_line", end_line)):
            if fval is not None:
                if type(fval) is not int or isinstance(fval, bool) or fval < 1:
                    raise ValueError(f"{fname} must be a positive 1-based integer")
        if start_line is not None and end_line is not None and end_line < start_line:
            raise ValueError("end_line must be >= start_line")

        with open(path, "r", encoding="utf-8", errors="replace") as f:
            if start_line is not None or end_line is not None:
                all_lines = f.read().splitlines()
                total_lines = len(all_lines)
                eff_start = min(start_line or 1, max(total_lines, 1))
                eff_end = min(end_line or min(eff_start + 399, total_lines), total_lines)
                sliced = [] if total_lines == 0 else all_lines[eff_start - 1 : eff_end]
                numbered = "\n".join(f"{eff_start + i}: {line}" for i, line in enumerate(sliced))
                truncated = len(numbered) > MAX_FILE_CHARS
                return {
                    "content": numbered[:MAX_FILE_CHARS],
                    "truncated": truncated,
                    "startLine": eff_start,
                    "endLine": 0 if total_lines == 0 else eff_end,
                    "totalLines": total_lines,
                    "hasMore": eff_end < total_lines,
                }

            content = f.read(MAX_FILE_CHARS + 1)

        truncated = len(content) > MAX_FILE_CHARS
        return {
            "content": content[:MAX_FILE_CHARS],
            "truncated": truncated,
        }

    def write_file(self, path, content):
        check_read_path_allowed(path)
        if not isinstance(content, str):
            raise TypeError("content must be a string")

        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return {"bytes": len(content.encode("utf-8"))}

    def edit_file(self, path, target=None, replacement="", append=False, replace_all=False):
        check_read_path_allowed(path)
        if replacement is None:
            replacement = ""
        if not isinstance(replacement, str):
            raise TypeError("replacement must be a string")

        if append:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(replacement)
            return {
                "ok": True,
                "path": path,
                "mode": "append",
                "bytes": len(replacement.encode("utf-8")),
            }

        if not isinstance(target, str) or not target:
            raise ValueError("target must be a non-empty string unless append=True")
        with open(path, "r", encoding="utf-8") as f:
            existing = f.read()
        occurrences = existing.count(target)
        if occurrences == 0:
            raise ValueError("target not found in file")
        if occurrences > 1 and not replace_all:
            raise ValueError(
                f"target matched {occurrences} times; provide more context or set replace_all=True"
            )
        updated = existing.replace(target, replacement) if replace_all else existing.replace(target, replacement, 1)
        with open(path, "w", encoding="utf-8") as f:
            f.write(updated)
        return {
            "ok": True,
            "path": path,
            "mode": "replace",
            "replacements": occurrences if replace_all else 1,
            "bytes": len(updated.encode("utf-8")),
        }

    def _validate_browser_url(self, url, allow_local_file: bool = False):
        if not isinstance(url, str):
            raise TypeError("url must be a string")
        parsed = urllib.parse.urlparse(url.strip())
        if parsed.scheme in ("http", "https"):
            return url
        if parsed.scheme == "file" and allow_local_file:
            ws_root = str(self.bot_workspace or self.cwd or "").strip()
            if not ws_root:
                raise ValueError("file:// preview requires an active Bot workspace")
            local_path = urllib.parse.unquote(parsed.path or "")
            if not local_path or not os.path.isabs(local_path):
                raise ValueError("invalid file:// url path")
            check_read_path_allowed(local_path)
            real_target = os.path.realpath(local_path)
            real_root = os.path.realpath(ws_root)
            if not (real_target == real_root or real_target.startswith(real_root + os.sep)):
                raise PermissionError(f"access to {local_path} is denied outside Bot workspace")
            ext = os.path.splitext(real_target)[1].lower()
            if ext not in SAFE_LOCAL_PREVIEW_EXTS:
                raise ValueError(f"unsupported local file:// preview extension: {ext or 'none'}")
            return url
        raise ValueError(f"invalid scheme: {parsed.scheme}")

    def open_url(self, url):
        validated = self._validate_browser_url(url, allow_local_file=True)

        if self.target_id and self._custom_cdp_eval is None:
            self.cdp_session(lambda call: call("Page.navigate", {"url": validated}))
            return {"ok": True, "target_id": self.target_id}

        self.spawn([self.browser, validated], start_new_session=True)
        return {"ok": True}

    def _dispatch_mouse_click(self, call, x: float, y: float):
        cx = int(round(x))
        cy = int(round(y))
        call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cx, "y": cy})
        call(
            "Input.dispatchMouseEvent",
            {"type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1},
        )
        call(
            "Input.dispatchMouseEvent",
            {"type": "mouseReleased", "x": cx, "y": cy, "button": "left", "clickCount": 1},
        )

    def _dispatch_key_press(self, call, key: str, code: str, vk: int, text: str = None):
        call(
            "Input.dispatchKeyEvent",
            {
                "type": "rawKeyDown",
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk,
            },
        )
        if text:
            call(
                "Input.dispatchKeyEvent",
                {
                    "type": "char",
                    "key": key,
                    "code": code,
                    "text": text,
                    "unmodifiedText": text,
                    "windowsVirtualKeyCode": vk,
                    "nativeVirtualKeyCode": vk,
                },
            )
        call(
            "Input.dispatchKeyEvent",
            {
                "type": "keyUp",
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk,
            },
        )

    def _has_active_cdp_page(self) -> bool:
        try:
            targets = fetch_cdp_targets(port=self.cdp_port, timeout=2.5)
            return select_cdp_page_target(targets) is not None
        except Exception:
            return False

    def _wait_for_page_settle(
        self,
        max_polls: int = 28,
        poll_sec: float = 0.25,
        require_content: bool = True,
    ):
        """
        Wait until the active tab reaches `readyState === 'complete'` and (for SPAs)
        either has visible body content or finishes a brief post-complete hydration grace period.
        Tolerates transient 'Execution context was destroyed' errors during mid-flight navigations
        and stays backward-compatible with mocks returning plain readyState strings.
        """
        probe_expr = (
            "(function() { "
            "const cur = String(location.href || ''); "
            "if (cur === 'about:blank') return { state: 'navigating', url: cur, has_content: false }; "
            "const rs = String(document.readyState || 'loading'); "
            "const body = document.body; "
            "const textLen = body && body.innerText ? body.innerText.trim().length : 0; "
            "const childCount = body ? body.children.length : 0; "
            "return { state: rs, url: cur, has_content: (textLen >= 20 || childCount >= 3) }; "
            "})()"
        )
        complete_empty_polls = 0
        interactive_polls = 0
        for _ in range(max_polls):
            try:
                val = self.cdp_session(lambda call: _eval_on_session(call, probe_expr))
                if isinstance(val, str):
                    if val == "complete":
                        return
                    if val == "interactive":
                        interactive_polls += 1
                        if interactive_polls >= 4:
                            return
                elif isinstance(val, dict):
                    st = val.get("state")
                    has_content = bool(val.get("has_content"))
                    if st == "complete":
                        if not require_content or has_content:
                            return
                        complete_empty_polls += 1
                        if complete_empty_polls >= 6:
                            return
                    elif st == "interactive":
                        interactive_polls += 1
                        if interactive_polls >= 12 and (not require_content or has_content):
                            return
            except Exception:
                pass
            time.sleep(poll_sec)

    def _wait_for_active_tab_ready(self, max_polls: int = 18, poll_sec: float = 0.2):
        self._wait_for_page_settle(max_polls=max_polls, poll_sec=poll_sec, require_content=True)

    def _attach_snapshot_meta(self, snap: dict):
        if self.list_window_targets_fn is not None:
            try:
                wtabs = self.list_window_targets_fn()
                if isinstance(wtabs, list) and wtabs:
                    snap["tab_count"] = len(wtabs)
            except Exception:
                pass
        if self.target_id:
            snap.setdefault("target_id", self.target_id)
        return snap

    def browser_snapshot(self, url=None, max_elements=80, max_text=3000, wait_ms=0):
        if url is not None:
            validated_url = self._validate_browser_url(url, allow_local_file=True)
            if self.cdp_eval is default_cdp_eval:
                # Navigate this Bot's dedicated CDP tab (or active page when standalone) instead of spawning rogue tabs.
                if self.target_id or self._has_active_cdp_page():
                    self.cdp_session(lambda call: call("Page.navigate", {"url": validated_url}))
                else:
                    self.open_url(validated_url)
                self._wait_for_page_settle(max_polls=32, poll_sec=0.25, require_content=True)
                if not self.target_id:
                    close_redundant_blank_tabs(port=self.cdp_port)
                elif self.protected_targets_fn is not None:
                    close_redundant_blank_tabs(
                        port=self.cdp_port,
                        protected_ids=self.protected_targets_fn(),
                    )
            else:
                self.open_url(validated_url)

        if type(max_elements) is not int or isinstance(max_elements, bool) or not (1 <= max_elements <= 200):
            raise ValueError("max_elements must be an integer between 1 and 200")
        if type(max_text) is not int or isinstance(max_text, bool) or not (100 <= max_text <= 20000):
            raise ValueError("max_text must be an integer between 100 and 20000")
        if wait_ms is None:
            wait_ms = 0
        if type(wait_ms) is not int or isinstance(wait_ms, bool) or not (0 <= wait_ms <= 5000):
            raise ValueError("wait_ms must be an integer between 0 and 5000")
        if wait_ms > 0:
            time.sleep(wait_ms / 1000.0)

        expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot({max_elements}, {max_text});
}})()"""

        def _eval_snap():
            if self.cdp_eval is default_cdp_eval:
                call_kw = {"timeout": 15.0} if self._custom_cdp_session is None else {}
                try:
                    return self.cdp_session(
                        lambda call: _eval_on_session(call, expr), **call_kw
                    )
                except Exception as exc:
                    msg = str(exc)
                    if "Execution context" in msg or "Cannot find context" in msg or "scrollHeight" in msg:
                        self._wait_for_page_settle(max_polls=16, poll_sec=0.2, require_content=True)
                        return self.cdp_session(
                            lambda call: _eval_on_session(call, expr), **call_kw
                        )
                    raise
            return self.cdp_eval(expr)

        try:
            res = _eval_snap()
        except (TimeoutError, socket.timeout, RuntimeError) as exc:
            msg = str(exc).lower()
            if "timed out" in msg or "timeout" in msg or isinstance(exc, (TimeoutError, socket.timeout)):
                return self._attach_snapshot_meta(
                    {
                        "ok": True,
                        "degraded": True,
                        "timeout_truncated": True,
                        "error": str(exc),
                        "element_count": 0,
                        "elements": [],
                        "text_excerpt": "",
                    }
                )
            raise

        if not isinstance(res, dict):
            raise RuntimeError("Failed to collect browser snapshot")

        # Brief SPA hydration retry when initial snapshot sees zero interactive elements and near-empty body
        if int(res.get("element_count") or 0) == 0 and len(str(res.get("text_excerpt") or "").strip()) < 20:
            time.sleep(0.8)
            try:
                retry_res = _eval_snap()
                if isinstance(retry_res, dict):
                    res = retry_res
            except Exception:
                pass

        return self._attach_snapshot_meta(res)

    def browser_click(self, ref):
        norm_ref = normalize_element_ref(ref)
        if self.cdp_eval is default_cdp_eval:
            before_window_tids = set()
            if self.list_window_targets_fn is not None:
                try:
                    before_window_tids = {
                        str(t.get("id") or "")
                        for t in (self.list_window_targets_fn() or [])
                        if isinstance(t, dict) and t.get("id")
                    }
                except Exception:
                    before_window_tids = set()

            clicked_holder = {}
            new_tab_holder = {}

            def run_click(call):
                locate_expr = f"""(function() {{
{_JS_FIND_REF_HELPER}
const ref = {json.dumps(norm_ref)};
const hit = findGbRef(ref);
if (!hit || !hit.el) {{
  return {{
    ok: false,
    url: String(location.href || ''),
    title: String(document.title || ''),
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
const el = hit.el;
const beforeUrl = String(location.href || '');
el.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'instant' }});
let r = el.getBoundingClientRect();
const tag = (el.tagName || '').toLowerCase();
const name = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
let visible = Boolean(r && r.width >= 1 && r.height >= 1);
let localX = visible ? (r.left + r.width / 2) : 0;
let localY = visible ? (r.top + r.height / 2) : 0;
let x = visible ? (localX + hit.offsetX) : 0;
let y = visible ? (localY + hit.offsetY) : 0;
let fallbackJsClick = false;
let occludedBy = '';

function checkHit(lx, ly) {{
  try {{
    const pointRoot = (hit.root && typeof hit.root.elementFromPoint === 'function') ? hit.root : hit.doc;
    if (!pointRoot || typeof pointRoot.elementFromPoint !== 'function') return {{ ok: true }};
    const topEl = pointRoot.elementFromPoint(lx, ly);
    if (!topEl) return {{ ok: true }};
    if (topEl === el || el.contains(topEl) || (topEl.contains && topEl.contains(el))) {{
      return {{ ok: true }};
    }}
    const desc = ((topEl.tagName || '').toLowerCase() + (topEl.id ? '#' + topEl.id : '') + (typeof topEl.className === 'string' && topEl.className ? '.' + topEl.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')).slice(0, 60);
    return {{ ok: false, by: desc }};
  }} catch (e) {{
    return {{ ok: true }};
  }}
}}

if (visible) {{
  let occ = checkHit(localX, localY);
  if (!occ.ok) {{
    try {{ el.scrollIntoView({{ block: 'nearest', inline: 'nearest', behavior: 'instant' }}); }} catch (e) {{}}
    r = el.getBoundingClientRect();
    visible = Boolean(r && r.width >= 1 && r.height >= 1);
    localX = visible ? (r.left + r.width / 2) : 0;
    localY = visible ? (r.top + r.height / 2) : 0;
    x = visible ? (localX + hit.offsetX) : 0;
    y = visible ? (localY + hit.offsetY) : 0;
    occ = visible ? checkHit(localX, localY) : {{ ok: false, by: occ.by }};
    if (!occ.ok) {{
      fallbackJsClick = true;
      occludedBy = occ.by || 'overlay';
      try {{ el.focus(); }} catch (e) {{}}
      for (const evType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {{
        try {{ el.dispatchEvent(new MouseEvent(evType, {{ bubbles: true, cancelable: true, view: hit.win }})); }} catch (e) {{}}
      }}
      el.click();
    }}
  }}
}} else {{
  fallbackJsClick = true;
  try {{ el.focus(); }} catch (e) {{}}
  el.click();
}}
return {{
  ok: true,
  visible: Boolean(visible && !fallbackJsClick),
  fallback_js_click: fallbackJsClick,
  occluded_by: occludedBy,
  before_url: beforeUrl,
  x: x,
  y: y,
  tag: tag,
  name: name
}};
}})()"""
                info = _eval_on_session(call, locate_expr)
                if not isinstance(info, dict):
                    raise RuntimeError("Failed to locate element for browser_click")
                if not info.get("ok"):
                    return info
                clicked_holder["info"] = info
                if info.get("visible"):
                    self._dispatch_mouse_click(call, info.get("x", 0), info.get("y", 0))
                time.sleep(0.3)

                # Auto-detect popup / target="_blank" / window.open() opened in THIS Bot's window
                if self.list_window_targets_fn is not None and before_window_tids:
                    try:
                        after_tabs = self.list_window_targets_fn() or []
                        new_tabs = [
                            t
                            for t in after_tabs
                            if isinstance(t, dict)
                            and t.get("id")
                            and str(t["id"]) not in before_window_tids
                        ]
                        if new_tabs:
                            new_tab_holder["target"] = new_tabs[-1]
                            new_tab_holder["tab_count"] = len(after_tabs)
                            return {"_switched_new_tab": True}
                        new_tab_holder["tab_count"] = len(after_tabs)
                    except Exception:
                        pass

                snap_expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot(80, 3000);
}})()"""
                try:
                    snap = _eval_on_session(call, snap_expr)
                except Exception as exc:
                    msg = str(exc)
                    if "Execution context" in msg or "Cannot find context" in msg or "scrollHeight" in msg:
                        return {"_navigated_retry": True}
                    raise
                if not isinstance(snap, dict):
                    raise RuntimeError("Failed to collect browser snapshot after click")
                before_url = info.get("before_url") or ""
                if before_url and snap.get("url") and snap.get("url") != before_url and snap.get("element_count", 0) == 0:
                    return {"_navigated_retry": True}
                clicked_meta = {
                    "ref": norm_ref,
                    "tag": info.get("tag", ""),
                    "name": info.get("name", ""),
                }
                if info.get("fallback_js_click"):
                    clicked_meta["fallback_js_click"] = True
                if info.get("occluded_by"):
                    clicked_meta["occluded_by"] = info["occluded_by"]
                snap["clicked"] = clicked_meta
                if "tab_count" in new_tab_holder:
                    snap["tab_count"] = new_tab_holder["tab_count"]
                if self.target_id:
                    snap.setdefault("target_id", self.target_id)
                return snap

            res = self.cdp_session(run_click)
            if isinstance(res, dict) and res.get("_navigated_retry"):
                self._wait_for_page_settle(max_polls=20, poll_sec=0.25, require_content=True)
                snap_expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot(80, 3000);
}})()"""
                snap = self.cdp_session(lambda call: _eval_on_session(call, snap_expr))
                if not isinstance(snap, dict):
                    raise RuntimeError("Failed to collect browser snapshot after navigation")
                info = clicked_holder.get("info") or {}
                clicked_meta = {
                    "ref": norm_ref,
                    "tag": info.get("tag", ""),
                    "name": info.get("name", ""),
                }
                if info.get("fallback_js_click"):
                    clicked_meta["fallback_js_click"] = True
                if info.get("occluded_by"):
                    clicked_meta["occluded_by"] = info["occluded_by"]
                snap["clicked"] = clicked_meta
                if "tab_count" in new_tab_holder:
                    snap["tab_count"] = new_tab_holder["tab_count"]
                return self._attach_snapshot_meta(snap)

            if isinstance(res, dict) and res.get("_switched_new_tab") and "target" in new_tab_holder:
                newest = new_tab_holder["target"]
                new_tid = str(newest["id"])
                new_ws = str(newest.get("webSocketDebuggerUrl") or "").strip()
                new_url = str(newest.get("url") or "").strip()
                self.target_id = new_tid
                self.target_ws_url = new_ws or f"ws://127.0.0.1:{self.cdp_port}/devtools/page/{new_tid}"
                if self.on_target_switch_fn is not None:
                    try:
                        self.on_target_switch_fn(new_tid, new_url)
                    except Exception:
                        pass
                self._wait_for_active_tab_ready()
                snap_expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot(80, 3000);
}})()"""
                snap = self.cdp_session(lambda call: _eval_on_session(call, snap_expr))
                if not isinstance(snap, dict):
                    raise RuntimeError("Failed to collect browser snapshot on newly opened tab")
                info = clicked_holder.get("info") or {}
                snap["clicked"] = {
                    "ref": norm_ref,
                    "tag": info.get("tag", ""),
                    "name": info.get("name", ""),
                }
                snap["switched_to_new_tab"] = True
                snap["target_id"] = new_tid
                if "tab_count" in new_tab_holder:
                    snap["tab_count"] = new_tab_holder["tab_count"]
                return snap
            return res

        expr = f"""(async function() {{
{_JS_SNAPSHOT_HELPER}
const ref = {json.dumps(norm_ref)};
const hit = findGbRef(ref);
if (!hit || !hit.el) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
const el = hit.el;
el.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'instant' }});
const tag = (el.tagName || '').toLowerCase();
const name = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
try {{ el.focus(); }} catch (e) {{}}
for (const evType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {{
  try {{ el.dispatchEvent(new MouseEvent(evType, {{ bubbles: true, cancelable: true, view: hit.win }})); }} catch (e) {{}}
}}
el.click();
await new Promise(r => setTimeout(r, 250));
const snap = collectGbSnapshot(80, 3000);
snap.clicked = {{ ref: ref, tag: tag, name: name }};
return snap;
}})()"""
        res = self.cdp_eval(expr)
        if not isinstance(res, dict):
            raise RuntimeError("Failed to execute browser_click")
        return res

    def browser_type(self, ref, text, submit=False, clear=True):
        norm_ref = normalize_element_ref(ref)
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        if not isinstance(submit, bool):
            raise ValueError("submit must be a boolean")
        if not isinstance(clear, bool):
            raise ValueError("clear must be a boolean")

        if self.cdp_eval is default_cdp_eval:
            def run_type(call):
                locate_expr = f"""(function() {{
{_JS_FIND_REF_HELPER}
const ref = {json.dumps(norm_ref)};
const hit = findGbRef(ref);
if (!hit || !hit.el) {{
  return {{
    ok: false,
    url: String(location.href || ''),
    title: String(document.title || ''),
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
const el = hit.el;
const beforeUrl = String(location.href || '');
el.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'instant' }});
const tag = (el.tagName || '').toLowerCase();
if (tag === 'select') {{
  return {{ ok: true, is_select: true }};
}}
const editable = ('value' in el) || Boolean(el.isContentEditable) || ['input', 'textarea'].includes(tag);
if (!editable) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' (<' + tag + '>) is not an editable input field; call browser_snapshot and pick an input ref'
  }};
}}
const r = el.getBoundingClientRect();
const visible = r && r.width >= 1 && r.height >= 1;
const x = visible ? (r.left + hit.offsetX + r.width / 2) : 0;
const y = visible ? (r.top + hit.offsetY + r.height / 2) : 0;
try {{ el.focus(); }} catch (e) {{}}
return {{ ok: true, visible: Boolean(visible), before_url: beforeUrl, x: x, y: y }};
}})()"""
                info = _eval_on_session(call, locate_expr)
                if not isinstance(info, dict):
                    raise RuntimeError("Failed to locate element for browser_type")
                if not info.get("ok"):
                    return info
                if info.get("is_select"):
                    return {"_delegate_select": True}
                if info.get("visible"):
                    self._dispatch_mouse_click(call, info.get("x", 0), info.get("y", 0))
                if clear:
                    _eval_on_session(
                        call,
                        f"""(function() {{
{_JS_FIND_REF_HELPER}
const hit = findGbRef({json.dumps(norm_ref)});
if (!hit || !hit.el) return;
const el = hit.el;
try {{ el.focus(); }} catch (e) {{}}
if (el.isContentEditable) {{
  const sel = hit.win.getSelection();
  const range = hit.doc.createRange();
  range.selectNodeContents(el);
  if (sel) {{ sel.removeAllRanges(); sel.addRange(range); }}
}} else if (typeof el.select === 'function') {{
  try {{ el.select(); }} catch (e) {{}}
}}
}})()""",
                    )
                    self._dispatch_key_press(call, "Backspace", "Backspace", 8)
                if text:
                    call("Input.insertText", {"text": text})
                if submit:
                    self._dispatch_key_press(call, "Enter", "Enter", 13, text="\r")
                time.sleep(0.3)
                snap_expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot(80, 3000);
}})()"""
                try:
                    snap = _eval_on_session(call, snap_expr)
                except Exception as exc:
                    msg = str(exc)
                    if "Execution context" in msg or "Cannot find context" in msg or "scrollHeight" in msg:
                        return {"_navigated_retry": True}
                    raise
                if not isinstance(snap, dict):
                    raise RuntimeError("Failed to collect browser snapshot after type")
                before_url = info.get("before_url") or ""
                if submit and before_url and snap.get("url") and snap.get("url") != before_url and snap.get("element_count", 0) == 0:
                    return {"_navigated_retry": True}
                snap["typed"] = {"ref": norm_ref, "submit": submit}
                return snap

            res = self.cdp_session(run_type)
            if isinstance(res, dict) and res.get("_delegate_select"):
                return self.browser_select(norm_ref, value=text, label=text)
            if isinstance(res, dict) and res.get("_navigated_retry"):
                self._wait_for_page_settle(max_polls=20, poll_sec=0.25, require_content=True)
                snap_expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot(80, 3000);
}})()"""
                snap = self.cdp_session(lambda call: _eval_on_session(call, snap_expr))
                if not isinstance(snap, dict):
                    raise RuntimeError("Failed to collect browser snapshot after type navigation")
                snap["typed"] = {"ref": norm_ref, "submit": submit}
                return self._attach_snapshot_meta(snap)
            return res

        expr = f"""(async function() {{
{_JS_SNAPSHOT_HELPER}
const ref = {json.dumps(norm_ref)};
const text = {json.dumps(text)};
const submit = {json.dumps(submit)};
const clear = {json.dumps(clear)};
const hit = findGbRef(ref);
if (!hit || !hit.el) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
const el = hit.el;
el.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'instant' }});
try {{ el.focus(); }} catch (e) {{}}

const nextVal = clear ? text : (String(el.value || '') + text);
if (el.isContentEditable) {{
  el.textContent = clear ? text : (String(el.textContent || '') + text);
}} else {{
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  if (desc && desc.set) {{
    desc.set.call(el, nextVal);
  }} else {{
    el.value = nextVal;
  }}
}}
try {{
  el.dispatchEvent(new InputEvent('input', {{ bubbles: true, data: text, inputType: 'insertText' }}));
}} catch (e) {{
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
}}
el.dispatchEvent(new Event('change', {{ bubbles: true }}));

if (submit) {{
  for (const evType of ['keydown', 'keypress', 'keyup']) {{
    el.dispatchEvent(new KeyboardEvent(evType, {{
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }}));
  }}
  if (el.form) {{
    try {{
      if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else el.form.submit();
    }} catch (e) {{}}
  }}
}}
await new Promise(r => setTimeout(r, 250));
const snap = collectGbSnapshot(80, 3000);
snap.typed = {{ ref: ref, submit: submit }};
return snap;
}})()"""
        res = self.cdp_eval(expr)
        if not isinstance(res, dict):
            raise RuntimeError("Failed to execute browser_type")
        return res

    def browser_scroll(self, direction="down", amount=600, ref=None):
        dir_norm = str(direction or "down").strip().lower()
        if dir_norm not in ("up", "down", "left", "right"):
            raise ValueError(f"invalid direction: {direction} (expected up/down/left/right)")
        if type(amount) is not int or isinstance(amount, bool) or not (50 <= amount <= 5000):
            raise ValueError(f"amount must be an integer between 50 and 5000, got {amount}")
        norm_ref = normalize_element_ref(ref) if ref is not None and str(ref).strip() else None

        dx = -amount if dir_norm == "left" else (amount if dir_norm == "right" else 0)
        dy = -amount if dir_norm == "up" else (amount if dir_norm == "down" else 0)

        expr = f"""(async function() {{
{_JS_SNAPSHOT_HELPER}
const dx = {dx};
const dy = {dy};
const ref = {json.dumps(norm_ref)};
let scrolledContainer = false;

function isScrollable(el) {{
  if (!el || el === document.body || el === document.documentElement) return false;
  try {{
    const st = window.getComputedStyle(el);
    if (!st) return false;
    const canY = dy !== 0 && (st.overflowY === 'auto' || st.overflowY === 'scroll' || st.overflowY === 'overlay') && el.scrollHeight > el.clientHeight + 10;
    const canX = dx !== 0 && (st.overflowX === 'auto' || st.overflowX === 'scroll' || st.overflowX === 'overlay') && el.scrollWidth > el.clientWidth + 10;
    return canY || canX;
  }} catch (e) {{
    return false;
  }}
}}

if (ref) {{
  const hit = findGbRef(ref);
  if (!hit || !hit.el) {{
    return {{
      ok: false,
      error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
    }};
  }}
  let cur = hit.el;
  while (cur && cur !== hit.doc.body && cur !== hit.doc.documentElement) {{
    if (isScrollable(cur)) {{
      cur.scrollBy({{ left: dx, top: dy, behavior: 'instant' }});
      scrolledContainer = true;
      break;
    }}
    cur = cur.parentElement;
  }}
  if (!scrolledContainer) {{
    hit.win.scrollBy({{ left: dx, top: dy, behavior: 'instant' }});
  }}
}} else {{
  const prevX = window.scrollX || 0;
  const prevY = window.scrollY || 0;
  window.scrollBy({{ left: dx, top: dy, behavior: 'instant' }});
  const moved = (window.scrollX || 0) !== prevX || (window.scrollY || 0) !== prevY;
  if (!moved) {{
    // SPA fallback: locate the largest visible scrollable container
    let best = null;
    let bestArea = 0;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && i < 2500; i++) {{
      const el = all[i];
      if (!isScrollable(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width >= 200 && r.height >= 150) {{
        bestArea = area;
        best = el;
      }}
    }}
    if (best) {{
      best.scrollBy({{ left: dx, top: dy, behavior: 'instant' }});
      scrolledContainer = true;
    }}
  }}
}}

await new Promise(r => setTimeout(r, 150));
const snap = collectGbSnapshot(80, 3000);
snap.scrolled = {{
  direction: {json.dumps(dir_norm)},
  amount: {amount},
  ref: ref,
  scrolled_container: scrolledContainer,
}};
return snap;
}})()"""
        if self.cdp_eval is default_cdp_eval:
            res = self.cdp_session(lambda call: _eval_on_session(call, expr))
        else:
            res = self.cdp_eval(expr)
        if not isinstance(res, dict):
            raise RuntimeError("Failed to execute browser_scroll")
        return self._attach_snapshot_meta(res)

    def browser_wait(self, ms=1500, text=None, ref=None, timeout=10.0):
        if type(ms) is not int or isinstance(ms, bool) or not (200 <= ms <= 15000):
            raise ValueError(f"ms must be an integer between 200 and 15000, got {ms}")
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not (1 <= timeout <= 20):
            raise ValueError(f"timeout must be a number between 1 and 20, got {timeout}")
        want_text = None
        if text is not None and str(text).strip():
            if not isinstance(text, str):
                raise TypeError("text must be a string")
            want_text = text.strip()
        norm_ref = normalize_element_ref(ref) if ref is not None and str(ref).strip() else None

        started = time.time()
        matched = False
        if want_text or norm_ref:
            deadline = started + float(timeout)
            want_lower = want_text.lower() if want_text else ""
            while True:
                check_expr = f"""(function() {{
{_JS_FIND_REF_HELPER}
const wantRef = {json.dumps(norm_ref)};
const wantLower = {json.dumps(want_lower)};
if (wantRef && findGbRef(wantRef)) return true;
if (wantLower) {{
  const t = ((document.title || '') + ' ' + ((document.body && document.body.innerText) || '')).toLowerCase();
  if (t.includes(wantLower)) return true;
}}
return false;
}})()"""
                try:
                    if self.cdp_eval is default_cdp_eval:
                        hit = self.cdp_session(lambda call: _eval_on_session(call, check_expr))
                    else:
                        hit = self.cdp_eval(check_expr)
                    if hit:
                        matched = True
                        break
                except Exception:
                    pass
                if time.time() >= deadline:
                    break
                time.sleep(0.25)
        else:
            time.sleep(ms / 1000.0)
            if self.cdp_eval is default_cdp_eval:
                self._wait_for_page_settle(max_polls=8, poll_sec=0.2, require_content=False)
            matched = True

        snap = self.browser_snapshot(max_elements=80, max_text=3000)
        elapsed_ms = int(round((time.time() - started) * 1000))
        snap["waited"] = {
            "matched": bool(matched),
            "elapsed_ms": elapsed_ms,
            **({"text": want_text} if want_text else {}),
            **({"ref": norm_ref} if norm_ref else {}),
        }
        return snap

    def browser_select(self, ref, value=None, label=None):
        norm_ref = normalize_element_ref(ref)
        val_str = str(value).strip() if value is not None and str(value).strip() else None
        lbl_str = str(label).strip() if label is not None and str(label).strip() else None
        if not val_str and not lbl_str:
            raise ValueError("browser_select requires value or label")

        expr = f"""(async function() {{
{_JS_SNAPSHOT_HELPER}
const ref = {json.dumps(norm_ref)};
const wantVal = {json.dumps(val_str)};
const wantLabel = {json.dumps(lbl_str)};
const hit = findGbRef(ref);
if (!hit || !hit.el) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
const el = hit.el;
const tag = (el.tagName || '').toLowerCase();
if (tag !== 'select') {{
  return {{
    ok: false,
    error: 'element ' + ref + ' (<' + tag + '>) is not a <select> dropdown; use browser_click for custom dropdowns'
  }};
}}
const opts = Array.from(el.options || []);
let chosen = null;
if (wantVal) {{
  chosen = opts.find(o => String(o.value) === wantVal) || null;
}}
if (!chosen && wantLabel) {{
  chosen = opts.find(o => String(o.text || '').trim() === wantLabel) || null;
}}
if (!chosen && wantVal) {{
  const vl = wantVal.toLowerCase();
  chosen = opts.find(o => String(o.value).toLowerCase() === vl) || null;
}}
if (!chosen && wantLabel) {{
  const ll = wantLabel.toLowerCase();
  chosen = opts.find(o => String(o.text || '').trim().toLowerCase() === ll) || null;
}}
if (!chosen && wantLabel) {{
  const ll = wantLabel.toLowerCase();
  chosen = opts.find(o => String(o.text || '').trim().toLowerCase().includes(ll)) || null;
}}
if (!chosen) {{
  return {{
    ok: false,
    error: 'no matching option found in <select> ' + ref,
    available_options: opts.slice(0, 30).map(o => ({{ value: String(o.value || ''), label: String(o.text || '').trim() }}))
  }};
}}
el.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'instant' }});
try {{ el.focus(); }} catch (e) {{}}
const desc = Object.getOwnPropertyDescriptor(hit.win.HTMLSelectElement.prototype, 'value');
if (desc && desc.set) {{
  desc.set.call(el, chosen.value);
}} else {{
  el.value = chosen.value;
}}
chosen.selected = true;
el.dispatchEvent(new Event('input', {{ bubbles: true }}));
el.dispatchEvent(new Event('change', {{ bubbles: true }}));
await new Promise(r => setTimeout(r, 200));
const snap = collectGbSnapshot(80, 3000);
snap.selected = {{
  ref: ref,
  value: String(chosen.value || ''),
  label: String(chosen.text || '').trim(),
}};
return snap;
}})()"""
        if self.cdp_eval is default_cdp_eval:
            res = self.cdp_session(lambda call: _eval_on_session(call, expr))
        else:
            res = self.cdp_eval(expr)
        if not isinstance(res, dict):
            raise RuntimeError("Failed to execute browser_select")
        return self._attach_snapshot_meta(res)

    def browser_upload_file(self, ref, paths):
        norm_ref = normalize_element_ref(ref)
        if isinstance(paths, str):
            raw_paths = [paths]
        elif isinstance(paths, list):
            raw_paths = paths
        else:
            raise TypeError("paths must be a list of file paths")
        if not raw_paths:
            raise ValueError("paths must be a non-empty list")

        resolved_paths = []
        for p in raw_paths:
            if not isinstance(p, str) or not p.strip():
                raise ValueError("each upload path must be a non-empty string")
            check_read_path_allowed(p)
            norm_p = os.path.realpath(p)
            check_read_path_allowed(norm_p)
            if not os.path.isfile(norm_p):
                raise ValueError(f"upload file not found: {p}")
            resolved_paths.append(norm_p)

        if self.cdp_eval is default_cdp_eval:
            def run_upload(call):
                verify_expr = f"""(function() {{
{_JS_FIND_REF_HELPER}
const hit = findGbRef({json.dumps(norm_ref)});
if (!hit || !hit.el) {{
  return {{ ok: false, error: 'element ' + {json.dumps(norm_ref)} + ' not found on current page (call browser_snapshot to refresh refs)' }};
}}
const tag = (hit.el.tagName || '').toLowerCase();
const typ = (hit.el.getAttribute('type') || '').toLowerCase();
if (tag !== 'input' || typ !== 'file') {{
  return {{ ok: false, error: 'element ' + {json.dumps(norm_ref)} + ' (<' + tag + ' type=\"' + typ + '\">) is not an <input type=\"file\">' }};
}}
return {{ ok: true, multiple: Boolean(hit.el.multiple) }};
}})()"""
                info = _eval_on_session(call, verify_expr)
                if not isinstance(info, dict):
                    raise RuntimeError("Failed to inspect file input element")
                if not info.get("ok"):
                    return info
                if len(resolved_paths) > 1 and not info.get("multiple"):
                    return {
                        "ok": False,
                        "error": f"file input {norm_ref} does not have the 'multiple' attribute; pass a single file path",
                    }

                try:
                    call("DOM.enable", {})
                except Exception:
                    pass
                call("DOM.getDocument", {"depth": 0})
                eval_res = call(
                    "Runtime.evaluate",
                    {
                        "expression": f"(function(){{ {_JS_FIND_REF_HELPER} const h = findGbRef({json.dumps(norm_ref)}); return h ? h.el : null; }})()",
                        "returnByValue": False,
                    },
                )
                obj_id = (eval_res.get("result") or {}).get("objectId")
                if not obj_id:
                    return {
                        "ok": False,
                        "error": f"failed to resolve DOM handle for file input {norm_ref}",
                    }
                req_res = call("DOM.requestNode", {"objectId": obj_id})
                node_id = req_res.get("nodeId")
                if not node_id:
                    return {
                        "ok": False,
                        "error": f"failed to resolve DOM nodeId for file input {norm_ref}",
                    }
                call("DOM.setFileInputFiles", {"files": resolved_paths, "nodeId": node_id})
                time.sleep(0.3)
                snap_expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot(80, 3000);
}})()"""
                snap = _eval_on_session(call, snap_expr)
                if not isinstance(snap, dict):
                    raise RuntimeError("Failed to collect browser snapshot after file upload")
                snap["uploaded"] = {
                    "ref": norm_ref,
                    "files": [os.path.basename(p) for p in resolved_paths],
                    "count": len(resolved_paths),
                }
                return snap

            res = self.cdp_session(run_upload)
            return self._attach_snapshot_meta(res) if isinstance(res, dict) else res

        # Custom cdp_eval fallback (for unit tests mocking cdp_eval)
        expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
const snap = collectGbSnapshot(80, 3000);
snap.uploaded = {{ ref: {json.dumps(norm_ref)}, files: {json.dumps([os.path.basename(p) for p in resolved_paths])}, count: {len(resolved_paths)} }};
return snap;
}})()"""
        res = self.cdp_eval(expr)
        if not isinstance(res, dict):
            raise RuntimeError("Failed to execute browser_upload_file")
        return res


class ExecutorHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Quiet default logging
        pass

    def send_json(self, status_code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def check_auth(self) -> bool:
        auth_header = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.token}"
        return hmac.compare_digest(auth_header, expected)

    def parse_body(self) -> dict:
        cl = self.headers.get("Content-Length")
        if not cl:
            return {}
        try:
            length = int(cl)
        except ValueError:
            raise ValueError("invalid Content-Length")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            val = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ValueError(f"invalid JSON body: {e}")
        if not isinstance(val, dict):
            raise ValueError("JSON body must be an object")
        return val

    def do_GET(self):
        if not self.check_auth():
            self.send_json(401, {"error": "unauthorized"})
            return

        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(
                200,
                {
                    "ok": True,
                    "width": 1440,
                    "height": 900,
                    "executor_sha256": EXECUTOR_FILE_SHA256,
                },
            )
        elif parsed.path == "/displays":
            dm = getattr(self.server, "display_manager", None)
            if dm is None:
                self.send_json(200, {"ok": True, "bindings": {}, "displays": [display_resources(1)]})
            else:
                self._resolve_bot_context({})
                self.send_json(200, dm.list_displays())
        else:
            self.send_json(404, {"error": "not found"})

    def _resolve_bot_context(self, body: dict):
        bot_id = str(
            self.headers.get("X-Twinkle-Bot-Id", "") or (body.get("bot_id") if isinstance(body, dict) else "") or ""
        ).strip()
        raw_admin = str(
            self.headers.get("X-Twinkle-Bot-Admin", "")
            or (body.get("is_admin") if isinstance(body, dict) else "")
            or ""
        ).strip().lower()
        is_admin = raw_admin in ("1", "true", "yes")
        raw_max = str(self.headers.get("X-Twinkle-Max-Screens", "") or "").strip()
        if raw_max.isdigit():
            dm = getattr(self.server, "display_manager", None)
            if dm is not None:
                try:
                    val = int(raw_max)
                    if val != dm.max_concurrent_screens:
                        dm.set_max_concurrent_screens(val)
                except Exception:
                    pass
        return bot_id, is_admin

    def _resolve_bot_workspace(self, body: dict) -> str:
        return str(
            self.headers.get("X-Twinkle-Bot-Workspace", "")
            or (body.get("bot_workspace") if isinstance(body, dict) else "")
            or ""
        ).strip()

    def do_POST(self):
        if not self.check_auth():
            self.send_json(401, {"error": "unauthorized"})
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            body = self.parse_body()
            dm = getattr(self.server, "display_manager", None)

            if path == "/displays":
                if dm is None:
                    self.send_json(200, {"ok": True, "bindings": {}, "displays": [display_resources(1)]})
                else:
                    self._resolve_bot_context(body)
                    self.send_json(200, dm.list_displays())
                return

            if path == "/displays/config":
                if dm is None:
                    self.send_json(200, {"ok": True, "max_concurrent_screens": 1, "budget": compute_screen_pool_budget()})
                    return
                if "max_concurrent_screens" not in body:
                    raise ValueError("missing max_concurrent_screens")
                self.send_json(200, dm.set_max_concurrent_screens(int(body["max_concurrent_screens"])))
                return

            if path == "/displays/ensure":
                bot_id, is_admin = self._resolve_bot_context(body)
                start_browser = bool(body.get("start_browser", False))
                if dm is None:
                    res_info = display_resources(1)
                    self.send_json(200, {"ok": True, **res_info})
                    return
                try:
                    info = dm.acquire_bot_tab(
                        bot_id,
                        is_admin=is_admin,
                        activate=True,
                        wait_timeout=(45.0 if start_browser else 0.4),
                    )
                    try:
                        self.send_json(200, {"ok": True, **info})
                    finally:
                        dm.release_bot_tab_in_flight(info.get("bot_key"))
                except RuntimeError:
                    if not start_browser:
                        res_info = display_resources(
                            1,
                            primary_profile_dir=dm.primary_profile_dir,
                            display=dm.display,
                            cdp_port=dm.cdp_port,
                        )
                        self.send_json(200, {"ok": True, **res_info, "queued": True})
                    else:
                        raise
                return

            if path == "/displays/release":
                bot_id = str(body.get("bot_id") or self.headers.get("X-Twinkle-Bot-Id", "") or "").strip()
                if dm is None:
                    self.send_json(200, {"ok": True, "released": False})
                    return
                self.send_json(200, dm.release_bot(bot_id))
                return

            if path == "/displays/sync_cookies":
                # All Bots share the Primary Chrome Profile natively; cookie sync is an instant no-op.
                self.send_json(200, {"ok": True, "synced": 0, "shared_profile": True})
                return

            bot_id, is_admin = self._resolve_bot_context(body)
            bot_workspace = self._resolve_bot_workspace(body)
            actions, acquired_bot_key, acquired_tab = self.server.acquire_actions_for_request(
                bot_id=bot_id, is_admin=is_admin, route=path, bot_workspace=bot_workspace
            )
            use_x11_lock = dm is not None and path in self.server._X11_ROUTES
            if use_x11_lock:
                dm.x11_lock.acquire()
            try:
                if use_x11_lock:
                    if dm.focus_bot_tab_if_exists(bot_id, is_admin=is_admin):
                        time.sleep(0.05)

                if path == "/screenshot":
                    res = actions.screenshot()
                elif path == "/click":
                    if "x" not in body or "y" not in body:
                        raise ValueError("missing x or y")
                    x = body.get("x")
                    y = body.get("y")
                    button = body.get("button", "left")
                    double = body.get("double", False)
                    res = actions.click(x=x, y=y, button=button, double=double)
                elif path == "/type":
                    if "text" not in body:
                        raise ValueError("missing text")
                    res = actions.type_text(
                        body["text"],
                        sensitive=bool(body.get("sensitive", False)),
                        press_enter=bool(body.get("press_enter", False)),
                    )
                elif path == "/key":
                    if "combo" not in body:
                        raise ValueError("missing combo")
                    res = actions.key(body["combo"])
                elif path == "/scroll":
                    if "x" not in body or "y" not in body or "direction" not in body:
                        raise ValueError("missing x, y, or direction")
                    x = body.get("x")
                    y = body.get("y")
                    direction = body.get("direction")
                    amount = body.get("amount", 3)
                    res = actions.scroll(x=x, y=y, direction=direction, amount=amount)
                elif path == "/drag":
                    for k in ("x1", "y1", "x2", "y2"):
                        if k not in body:
                            raise ValueError(f"missing {k}")
                    res = actions.drag(
                        x1=body["x1"],
                        y1=body["y1"],
                        x2=body["x2"],
                        y2=body["y2"],
                    )
                elif path == "/windows":
                    res = actions.list_windows()
                elif path == "/focus":
                    if "id" not in body:
                        raise ValueError("missing id")
                    res = actions.focus_window(body["id"])
                elif path == "/shell":
                    if "command" not in body:
                        raise ValueError("missing command")
                    timeout = body.get("timeout", 120)
                    res = actions.shell(body["command"], timeout=timeout)
                elif path == "/read":
                    if "path" not in body:
                        raise ValueError("missing path")
                    res = actions.read_file(
                        body["path"],
                        start_line=body.get("start_line"),
                        end_line=body.get("end_line"),
                    )
                elif path == "/write":
                    if "path" not in body or "content" not in body:
                        raise ValueError("missing path or content")
                    res = actions.write_file(body["path"], body["content"])
                elif path == "/edit":
                    if "path" not in body:
                        raise ValueError("missing path")
                    res = actions.edit_file(
                        body["path"],
                        target=body.get("target"),
                        replacement=body.get("replacement", ""),
                        append=bool(body.get("append", False)),
                        replace_all=bool(body.get("replace_all", False)),
                    )
                elif path == "/open_url":
                    if "url" not in body:
                        raise ValueError("missing url")
                    res = actions.open_url(body["url"])
                elif path == "/browser/snapshot":
                    url = body.get("url")
                    max_elements = body.get("max_elements", 80)
                    max_text = body.get("max_text", 3000)
                    wait_ms = body.get("wait_ms", 0)
                    res = actions.browser_snapshot(
                        url=url,
                        max_elements=max_elements,
                        max_text=max_text,
                        wait_ms=wait_ms,
                    )
                elif path == "/browser/click":
                    if "ref" not in body:
                        raise ValueError("missing ref")
                    res = actions.browser_click(body["ref"])
                elif path == "/browser/type":
                    if "ref" not in body or "text" not in body:
                        raise ValueError("missing ref or text")
                    submit = body.get("submit", False)
                    clear = body.get("clear", True)
                    res = actions.browser_type(
                        ref=body["ref"],
                        text=body["text"],
                        submit=submit,
                        clear=clear,
                    )
                elif path == "/browser/tabs":
                    action = body.get("action", "list")
                    url = body.get("url")
                    target_id = body.get("target_id")
                    index = body.get("index")
                    if dm is not None and acquired_bot_key:
                        res = dm.manage_bot_tabs(
                            acquired_bot_key,
                            action=action,
                            url=url,
                            target_id=target_id,
                            index=index,
                        )
                    else:
                        pages = [
                            t
                            for t in (actions.targets_fn(port=actions.cdp_port, timeout=2.5) or [])
                            if isinstance(t, dict)
                            and t.get("type") == "page"
                            and t.get("id")
                            and not str(t.get("url") or "").startswith(_IGNORED_CDP_PREFIXES)
                        ]
                        res = {
                            "ok": True,
                            "action": str(action or "list"),
                            "tab_count": len(pages),
                            "tabs": [
                                {
                                    "index": i,
                                    "target_id": str(t.get("id") or ""),
                                    "url": str(t.get("url") or ""),
                                    "title": str(t.get("title") or ""),
                                    "active": str(t.get("id") or "") == actions.target_id,
                                }
                                for i, t in enumerate(pages)
                            ],
                        }
                elif path == "/browser/scroll":
                    direction = body.get("direction", "down")
                    amount = body.get("amount", 600)
                    ref = body.get("ref")
                    res = actions.browser_scroll(direction=direction, amount=amount, ref=ref)
                elif path == "/browser/wait":
                    ms = body.get("ms", 1500)
                    text = body.get("text")
                    ref = body.get("ref")
                    timeout = body.get("timeout", 10.0)
                    res = actions.browser_wait(ms=ms, text=text, ref=ref, timeout=timeout)
                elif path == "/browser/select":
                    if "ref" not in body:
                        raise ValueError("missing ref")
                    res = actions.browser_select(
                        ref=body["ref"],
                        value=body.get("value"),
                        label=body.get("label"),
                    )
                elif path == "/browser/upload":
                    if "ref" not in body or "paths" not in body:
                        raise ValueError("missing ref or paths")
                    res = actions.browser_upload_file(ref=body["ref"], paths=body["paths"])
                else:
                    self.send_json(404, {"error": "not found"})
                    return

                if acquired_bot_key and dm is not None and isinstance(res, dict):
                    tracked_url = res.get("url") or (
                        body.get("url") if path in ("/open_url", "/browser/snapshot") else None
                    )
                    if tracked_url:
                        dm.record_bot_url(acquired_bot_key, str(tracked_url))
            finally:
                if use_x11_lock:
                    dm.x11_lock.release()
                if acquired_tab and dm is not None and acquired_bot_key:
                    dm.release_bot_tab_in_flight(acquired_bot_key)

            self.send_json(200, res)

        except (ValueError, TypeError, KeyError) as e:
            self.send_json(400, {"error": str(e)})
        except PermissionError as e:
            self.send_json(403, {"error": str(e)})
        except Exception as e:
            self.send_json(500, {"error": str(e)})


class ExecutorServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    _BROWSER_ROUTES = {
        "/open_url",
        "/browser/snapshot",
        "/browser/click",
        "/browser/type",
        "/browser/tabs",
        "/browser/scroll",
        "/browser/wait",
        "/browser/select",
        "/browser/upload",
    }
    _X11_ROUTES = {"/screenshot", "/click", "/type", "/key", "/scroll", "/drag", "/windows", "/focus"}
    _FILE_ROUTES = {"/read", "/write", "/edit"}

    def __init__(self, server_address, RequestHandlerClass, actions, token, display_manager=None):
        super().__init__(server_address, RequestHandlerClass)
        self.actions = actions
        self.token = token
        self.display_manager = display_manager

    def _make_tab_actions(self, tab_info: dict, bot_workspace: str = "") -> Actions:
        dm = self.display_manager
        bot_key = tab_info.get("bot_key")
        ws = str(bot_workspace or "").strip() or None
        return Actions(
            run=self.actions.run,
            browser=self.actions.browser,
            spawn=self.actions.spawn,
            cdp_eval=self.actions._custom_cdp_eval,
            cdp_session=self.actions._custom_cdp_session,
            display=(dm.display if dm is not None else self.actions.display),
            cdp_port=(dm.cdp_port if dm is not None else self.actions.cdp_port),
            profile_dir=(dm.primary_profile_dir if dm is not None else self.actions.profile_dir),
            target_id=tab_info.get("target_id"),
            target_ws_url=tab_info.get("ws_url"),
            window_id=tab_info.get("window_id"),
            targets_fn=(dm.targets_fn if dm is not None else None),
            protected_targets_fn=(dm.protected_target_ids if dm is not None else None),
            list_window_targets_fn=(
                (lambda bk=bot_key: dm.list_bot_window_targets(bk))
                if dm is not None and bot_key
                else None
            ),
            on_target_switch_fn=(
                (lambda tid, url="", bk=bot_key: dm.set_bot_active_target(bk, tid, url=url))
                if dm is not None and bot_key
                else None
            ),
            bot_workspace=ws,
        )

    def _make_shell_actions(self, bot_workspace: str = "") -> Actions:
        ws = str(bot_workspace or "").strip()
        if (
            not ws
            or not os.path.isabs(ws)
            or not os.path.isdir(ws)
            or getattr(self.actions, "_custom_run", None) is not None
        ):
            return self.actions
        return Actions(
            browser=self.actions.browser,
            spawn=self.actions._custom_spawn,
            cdp_eval=self.actions._custom_cdp_eval,
            cdp_session=self.actions._custom_cdp_session,
            display=self.actions.display,
            cdp_port=self.actions.cdp_port,
            profile_dir=self.actions.profile_dir,
            targets_fn=self.actions.targets_fn,
            protected_targets_fn=self.actions.protected_targets_fn,
            cwd=ws,
            bot_workspace=ws,
        )

    def acquire_actions_for_request(
        self, bot_id: str = "", is_admin: bool = False, route: str = "", bot_workspace: str = ""
    ):
        dm = self.display_manager
        if route == "/shell":
            return self._make_shell_actions(bot_workspace), None, False

        if dm is None or route in self._FILE_ROUTES:
            return self.actions, None, False

        if route in self._BROWSER_ROUTES:
            tab_info = dm.acquire_bot_tab(bot_id, is_admin=is_admin, activate=False)
            return self._make_tab_actions(tab_info, bot_workspace=bot_workspace), tab_info.get("bot_key"), True

        return self.actions, None, False

    def get_actions_for_request(self, bot_id: str = "", is_admin: bool = False, route: str = ""):
        actions, bot_key, acquired = self.acquire_actions_for_request(
            bot_id=bot_id, is_admin=is_admin, route=route
        )
        if acquired and self.display_manager is not None and bot_key:
            self.display_manager.release_bot_tab_in_flight(bot_key)
        return actions, 1


def make_server(
    actions: Actions,
    token: str,
    host: str = "0.0.0.0",
    port: int = 7300,
    display_manager: DisplayManager = None,
) -> http.server.ThreadingHTTPServer:
    return ExecutorServer((host, port), ExecutorHandler, actions, token, display_manager=display_manager)


def main():
    token = os.environ.get("TWINKLEBOT_EXECUTOR_TOKEN")
    if not token:
        print("TWINKLEBOT_EXECUTOR_TOKEN is not set", file=sys.stderr)
        sys.exit(1)

    browser = resolve_default_browser()
    host = os.environ.get("TWINKLEBOT_EXECUTOR_HOST", "0.0.0.0")
    port = int(os.environ.get("TWINKLEBOT_EXECUTOR_PORT", "7300"))

    actions = Actions(browser=browser)
    display_manager = DisplayManager(browser_bin=browser)

    stop_event = threading.Event()

    def _reclaim_loop():
        while not stop_event.wait(30):
            try:
                display_manager.reclaim_idle_browsers()
            except Exception:
                pass

    threading.Thread(target=_reclaim_loop, daemon=True).start()
    server = make_server(actions, token, host=host, port=port, display_manager=display_manager)

    def _handle_shutdown_signal(_signum, _frame):
        stop_event.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    for _sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(_sig, _handle_shutdown_signal)
        except Exception:
            pass

    print(f"TwinkleBot executor listening on {host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        try:
            display_manager.suspend_browser(reason="shutdown")
        except Exception:
            pass
        server.server_close()


if __name__ == "__main__":
    main()
