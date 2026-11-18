import base64
import fnmatch
import getpass
import hashlib
import hmac
import http.server
import json
import os
import re
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
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_IGNORED_CDP_PREFIXES = ("devtools://", "chrome-extension://", "chrome://omnibox")
_BLANK_CDP_URLS = ("", "about:blank", "chrome://newtab/", "chrome://new-tab-page/", "edge://newtab/")
DISPLAY_MAP_PATH = os.environ.get("TWINKLEBOT_DISPLAY_MAP", "/opt/twinklebot/display-map.json")
PRIMARY_PROFILE_DIR = "/opt/twinklebot/chrome-profile"
ABSOLUTE_MIN_CONCURRENT_SCREENS = 1
ABSOLUTE_MAX_CONCURRENT_SCREENS = 16
BROWSER_IDLE_RECLAIM_SEC = max(60, int(os.environ.get("TWINKLEBOT_BROWSER_IDLE_SEC", str(15 * 60))))


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


def default_run(argv, input=None, timeout=None, display: str = None, cdp_port: int = None, profile_dir: str = None):
    env = desktop_env(display=display, cdp_port=cdp_port, profile_dir=profile_dir)
    if input is not None:
        return subprocess.run(
            argv,
            input=input,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout or 10,
            env=env,
        )
    return subprocess.run(argv, input=input, capture_output=True, timeout=timeout or 15, env=env)


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


def cdp_ws_session(ws_url: str, callback, timeout: float = 8.0):
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


def cdp_ws_call(ws_url: str, method: str, params: dict = None, timeout: float = 8.0):
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


def default_cdp_session(callback, port: int = DEFAULT_CDP_PORT, timeout: float = 8.0):
    try:
        targets = fetch_cdp_targets(port=port, timeout=timeout)
    except Exception as e:
        raise RuntimeError(f"Chromium CDP (127.0.0.1:{port}) unreachable: {e}")

    target = select_cdp_page_target(targets)
    if not target:
        raise RuntimeError(f"No active Chromium page tab found on CDP port {port}")

    activate_cdp_target(target, port=port, timeout=min(timeout, 3.0))
    return cdp_ws_session(target["webSocketDebuggerUrl"], callback, timeout=timeout)


def default_cdp_eval(expression: str, port: int = DEFAULT_CDP_PORT, timeout: float = 8.0):
    return default_cdp_session(lambda call: _eval_on_session(call, expression), port=port, timeout=timeout)


def fetch_cdp_browser_ws(port: int = DEFAULT_CDP_PORT, timeout: float = 2.0):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as resp:
            info = json.loads(resp.read().decode("utf-8", errors="replace"))
            ws = info.get("webSocketDebuggerUrl") if isinstance(info, dict) else None
            return ws if isinstance(ws, str) and ws else None
    except Exception:
        return None


def close_cdp_target(target_id: str, port: int = DEFAULT_CDP_PORT, timeout: float = 2.0):
    if not target_id:
        return
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/json/close/{urllib.parse.quote(str(target_id))}",
            timeout=timeout,
        ) as resp:
            resp.read()
    except Exception:
        pass


def create_cdp_target(url: str = "about:blank", port: int = DEFAULT_CDP_PORT, timeout: float = 4.0) -> dict:
    start_url = url if isinstance(url, str) and url.strip() else "about:blank"
    browser_ws = fetch_cdp_browser_ws(port=port, timeout=min(timeout, 2.0))
    if browser_ws:
        try:
            res = cdp_ws_call(browser_ws, "Target.createTarget", {"url": start_url}, timeout=timeout)
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
            pass

    encoded = urllib.parse.quote(start_url, safe=":/?&=#%")
    req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?{encoded}", method="PUT")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


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


def _default_tcp_open(port: int, host: str = "127.0.0.1", timeout: float = 0.25) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


class TabManager:
    """
    Multi-Bot Chrome Tab Manager over a SINGLE official Google Chrome instance (`:1`, CDP `9222`)
    sharing the Primary Profile (`/opt/twinklebot/chrome-profile`) for 100% native shared login state.

    - Bot count is unlimited.
    - Each active Bot gets its own isolated CDP Page Tab (`target_id`) inside the shared Chrome process.
    - Concurrently active Bot tabs are bounded by `max_concurrent_screens` (hardware-budgeted default);
      idle tabs are reclaimed (preserving last URL) when the pool is full, and in-flight overflows queue FIFO.
    """

    def __init__(
        self,
        map_path: str = DISPLAY_MAP_PATH,
        primary_profile_dir: str = PRIMARY_PROFILE_DIR,
        max_concurrent_screens: int = None,
        browser_idle_sec: int = BROWSER_IDLE_RECLAIM_SEC,
        browser_boot_timeout_sec: float = 8.0,
        cdp_port: int = DEFAULT_CDP_PORT,
        display: str = None,
        spawn_fn=subprocess.Popen,
        tcp_open_fn=_default_tcp_open,
        cdp_ws_fn=fetch_cdp_browser_ws,
        targets_fn=fetch_cdp_targets,
        create_tab_fn=create_cdp_target,
        close_tab_fn=close_cdp_target,
        activate_tab_fn=activate_cdp_target,
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
        self.browser_boot_timeout_sec = max(0.05, float(browser_boot_timeout_sec))
        self.spawn_fn = spawn_fn
        self.tcp_open_fn = tcp_open_fn
        self.cdp_ws_fn = cdp_ws_fn
        self.targets_fn = targets_fn
        self.create_tab_fn = create_tab_fn
        self.close_tab_fn = close_tab_fn
        self.activate_tab_fn = activate_tab_fn
        self.browser_bin = browser_bin or DEFAULT_BROWSER
        self._lock = threading.RLock()
        self._slot_cond = threading.Condition(self._lock)
        self._browser_boot_lock = threading.RLock()
        self.x11_lock = threading.RLock()
        self._bot_targets = {}  # bot_key -> target_id
        self._bot_is_admin = {}  # bot_key -> bool
        self._bot_last_urls = {}  # bot_key -> last non-blank URL for seamless tab wake
        self._last_tab_at = {}  # bot_key -> timestamp
        self._in_flight = {}  # bot_key -> active request count
        self._load_map()

    @staticmethod
    def _normalize_bot_key(bot_id: str = None, is_admin: bool = False) -> str:
        bid = str(bot_id or "").strip()
        if bid:
            return bid
        return "__admin__" if is_admin else "__default__"

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
                    raw_urls = data.get("bot_last_urls")
                    if isinstance(raw_urls, dict):
                        for k, v in raw_urls.items():
                            bk = str(k or "").strip()
                            u = str(v or "").strip()
                            if bk and u:
                                self._bot_last_urls[bk] = u
        except Exception:
            self._bot_targets = {}
            self._bot_last_urls = {}

    def _save_map(self):
        try:
            parent = os.path.dirname(self.map_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            bindings = {
                k: f"tab:{tid[:8]}"
                for k, tid in sorted(self._bot_targets.items())
            }
            payload = {
                "mode": "shared-profile-multi-tab",
                "profile_dir": self.primary_profile_dir,
                "cdp_port": self.cdp_port,
                "max_concurrent_screens": self.max_concurrent_screens,
                "budget": self.budget,
                "bot_targets": dict(sorted(self._bot_targets.items())),
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
            if self.cdp_ws_fn(port=self.cdp_port, timeout=1.5):
                return res
            os.makedirs(self.primary_profile_dir, exist_ok=True)
            reset_chrome_crash_state(self.primary_profile_dir)
            env = desktop_env(display=self.display, cdp_port=self.cdp_port, profile_dir=self.primary_profile_dir)
            argv = [
                self.browser_bin,
                "--ozone-platform=x11",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--use-gl=angle",
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
                "--disable-blink-features=AutomationControlled",
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

    def set_max_concurrent_screens(self, limit: int) -> dict:
        clamped = max(
            ABSOLUTE_MIN_CONCURRENT_SCREENS,
            min(ABSOLUTE_MAX_CONCURRENT_SCREENS, int(limit)),
        )
        to_close = []
        live_pages = self._live_page_targets()
        live_by_id = {str(t["id"]): t for t in live_pages}
        with self._lock:
            self.max_concurrent_screens = clamped
            for bk, tid in list(self._bot_targets.items()):
                if tid not in live_by_id:
                    self._bot_targets.pop(bk, None)
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
                    vt = live_by_id.get(vtid or "")
                    if vt and not _is_blank_cdp_url(vt.get("url", "")):
                        self._bot_last_urls[victim] = str(vt.get("url"))
                    if vtid:
                        to_close.append(vtid)
            self._save_map()
            self._slot_cond.notify_all()
        remaining_live = len(live_pages)
        for vtid in to_close:
            if remaining_live > 1:
                self.close_tab_fn(vtid, port=self.cdp_port)
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
        restore_url = "about:blank"
        chosen_target = None

        while True:
            live_pages = self._live_page_targets()
            live_by_id = {str(t["id"]): t for t in live_pages}

            with self._lock:
                self._bot_is_admin[bot_key] = bool(is_admin)
                # Drop any stale target IDs closed externally by the user or page script
                for bk, tid in list(self._bot_targets.items()):
                    if live_by_id and tid not in live_by_id:
                        self._bot_targets.pop(bk, None)

                existing_tid = self._bot_targets.get(bot_key)
                if existing_tid and (existing_tid in live_by_id or not live_by_id):
                    self._in_flight[bot_key] = self._in_flight.get(bot_key, 0) + 1
                    self._last_tab_at[bot_key] = time.time()
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
                    return {**base, "bot_key": bot_key, "target_id": None, "acquired": False}

                if len(self._bot_targets) < self.max_concurrent_screens:
                    self._in_flight[bot_key] = self._in_flight.get(bot_key, 0) + 1
                    self._last_tab_at[bot_key] = time.time()
                    restore_url = self._bot_last_urls.get(bot_key, "about:blank")
                    owned_ids = set(self._bot_targets.values())
                    # Claim an unclaimed initial blank tab if present instead of leaving orphan about:blank
                    if restore_url == "about:blank":
                        for p in live_pages:
                            pid = str(p["id"])
                            if pid not in owned_ids and _is_blank_cdp_url(p.get("url", "")):
                                chosen_target = p
                                self._bot_targets[bot_key] = pid
                                self._save_map()
                                break
                    break

                # Pool is at max_concurrent_screens: reclaim an IDLE tab if any exists; otherwise wait FIFO!
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
                    vt = live_by_id.get(evicted_tid or "")
                    if vt and not _is_blank_cdp_url(vt.get("url", "")):
                        self._bot_last_urls[victim_bot] = str(vt.get("url"))
                    self._in_flight[bot_key] = self._in_flight.get(bot_key, 0) + 1
                    self._last_tab_at[bot_key] = time.time()
                    restore_url = self._bot_last_urls.get(bot_key, "about:blank")
                    break

                remaining = deadline - time.time()
                if remaining <= 0:
                    raise RuntimeError(
                        f"All {self.max_concurrent_screens} concurrent Chrome tabs are busy; timed out waiting in queue"
                    )
                self._slot_cond.wait(timeout=min(remaining, 0.4))

        try:
            # If we didn't claim an existing tab above, create a dedicated new tab FIRST (so Chrome never hits 0 tabs)
            if chosen_target is None:
                try:
                    created = self.create_tab_fn(restore_url, port=self.cdp_port)
                    tid = str((created or {}).get("id") or "").strip()
                    if tid:
                        chosen_target = created
                        with self._lock:
                            self._bot_targets[bot_key] = tid
                            self._save_map()
                except Exception:
                    # Fallback to best available page if CDP /json/new isn't mocked in legacy tests
                    fallback_page = select_cdp_page_target(self._live_page_targets())
                    if fallback_page:
                        chosen_target = fallback_page
                        with self._lock:
                            self._bot_targets[bot_key] = str(fallback_page["id"])
                            self._save_map()

            if evicted_tid and (not chosen_target or str(chosen_target.get("id")) != evicted_tid):
                self.close_tab_fn(evicted_tid, port=self.cdp_port)

            if activate and isinstance(chosen_target, dict) and chosen_target.get("id"):
                self.activate_tab_fn(chosen_target, port=self.cdp_port)

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
                "ws_url": str(chosen_target.get("webSocketDebuggerUrl") or "") if isinstance(chosen_target, dict) else "",
                "tab_url": str(chosen_target.get("url") or "") if isinstance(chosen_target, dict) else "",
                "tab_title": str(chosen_target.get("title") or "") if isinstance(chosen_target, dict) else "",
                "acquired": True,
            }
        except Exception:
            self.release_bot_tab_in_flight(bot_key)
            raise

    def release_bot_tab_in_flight(self, bot_key: str) -> None:
        if not bot_key:
            return
        with self._lock:
            cur = self._in_flight.get(bot_key, 0)
            if cur <= 1:
                self._in_flight.pop(bot_key, None)
            else:
                self._in_flight[bot_key] = cur - 1
            self._last_tab_at[bot_key] = time.time()
            self._slot_cond.notify_all()

    def record_bot_url(self, bot_key: str, url: str) -> None:
        u = str(url or "").strip()
        if not bot_key or not u or _is_blank_cdp_url(u):
            return
        with self._lock:
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
        if not tid:
            return False
        self.activate_tab_fn({"id": tid}, port=self.cdp_port)
        return True

    def protected_target_ids(self) -> set:
        with self._lock:
            return set(self._bot_targets.values())

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
                    vt = live_by_id.get(tid or "")
                    if vt and not _is_blank_cdp_url(vt.get("url", "")):
                        self._bot_last_urls[bk] = str(vt.get("url"))
                    if tid:
                        to_close.append((bk, tid))
            if to_close:
                self._save_map()
        remaining = len(live_pages)
        reclaimed_bots = []
        for bk, tid in to_close:
            if remaining > 1:
                self.close_tab_fn(tid, port=self.cdp_port)
                remaining -= 1
            reclaimed_bots.append(bk)
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
            self._bot_last_urls.pop(bid, None)
            self._last_tab_at.pop(bid, None)
            self._save_map()
            self._slot_cond.notify_all()
        if tid:
            if len(live_pages) > 1:
                self.close_tab_fn(tid, port=self.cdp_port)
            return {"ok": True, "released": True, "target_id": tid}
        return {"ok": True, "released": False}

    def list_displays(self) -> dict:
        live_pages = self._live_page_targets()
        live_by_id = {str(t["id"]): t for t in live_pages}
        with self._lock:
            for bk, tid in list(self._bot_targets.items()):
                if live_by_id and tid not in live_by_id:
                    self._bot_targets.pop(bk, None)
            bindings = {
                bk: f"标签 #{idx + 1}"
                for idx, (bk, _tid) in enumerate(sorted(self._bot_targets.items()))
            }
            tabs_info = [
                {
                    "bot_id": bk,
                    "target_id": tid,
                    "url": str((live_by_id.get(tid) or {}).get("url") or self._bot_last_urls.get(bk, "")),
                    "title": str((live_by_id.get(tid) or {}).get("title") or ""),
                    "in_flight": self._in_flight.get(bk, 0),
                    "last_active_at": self._last_tab_at.get(bk),
                }
                for bk, tid in sorted(self._bot_targets.items())
            ]
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


_JS_SNAPSHOT_HELPER = r"""
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
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[contenteditable="true"]',
    '[onclick]'
  ].join(',');

  const vw = window.innerWidth || 1440;
  const vh = window.innerHeight || 900;
  const nodes = Array.from(document.querySelectorAll(selector));
  const elements = [];
  let idx = 0;

  for (const el of nodes) {
    if (idx >= maxElements) break;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
      continue;
    }
    const r = el.getBoundingClientRect();
    if (!r || r.width < 3 || r.height < 3) continue;
    idx += 1;
    const ref = 'e' + idx;
    el.setAttribute('data-gb-ref', ref);

    const tag = (el.tagName || '').toLowerCase();
    const role = el.getAttribute('role') || (el.getAttribute('type') || '').toLowerCase() || tag;
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
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      in_viewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
    };

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const inpType = (el.getAttribute('type') || '').toLowerCase();
      item.value = inpType === 'password' ? (el.value ? '***' : '') : String(el.value || '').slice(0, 80);
      const ph = el.getAttribute('placeholder');
      if (ph) item.placeholder = String(ph).slice(0, 60);
    }
    if (tag === 'a' && el.href) {
      item.href = String(el.href).slice(0, 120);
    }
    if (el.disabled) item.disabled = true;
    elements.push(item);
  }

  const rawText = (document.body && document.body.innerText ? document.body.innerText : '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    ok: true,
    url: String(location.href || ''),
    title: String(document.title || ''),
    scroll: {
      y: Math.round(window.scrollY || 0),
      max_y: Math.max(0, Math.round((document.documentElement.scrollHeight || vh) - vh)),
      viewport_h: vh,
    },
    element_count: elements.length,
    elements: elements,
    text_excerpt: rawText.slice(0, maxText),
  };
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
        targets_fn=None,
        protected_targets_fn=None,
    ):
        self.display = str(display or ":1")
        self.cdp_port = int(cdp_port or DEFAULT_CDP_PORT)
        self.profile_dir = profile_dir
        self.target_id = str(target_id or "").strip() or None
        self.target_ws_url = str(target_ws_url or "").strip() or None
        self.targets_fn = targets_fn or fetch_cdp_targets
        self.protected_targets_fn = protected_targets_fn
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
            self.cdp_session = lambda callback, port=None, timeout=8.0: default_cdp_session(
                callback, port=(port or self.cdp_port), timeout=timeout
            )

    def _target_cdp_session(self, callback, port=None, timeout=8.0):
        eff_port = port or self.cdp_port
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

        def _with_focus_emulation(call):
            try:
                call("Emulation.setFocusEmulationEnabled", {"enabled": True})
            except Exception:
                pass
            return callback(call)

        return cdp_ws_session(ws_url, _with_focus_emulation, timeout=timeout)

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

    def type_text(self, text):
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        self.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"))
        self.run(["xdotool", "key", "--clearmodifiers", "ctrl+v"])
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

    def read_file(self, path):
        check_read_path_allowed(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
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

    def open_url(self, url):
        if not isinstance(url, str):
            raise TypeError("url must be a string")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"invalid scheme: {parsed.scheme}")

        if self.target_id and self._custom_cdp_eval is None:
            self.cdp_session(lambda call: call("Page.navigate", {"url": url}))
            return {"ok": True, "target_id": self.target_id}

        self.spawn([self.browser, url], start_new_session=True)
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

    def browser_snapshot(self, url=None, max_elements=80, max_text=3000):
        if url is not None:
            if not isinstance(url, str):
                raise TypeError("url must be a string")
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in ("http", "https"):
                raise ValueError(f"invalid scheme: {parsed.scheme}")
            if self.cdp_eval is default_cdp_eval:
                # Navigate this Bot's dedicated CDP tab (or active page when standalone) instead of spawning rogue tabs.
                if self.target_id or self._has_active_cdp_page():
                    self.cdp_session(lambda call: call("Page.navigate", {"url": url}))
                else:
                    self.open_url(url)
                for _ in range(32):
                    try:
                        state = self.cdp_session(
                            lambda call: _eval_on_session(
                                call,
                                "(function() { const cur = String(location.href || ''); if (cur === 'about:blank') return 'navigating'; return document.readyState; })()",
                            )
                        )
                        if state == "complete":
                            break
                        if state == "interactive":
                            time.sleep(0.2)
                            break
                    except Exception:
                        pass
                    time.sleep(0.25)
                if not self.target_id:
                    close_redundant_blank_tabs(port=self.cdp_port)
                elif self.protected_targets_fn is not None:
                    close_redundant_blank_tabs(
                        port=self.cdp_port,
                        protected_ids=self.protected_targets_fn(),
                    )
            else:
                self.open_url(url)

        if type(max_elements) is not int or isinstance(max_elements, bool) or not (1 <= max_elements <= 200):
            raise ValueError("max_elements must be an integer between 1 and 200")
        if type(max_text) is not int or isinstance(max_text, bool) or not (100 <= max_text <= 20000):
            raise ValueError("max_text must be an integer between 100 and 20000")

        expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot({max_elements}, {max_text});
}})()"""
        if self.cdp_eval is default_cdp_eval:
            res = self.cdp_session(lambda call: _eval_on_session(call, expr))
        else:
            res = self.cdp_eval(expr)
        if not isinstance(res, dict):
            raise RuntimeError("Failed to collect browser snapshot")
        return res

    def browser_click(self, ref):
        norm_ref = normalize_element_ref(ref)
        if self.cdp_eval is default_cdp_eval:
            def run_click(call):
                locate_expr = f"""(function() {{
const ref = {json.dumps(norm_ref)};
const el = document.querySelector('[data-gb-ref="' + ref + '"]');
if (!el) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
el.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'instant' }});
const r = el.getBoundingClientRect();
const tag = (el.tagName || '').toLowerCase();
const name = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
const visible = r && r.width >= 1 && r.height >= 1;
const x = visible ? (r.left + r.width / 2) : 0;
const y = visible ? (r.top + r.height / 2) : 0;
if (!visible) {{
  try {{ el.focus(); }} catch (e) {{}}
  el.click();
}}
return {{ ok: true, visible: Boolean(visible), x: x, y: y, tag: tag, name: name }};
}})()"""
                info = _eval_on_session(call, locate_expr)
                if not isinstance(info, dict):
                    raise RuntimeError("Failed to locate element for browser_click")
                if not info.get("ok"):
                    return info
                if info.get("visible"):
                    self._dispatch_mouse_click(call, info.get("x", 0), info.get("y", 0))
                time.sleep(0.3)
                snap_expr = f"""(function() {{
{_JS_SNAPSHOT_HELPER}
return collectGbSnapshot(80, 3000);
}})()"""
                snap = _eval_on_session(call, snap_expr)
                if not isinstance(snap, dict):
                    raise RuntimeError("Failed to collect browser snapshot after click")
                snap["clicked"] = {
                    "ref": norm_ref,
                    "tag": info.get("tag", ""),
                    "name": info.get("name", ""),
                }
                return snap

            return self.cdp_session(run_click)

        expr = f"""(async function() {{
{_JS_SNAPSHOT_HELPER}
const ref = {json.dumps(norm_ref)};
const el = document.querySelector('[data-gb-ref="' + ref + '"]');
if (!el) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
el.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'instant' }});
const tag = (el.tagName || '').toLowerCase();
const name = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
try {{ el.focus(); }} catch (e) {{}}
for (const evType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {{
  try {{ el.dispatchEvent(new MouseEvent(evType, {{ bubbles: true, cancelable: true, view: window }})); }} catch (e) {{}}
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
const ref = {json.dumps(norm_ref)};
const el = document.querySelector('[data-gb-ref="' + ref + '"]');
if (!el) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
el.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'instant' }});
const tag = (el.tagName || '').toLowerCase();
const editable = ('value' in el) || Boolean(el.isContentEditable) || ['input', 'textarea', 'select'].includes(tag);
if (!editable) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' (<' + tag + '>) is not an editable input field; call browser_snapshot and pick an input ref'
  }};
}}
const r = el.getBoundingClientRect();
const visible = r && r.width >= 1 && r.height >= 1;
const x = visible ? (r.left + r.width / 2) : 0;
const y = visible ? (r.top + r.height / 2) : 0;
try {{ el.focus(); }} catch (e) {{}}
return {{ ok: true, visible: Boolean(visible), x: x, y: y }};
}})()"""
                info = _eval_on_session(call, locate_expr)
                if not isinstance(info, dict):
                    raise RuntimeError("Failed to locate element for browser_type")
                if not info.get("ok"):
                    return info
                if info.get("visible"):
                    self._dispatch_mouse_click(call, info.get("x", 0), info.get("y", 0))
                if clear:
                    _eval_on_session(
                        call,
                        f"""(function() {{
const el = document.querySelector('[data-gb-ref="' + {json.dumps(norm_ref)} + '"]');
if (!el) return;
try {{ el.focus(); }} catch (e) {{}}
if (el.isContentEditable) {{
  const sel = window.getSelection();
  const range = document.createRange();
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
                snap = _eval_on_session(call, snap_expr)
                if not isinstance(snap, dict):
                    raise RuntimeError("Failed to collect browser snapshot after type")
                snap["typed"] = {"ref": norm_ref, "submit": submit}
                return snap

            return self.cdp_session(run_type)

        expr = f"""(async function() {{
{_JS_SNAPSHOT_HELPER}
const ref = {json.dumps(norm_ref)};
const text = {json.dumps(text)};
const submit = {json.dumps(submit)};
const clear = {json.dumps(clear)};
const el = document.querySelector('[data-gb-ref="' + ref + '"]');
if (!el) {{
  return {{
    ok: false,
    error: 'element ' + ref + ' not found on current page (call browser_snapshot to refresh refs)'
  }};
}}
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
            self.send_json(200, {"ok": True, "width": 1440, "height": 900})
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
            actions, acquired_bot_key, acquired_tab = self.server.acquire_actions_for_request(
                bot_id=bot_id, is_admin=is_admin, route=path
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
                    res = actions.type_text(body["text"])
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
                    timeout = body.get("timeout", 35)
                    res = actions.shell(body["command"], timeout=timeout)
                elif path == "/read":
                    if "path" not in body:
                        raise ValueError("missing path")
                    res = actions.read_file(body["path"])
                elif path == "/write":
                    if "path" not in body or "content" not in body:
                        raise ValueError("missing path or content")
                    res = actions.write_file(body["path"], body["content"])
                elif path == "/open_url":
                    if "url" not in body:
                        raise ValueError("missing url")
                    res = actions.open_url(body["url"])
                elif path == "/browser/snapshot":
                    url = body.get("url")
                    max_elements = body.get("max_elements", 80)
                    max_text = body.get("max_text", 3000)
                    res = actions.browser_snapshot(url=url, max_elements=max_elements, max_text=max_text)
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
    _BROWSER_ROUTES = {"/open_url", "/browser/snapshot", "/browser/click", "/browser/type"}
    _X11_ROUTES = {"/screenshot", "/click", "/type", "/key", "/scroll", "/drag", "/windows", "/focus"}
    _FILE_ROUTES = {"/read", "/write"}

    def __init__(self, server_address, RequestHandlerClass, actions, token, display_manager=None):
        super().__init__(server_address, RequestHandlerClass)
        self.actions = actions
        self.token = token
        self.display_manager = display_manager

    def _make_tab_actions(self, tab_info: dict) -> Actions:
        dm = self.display_manager
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
            targets_fn=(dm.targets_fn if dm is not None else None),
            protected_targets_fn=(dm.protected_target_ids if dm is not None else None),
        )

    def acquire_actions_for_request(self, bot_id: str = "", is_admin: bool = False, route: str = ""):
        dm = self.display_manager
        if dm is None or route in self._FILE_ROUTES or route == "/shell":
            return self.actions, None, False

        if route in self._BROWSER_ROUTES:
            tab_info = dm.acquire_bot_tab(bot_id, is_admin=is_admin, activate=False)
            return self._make_tab_actions(tab_info), tab_info.get("bot_key"), True

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

    def _reclaim_loop():
        while True:
            time.sleep(60)
            try:
                display_manager.reclaim_idle_browsers()
            except Exception:
                pass

    threading.Thread(target=_reclaim_loop, daemon=True).start()
    server = make_server(actions, token, host=host, port=port, display_manager=display_manager)
    print(f"TwinkleBot executor listening on {host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
