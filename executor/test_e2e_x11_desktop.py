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
import urllib.request

try:
    from executor import Actions, make_server
except ImportError:
    from executor.executor import Actions, make_server

RUN_X11_E2E = os.environ.get("TWINKLEBOT_RUN_CHROME_E2E", "") == "1"


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _find_free_display() -> int:
    for disp in range(95, 130):
        if not os.path.exists(f"/tmp/.X{disp}-lock") and not os.path.exists(f"/tmp/.X11-unix/X{disp}"):
            return disp
    raise RuntimeError("No free X11 display in :95..:129")


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


_EVENTS_STATE = {"clicks": [], "scrolls": [], "keys": [], "drags": [], "text": ""}


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
  html, body {{ margin: 0; padding: 0; width: 100vw; height: 2200px; background: #fff; font-family: sans-serif; }}
  #inp {{ position: fixed; left: 40px; top: 20px; width: 600px; height: 180px; font-size: 20px; border: 3px solid #2563eb; }}
  #pad {{ position: fixed; left: 40px; top: 220px; width: 600px; height: 400px; background: #e2e8f0; border: 2px solid #334155; }}
</style></head>
<body>
  <input id="inp" type="text" autofocus />
  <div id="pad">X11 Event Target ({title})</div>
  <script>
    function report(kind, data) {{
      fetch('/ev', {{ method: 'POST', headers: {{'Content-Type':'application/json'}}, body: JSON.stringify({{ kind, data }}) }});
    }}
    let downPt = null;
    window.addEventListener('mousedown', (e) => {{ downPt = {{ x: e.clientX, y: e.clientY, b: e.button }}; report('click', {{ button: e.button, x: e.clientX, y: e.clientY }}); }});
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
        cls.procs.append(subprocess.Popen(x_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))

        for _ in range(50):
            if os.path.exists(f"/tmp/.X11-unix/X{cls.disp_num}"):
                break
            time.sleep(0.1)

        cls.x_env = {**os.environ, "DISPLAY": cls.disp}
        for pk in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "TWINKLE_PROXY"):
            cls.x_env.pop(pk, None)

        # Start real window manager (xfwm4 or openbox) so wmctrl -l / -i -a work!
        wm_bin = shutil.which("xfwm4") or shutil.which("openbox")
        if wm_bin:
            cls.procs.append(subprocess.Popen([wm_bin], env=cls.x_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))
            time.sleep(0.5)

        cls.target_srv = _Srv(("127.0.0.1", 0), _X11TargetHandler)
        threading.Thread(target=cls.target_srv.serve_forever, daemon=True).start()
        cls.target_base = f"http://127.0.0.1:{cls.target_srv.server_address[1]}"

        # Launch two Chrome app windows for P3-X11-01 & P3-X11-02
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
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            )
            time.sleep(1.2)

        cls.token = "x11-e2e-tok"
        cls.actions = Actions(browser=cls.chrome_bin, display=cls.disp)
        cls.exec_srv = make_server(cls.actions, cls.token, host="127.0.0.1", port=0)
        threading.Thread(target=cls.exec_srv.serve_forever, daemon=True).start()
        cls.exec_base = f"http://127.0.0.1:{cls.exec_srv.server_address[1]}"

        # Wait up to 8s for the window manager + both Chrome windows to register titles
        if wm_bin:
            for _ in range(40):
                try:
                    wins = cls.actions.windows().get("windows") or []
                    titles = [w.get("title", "") for w in wins]
                    if any("X11TargetOne" in t for t in titles) and any("X11TargetTwo" in t for t in titles):
                        break
                except Exception:
                    pass
                time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
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
        for p in getattr(cls, "procs", []):
            try:
                if p.poll() is None:
                    os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        try:
            cls.tmp_dir.cleanup()
        except Exception:
            pass

    def _post(self, route: str, body: dict):
        req = urllib.request.Request(
            f"{self.exec_base}{route}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def test_p3_x11_01_physical_click_type_key_scroll_drag(self):
        # Focus X11TargetOne window first
        st_w, wres = self._post("/windows", {})
        self.assertEqual(st_w, 200)
        wins = wres.get("windows") or []
        win1 = next((w for w in wins if "X11TargetOne" in w.get("title", "")), None)
        if win1:
            self._post("/focus", {"id": win1["id"]})
            time.sleep(0.3)

        # Click inside input box (x=250, y=200 accounts for xfwm4/Chrome titlebar), type UTF-8 Chinese text via xclip + ctrl+v
        self._post("/click", {"x": 250, "y": 200, "button": "left"})
        time.sleep(0.15)
        self._post("/type", {"text": "物理X11中文输入测试"})
        time.sleep(0.25)

        # Press key, scroll down, drag inside pad
        self._post("/key", {"combo": "Return"})
        self._post("/scroll", {"x": 350, "y": 350, "direction": "down", "amount": 3})
        self._post("/drag", {"x1": 180, "y1": 300, "x2": 420, "y2": 420})
        time.sleep(0.3)

        self.assertGreaterEqual(len(_EVENTS_STATE["clicks"]), 1)
        self.assertIn("物理X11中文输入测试", _EVENTS_STATE["text"])
        self.assertGreaterEqual(len(_EVENTS_STATE["scrolls"]), 1)
        self.assertGreaterEqual(len(_EVENTS_STATE["drags"]), 1)

    def test_p3_x11_02_windows_list_focus_and_screenshot(self):
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


if __name__ == "__main__":
    unittest.main()
