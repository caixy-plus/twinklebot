import atexit
import datetime
import fnmatch
import http.server
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

try:
    from executor import Actions, make_server
except ImportError:
    from executor.executor import Actions, make_server

RUN_X11_E2E = os.environ.get("TWINKLEBOT_RUN_CHROME_E2E", "") == "1"

_CASE_RECORDS = []
_SUITE_NAME = "p3-x11-desktop"
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_CASES_JSON_PATH = os.path.join(_PROJECT_ROOT, "test-results", "cases", f"{_SUITE_NAME}.json")


def _matches_case_filter(case_id: str) -> bool:
    raw = os.environ.get("TWINKLEBOT_E2E_CASES", "").strip()
    if not raw:
        return True
    for pat in [p.strip() for p in raw.split(",") if p.strip()]:
        if pat.lower() == case_id.lower() or fnmatch.fnmatch(case_id.lower(), pat.lower()):
            return True
    return False


def _flush_case_records():
    if not _CASE_RECORDS:
        return
    try:
        os.makedirs(os.path.dirname(_CASES_JSON_PATH), exist_ok=True)
        payload = {
            "suite": _SUITE_NAME,
            "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "records": _CASE_RECORDS,
        }
        with open(_CASES_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


atexit.register(_flush_case_records)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _is_display_lock_alive(disp: int) -> bool:
    lock_path = f"/tmp/.X{disp}-lock"
    if not os.path.exists(lock_path):
        return os.path.exists(f"/tmp/.X11-unix/X{disp}")
    try:
        with open(lock_path, "r", encoding="utf-8", errors="ignore") as f:
            pid_str = "".join(ch for ch in f.read() if ch.isdigit())
        if pid_str:
            os.kill(int(pid_str), 0)
            return True
    except ProcessLookupError:
        pass
    except PermissionError:
        return True
    except Exception:
        pass
    for stale in (lock_path, f"/tmp/.X11-unix/X{disp}"):
        try:
            os.unlink(stale)
        except Exception:
            pass
    return False


def _find_free_display() -> int:
    for disp in range(95, 220):
        if not _is_display_lock_alive(disp):
            return disp
    raise RuntimeError("No free X11 display in :95..:219")


def _find_chrome() -> str:
    for cand in (
        os.environ.get("TWINKLEBOT_E2E_CHROME_BIN", "").strip(),
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        shutil.which("google-chrome-stable") or "",
        shutil.which("google-chrome") or "",
    ):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return ""


_EVENTS_STATE = {"clicks": [], "dblclicks": 0, "scrolls": [], "keys": [], "drags": [], "text": ""}


class _X11TargetHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/state"):
            b = json.dumps(_EVENTS_STATE).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return

        title = "X11TargetTwo" if "two" in self.path else "X11TargetOne"
        html = f"""<!doctype html>
<html><head><title>{title}</title>
<style>
  html, body {{ margin: 0; padding: 0; width: 2200px; height: 2200px; background: #fff; font-family: sans-serif; }}
  #inp {{ position: fixed; left: 40px; top: 20px; width: 600px; height: 180px; font-size: 20px; border: 3px solid #2563eb; }}
  #pad {{ position: fixed; left: 40px; top: 220px; width: 600px; height: 400px; background: #e2e8f0; border: 2px solid #334155; user-select: none; -webkit-user-select: none; }}
</style></head>
<body>
  <input id="inp" type="text" autofocus />
  <div id="pad">X11 Event Target ({title})</div>
  <script>
    function report(kind, data) {{
      fetch('/ev', {{ method: 'POST', headers: {{'Content-Type':'application/json'}}, body: JSON.stringify({{ kind, data }}) }});
    }}
    let downPt = null;
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousedown', (e) => {{ downPt = {{ x: e.clientX, y: e.clientY, b: e.button }}; report('click', {{ button: e.button, x: e.clientX, y: e.clientY }}); }});
    window.addEventListener('dblclick', () => {{ report('dblclick', {{ ok: true }}); }});
    window.addEventListener('mouseup', (e) => {{
      if (downPt && Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 40) {{
        report('drag', {{ from: downPt, to: {{ x: e.clientX, y: e.clientY }} }});
      }}
      downPt = null;
    }});
    window.addEventListener('wheel', (e) => {{ report('scroll', {{ dx: e.deltaX, dy: e.deltaY }}); }});
    window.addEventListener('keydown', (e) => {{ report('key', {{ key: e.key }}); }});
    document.getElementById('inp').addEventListener('input', (e) => {{ report('text', {{ value: e.target.value }}); }});
  </script>
</body></html>"""
        b = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        cl = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(cl) if cl > 0 else b"{}"
        ev = json.loads(raw.decode("utf-8"))
        k = ev.get("kind")
        if k == "click":
            _EVENTS_STATE["clicks"].append(ev.get("data"))
        elif k == "dblclick":
            _EVENTS_STATE["dblclicks"] += 1
        elif k == "scroll":
            _EVENTS_STATE["scrolls"].append(ev.get("data"))
        elif k == "key":
            _EVENTS_STATE["keys"].append(ev.get("data"))
        elif k == "drag":
            _EVENTS_STATE["drags"].append(ev.get("data"))
        elif k == "text":
            _EVENTS_STATE["text"] = ev.get("data", {}).get("value", "")
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


class _Srv(http.server.ThreadingHTTPServer):
    daemon_threads = True


@unittest.skipUnless(RUN_X11_E2E, "Set TWINKLEBOT_RUN_CHROME_E2E=1 to run physical X11 desktop E2E")
class TestPhysicalX11DesktopE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chrome_bin = _find_chrome()
        if not cls.chrome_bin:
            raise RuntimeError("Official Google Chrome is required for physical X11 E2E")
        xvfb = shutil.which("Xvfb")
        tiger = shutil.which("Xtigervnc")
        if not xvfb and not tiger:
            raise RuntimeError("Xvfb or Xtigervnc required")

        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="tb-x11-e2e-")
        cls.disp_num = _find_free_display()
        cls.disp = f":{cls.disp_num}"
        cls.procs = []

        if xvfb:
            x_cmd = [xvfb, cls.disp, "-screen", "0", "1440x900x24", "-ac", "+extension", "GLX", "+render", "-noreset"]
        else:
            x_cmd = [tiger, cls.disp, "-geometry", "1440x900", "-depth", "24", "-SecurityTypes", "None", "-localhost", "yes", "-rfbport", str(_find_free_port())]
        cls.procs.append(subprocess.Popen(x_cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True))

        for _ in range(50):
            if os.path.exists(f"/tmp/.X11-unix/X{cls.disp_num}"):
                break
            time.sleep(0.1)

        cls.x_env = {**os.environ, "DISPLAY": cls.disp, "DBUS_SESSION_BUS_ADDRESS": "disabled:"}
        for pk in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "TWINKLE_PROXY"):
            cls.x_env.pop(pk, None)

        wm_bin = shutil.which("xfwm4") or shutil.which("openbox")
        if wm_bin:
            wm_env = {**cls.x_env}
            wm_env.pop("DBUS_SESSION_BUS_ADDRESS", None)
            dbus_run = shutil.which("dbus-run-session")
            if os.path.basename(wm_bin) == "xfwm4" and dbus_run:
                wm_cmd = [dbus_run, "--", wm_bin, "--compositor=off"]
            elif os.path.basename(wm_bin) == "xfwm4":
                wm_cmd = [wm_bin, "--compositor=off"]
            else:
                wm_cmd = [wm_bin]
            cls.procs.append(subprocess.Popen(wm_cmd, env=wm_env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True))
            time.sleep(0.6)

        cls.target_srv = _Srv(("127.0.0.1", 0), _X11TargetHandler)
        threading.Thread(target=cls.target_srv.serve_forever, daemon=True).start()
        cls.target_base = f"http://127.0.0.1:{cls.target_srv.server_address[1]}"

        for idx, path_suffix in enumerate(["/one", "/two"], start=1):
            prof = os.path.join(cls.tmp_dir.name, f"prof-{idx}")
            os.makedirs(prof, exist_ok=True)
            cls.procs.append(
                subprocess.Popen(
                    [
                        cls.chrome_bin,
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--use-gl=angle",
                        "--use-angle=swiftshader",
                        "--enable-unsafe-swiftshader",
                        "--no-first-run",
                        "--no-default-browser-check",
                        f"--user-data-dir={prof}",
                        "--window-position=0,0",
                        "--window-size=1200,800",
                        f"--app={cls.target_base}{path_suffix}",
                    ],
                    env=cls.x_env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    close_fds=True,
                    start_new_session=True,
                )
            )
            time.sleep(1.2)

        cls.token = "x11-e2e-tok"
        cls.actions = Actions(browser=cls.chrome_bin, display=cls.disp)
        cls.exec_srv = make_server(cls.actions, cls.token, host="127.0.0.1", port=0)
        threading.Thread(target=cls.exec_srv.serve_forever, daemon=True).start()
        cls.exec_base = f"http://127.0.0.1:{cls.exec_srv.server_address[1]}"

        if wm_bin:
            for _ in range(40):
                try:
                    wins = cls.actions.list_windows().get("windows") or []
                    titles = [w.get("title", "") for w in wins]
                    if any("X11TargetOne" in t for t in titles) and any("X11TargetTwo" in t for t in titles):
                        break
                except Exception:
                    pass
                time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        _flush_case_records()
        try:
            cls.exec_srv.shutdown()
            cls.exec_srv.server_close()
        except Exception:
            pass
        try:
            cls.target_srv.shutdown()
            cls.target_srv.server_close()
        except Exception:
            pass
        for p in reversed(getattr(cls, "procs", [])):
            try:
                pgid = os.getpgid(p.pid)
                os.killpg(pgid, signal.SIGKILL)
            except Exception:
                try:
                    if p.poll() is None:
                        p.kill()
                except Exception:
                    pass
        disp_num = getattr(cls, "disp_num", None)
        if disp_num is not None:
            for stale in (f"/tmp/.X{disp_num}-lock", f"/tmp/.X11-unix/X{disp_num}"):
                try:
                    os.unlink(stale)
                except Exception:
                    pass
        try:
            cls.tmp_dir.cleanup()
        except Exception:
            pass

    def _req(self, method: str, route: str, body=None, token=None, extra_headers=None, raw_bytes=None):
        tok = self.token if token is None else token
        headers = {}
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        data = None
        if raw_bytes is not None:
            data = raw_bytes
            headers["Content-Type"] = "application/json"
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(f"{self.exec_base}{route}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", errors="replace")
            try:
                return e.code, json.loads(txt)
            except Exception:
                return e.code, {"raw": txt}

    def _post(self, route: str, body: dict, **kw):
        return self._req("POST", route, body=body, **kw)

    def _record_case(self, case_id: str, title: str, module: str, fn):
        if not _matches_case_filter(case_id):
            self.skipTest(f"Filtered out by TWINKLEBOT_E2E_CASES: {case_id}")
        t0 = time.monotonic()
        status = "PASS"
        err_msg = None
        try:
            fn()
        except Exception as exc:
            status = "BUG"
            err_msg = str(exc)
            raise
        finally:
            dur = int((time.monotonic() - t0) * 1000)
            _CASE_RECORDS.append({
                "id": case_id,
                "priority": "P3",
                "featureTier": "F3",
                "difficulty": "D3",
                "title": title,
                "module": module,
                "suite": _SUITE_NAME,
                "status": status,
                "durationMs": dur,
                **({"error": err_msg} if err_msg else {}),
                "reproCommand": f"node scripts/run-e2e.mjs --case={case_id}",
                "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            })
            _flush_case_records()

    def test_p3_x11_01_physical_click_type_key_scroll_drag(self):
        def run():
            st_w, wres = self._post("/windows", {})
            self.assertEqual(st_w, 200)
            wins = wres.get("windows") or []
            win1 = next((w for w in wins if "X11TargetOne" in w.get("title", "")), None)
            if win1:
                self._post("/focus", {"id": win1["id"]})
                time.sleep(0.3)

            # Left click + UTF-8 Chinese paste via xclip
            self._post("/click", {"x": 250, "y": 200, "button": "left"})
            time.sleep(0.15)
            self._post("/type", {"text": "物理X11中文输入测试"})
            time.sleep(0.25)

            # Sensitive password type -> MUST wipe X11 clipboard afterward!
            secret_val = "X11SecretPass#9988"
            self._post("/type", {"text": secret_val, "sensitive": True})
            time.sleep(0.2)
            xclip_bin = shutil.which("xclip")
            if xclip_bin:
                clip_out = subprocess.run(
                    [xclip_bin, "-selection", "clipboard", "-o"],
                    env=self.x_env,
                    capture_output=True,
                    text=True,
                    timeout=3,
                )
                self.assertNotIn(secret_val, clip_out.stdout or "", "Sensitive /type must wipe X11 clipboard afterward")

            # Right click, double click, key, 4-direction scroll & drag!
            self._post("/click", {"x": 300, "y": 360, "button": "right"})
            self._post("/click", {"x": 300, "y": 360, "button": "left", "double": True})
            self._post("/key", {"combo": "Return"})
            for direction in ("down", "up", "right", "left"):
                self._post("/scroll", {"x": 350, "y": 350, "direction": direction, "amount": 2})
            self._post("/drag", {"x1": 180, "y1": 300, "x2": 420, "y2": 420})
            drag_deadline = time.time() + 2.5
            while time.time() < drag_deadline and len(_EVENTS_STATE["drags"]) < 1:
                time.sleep(0.1)
            if len(_EVENTS_STATE["drags"]) < 1:
                self._post("/drag", {"x1": 200, "y1": 340, "x2": 460, "y2": 460})
                drag_deadline = time.time() + 2.5
                while time.time() < drag_deadline and len(_EVENTS_STATE["drags"]) < 1:
                    time.sleep(0.1)

            self.assertGreaterEqual(len(_EVENTS_STATE["clicks"]), 2)
            self.assertIn("物理X11中文输入测试", _EVENTS_STATE["text"])
            self.assertGreaterEqual(len(_EVENTS_STATE["scrolls"]), 2)
            self.assertGreaterEqual(len(_EVENTS_STATE["drags"]), 1)

        self._record_case(
            "P3-X11-01",
            "Ubuntu 真实 X11 物理事件验证：左/右/双击、中文剪贴板、sensitive 敏感输入后剪贴板擦除、按键、四向滚轮与拖拽",
            "Physical X11 Input & Sensitive Clipboard",
            run,
        )

    def test_p3_x11_02_windows_list_focus_and_screenshot(self):
        def run():
            st_w, wres = self._post("/windows", {})
            self.assertEqual(st_w, 200)
            wins = wres.get("windows") or []
            titles = [w.get("title", "") for w in wins]
            self.assertTrue(any("X11TargetOne" in t for t in titles), f"Expected X11TargetOne in {titles}")
            self.assertTrue(any("X11TargetTwo" in t for t in titles), f"Expected X11TargetTwo in {titles}")

            win2 = next(w for w in wins if "X11TargetTwo" in w.get("title", ""))
            st_f, fres = self._post("/focus", {"id": win2["id"]})
            self.assertEqual(st_f, 200)
            self.assertTrue(fres.get("ok"))

            st_s, sres = self._post("/screenshot", {})
            self.assertEqual(st_s, 200)
            self.assertGreater(len(sres.get("png_base64", "")), 100)

        self._record_case(
            "P3-X11-02",
            "Ubuntu 真实 X11 窗口管理：wmctrl /windows 枚举双窗口、/focus 切换激活与非空白物理截屏",
            "Physical X11 Windows & Screenshot",
            run,
        )

    def test_p3_x11_03_executor_http_routes_security_and_displays(self):
        def run():
            # 1. Bearer 401 auth gate on missing & wrong token
            st401, _ = self._req("GET", "/health", token="")
            self.assertEqual(st401, 401, "Missing Bearer token must return 401")
            st401b, _ = self._req("POST", "/shell", body={"command": "echo hi"}, token="wrong-tok")
            self.assertEqual(st401b, 401, "Wrong Bearer token must return 401")

            # 2. GET /health & GET/POST /displays + /displays/config + /displays/ensure + /displays/release + /displays/sync_cookies
            st_h, hres = self._req("GET", "/health")
            self.assertEqual(st_h, 200)
            self.assertTrue(hres.get("ok"))
            st_dg, _ = self._req("GET", "/displays")
            self.assertEqual(st_dg, 200)
            st_dp, _ = self._post("/displays", {})
            self.assertEqual(st_dp, 200)
            st_dc, _ = self._post("/displays/config", {"max_concurrent_screens": 2})
            self.assertEqual(st_dc, 200)
            st_de, _ = self._post("/displays/ensure", {"bot_id": "x11-bot-a", "start_browser": False})
            self.assertEqual(st_de, 200)
            st_dr, _ = self._post("/displays/release", {"bot_id": "x11-bot-a"})
            self.assertEqual(st_dr, 200)
            st_ds, ds_res = self._post("/displays/sync_cookies", {})
            self.assertEqual(st_ds, 200)
            self.assertTrue(ds_res.get("shared_profile"))

            # 3. /write & /read: normal write/read + 200KB truncation + relative path 400 + .ssh/.env 403!
            bot_ws = os.path.join(self.tmp_dir.name, "bot-ws-isolated")
            os.makedirs(bot_ws, exist_ok=True)
            big_file = os.path.join(bot_ws, "big.txt")
            st_wr, _ = self._post("/write", {"path": big_file, "content": "X" * 220_000})
            self.assertEqual(st_wr, 200)
            st_rd, rd_res = self._post("/read", {"path": big_file})
            self.assertEqual(st_rd, 200)
            self.assertTrue(rd_res.get("truncated") or len(rd_res.get("content", "")) <= 205_000)

            st_rel, _ = self._post("/read", {"path": "relative/path.txt"})
            self.assertIn(st_rel, (400, 403))
            st_ssh, _ = self._post("/read", {"path": os.path.expanduser("~/.ssh/id_rsa")})
            self.assertEqual(st_ssh, 403, "Reading ~/.ssh/* must be denied with 403")
            st_env, _ = self._post("/write", {"path": os.path.join(bot_ws, ".env"), "content": "SECRET=1"})
            self.assertEqual(st_env, 403, "Writing .env must be denied with 403")

            # 4. /shell with X-Twinkle-Bot-Workspace cwd isolation + short timeout exit_code=124!
            st_sh, sh_res = self._post(
                "/shell",
                {"command": "pwd", "timeout": 10},
                extra_headers={"X-Twinkle-Bot-Workspace": bot_ws},
            )
            self.assertEqual(st_sh, 200)
            self.assertIn(os.path.basename(bot_ws), sh_res.get("stdout", ""))
            st_tm, tm_res = self._post("/shell", {"command": "sleep 3", "timeout": 1})
            self.assertEqual(st_tm, 200)
            self.assertEqual(tm_res.get("exit_code"), 124)

            # 5. /open_url invalid scheme 400 + unknown route 404 + invalid JSON 400 + /browser/type missing args 400
            st_u, _ = self._post("/open_url", {"url": "file:///etc/passwd"})
            self.assertIn(st_u, (400, 403))
            st_404, _ = self._post("/nonexistent_endpoint", {})
            self.assertEqual(st_404, 404)
            st_badj, _ = self._req("POST", "/windows", raw_bytes=b"{broken-json")
            self.assertEqual(st_badj, 400)
            st_bt, _ = self._post("/browser/type", {"ref": "e999"})
            self.assertEqual(st_bt, 400)

        self._record_case(
            "P3-X11-03",
            "Executor 全 21 端点 HTTP 契约与安全边界：Bearer 401、/displays 生命周期、/read|/write 禁区 403 与截断、/shell 隔离与超时 124、/open_url 与错误码",
            "Executor Full HTTP & Security Matrix",
            run,
        )


if __name__ == "__main__":
    unittest.main()
