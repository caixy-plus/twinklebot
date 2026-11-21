import http.cookies
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
import urllib.parse
import urllib.request

try:
    from executor import (
        Actions,
        TabManager,
        fetch_cdp_browser_ws,
        fetch_cdp_targets,
        make_server,
    )
except ImportError:
    from executor.executor import (
        Actions,
        TabManager,
        fetch_cdp_browser_ws,
        fetch_cdp_targets,
        make_server,
    )


RUN_CHROME_E2E = os.environ.get("TWINKLEBOT_RUN_CHROME_E2E", "") == "1"


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _find_free_display() -> int:
    for disp in range(95, 130):
        lock_file = f"/tmp/.X{disp}-lock"
        sock_file = f"/tmp/.X11-unix/X{disp}"
        if not os.path.exists(lock_file) and not os.path.exists(sock_file):
            return disp
    raise RuntimeError("No free X11 display number available in :95..:129")


def _find_official_chrome_binary() -> str:
    explicit = os.environ.get("TWINKLEBOT_E2E_CHROME_BIN", "").strip()
    if explicit and os.path.isfile(explicit) and os.access(explicit, os.X_OK):
        return explicit
    for cand in ("/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    for name in ("google-chrome-stable", "google-chrome"):
        resolved = shutil.which(name)
        if resolved:
            return resolved
    return ""


class _FixtureHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_html(self, status: int, html: str, extra_headers=None):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/login":
            self._send_html(
                200,
                """<!doctype html>
<html><head><title>Login Fixture</title></head>
<body>
  <h1>TwinkleBot Login</h1>
  <form id="login-form" onsubmit="event.preventDefault(); doLogin();">
    <input id="user-input" type="text" placeholder="Username" />
    <input id="pass-input" type="password" placeholder="Password" />
    <button id="login-btn" type="submit">Sign In</button>
  </form>
  <script>
    async function doLogin() {
      const u = document.getElementById('user-input').value;
      const p = document.getElementById('pass-input').value;
      const resp = await fetch('/do-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: u, pass: p })
      });
      if (resp.ok) {
        localStorage.setItem('twinkle_user', u);
        location.href = '/whoami';
      }
    }
  </script>
</body></html>""",
            )
            return

        if path == "/whoami":
            raw_cookie = self.headers.get("Cookie", "")
            c = http.cookies.SimpleCookie()
            c.load(raw_cookie)
            sid = c["twinkle_sid"].value if "twinkle_sid" in c else "MISSING_COOKIE"
            self._send_html(
                200,
                f"""<!doctype html>
<html><head><title>WhoAmI</title></head>
<body>
  <div id="server-cookie">COOKIE:{sid}</div>
  <div id="ls-user">LS:PENDING</div>
  <script>
    document.getElementById('ls-user').textContent = 'LS:' + (localStorage.getItem('twinkle_user') || 'MISSING_LS');
  </script>
</body></html>""",
            )
            return

        if path == "/popup-host":
            self._send_html(
                200,
                """<!doctype html>
<html><head><title>Popup Host</title></head>
<body>
  <h1>Popup Host Page</h1>
  <a id="blank-link" href="/popup-dest" target="_blank">Open Blank Dest</a>
</body></html>""",
            )
            return

        if path == "/popup-dest":
            self._send_html(
                200,
                """<!doctype html>
<html><head><title>Popup Dest</title></head>
<body>
  <h1>POPUP_DEST_LOADED</h1>
</body></html>""",
            )
            return

        if path.startswith("/workspace/"):
            slot = path.split("/")[-1]
            self._send_html(
                200,
                f"""<!doctype html>
<html><head><title>Workspace {slot}</title></head>
<body>
  <h1>Workspace {slot}</h1>
  <input id="work-input" type="text" placeholder="Task for {slot}" />
  <button id="work-btn" type="button" onclick="saveWork()">Save {slot}</button>
  <div id="work-out">EMPTY_{slot}</div>
  <script>
    function saveWork() {{
      const v = document.getElementById('work-input').value;
      document.getElementById('work-out').textContent = 'SAVED_{slot}:' + v;
    }}
  </script>
</body></html>""",
            )
            return

        self._send_html(404, "<h1>Not Found</h1>")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/do-login":
            self._send_html(404, "<h1>Not Found</h1>")
            return
        cl = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(cl) if cl > 0 else b"{}"
        data = json.loads(raw.decode("utf-8"))
        ok = data.get("user") == "alice" and data.get("pass") == "s3cr3t-pass"
        payload = json.dumps({"ok": ok}).encode("utf-8")
        self.send_response(200 if ok else 401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if ok:
            self.send_header(
                "Set-Cookie",
                "twinkle_sid=shared-ok-999; HttpOnly; Path=/; SameSite=Lax",
            )
        self.end_headers()
        self.wfile.write(payload)


class _FixtureServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


@unittest.skipUnless(RUN_CHROME_E2E, "Set TWINKLEBOT_RUN_CHROME_E2E=1 to run real Google Chrome X11 E2E tests")
class TestRealGoogleChromeMultiTabE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chrome_bin = _find_official_chrome_binary()
        if not cls.chrome_bin:
            raise RuntimeError(
                "Official Google Chrome (/usr/bin/google-chrome-stable or /usr/bin/google-chrome) is required for E2E"
            )

        xvfb_bin = shutil.which("Xvfb")
        tiger_bin = shutil.which("Xtigervnc")
        if not xvfb_bin and not tiger_bin:
            raise RuntimeError("Xvfb or Xtigervnc is required to run real X11 Google Chrome E2E tests")

        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="tb-chrome-e2e-")
        cls.primary_profile_dir = os.path.join(cls.tmp_dir.name, "chrome-profile")
        cls.map_path = os.path.join(cls.tmp_dir.name, "display-map.json")
        os.makedirs(cls.primary_profile_dir, exist_ok=True)

        cls.disp_num = _find_free_display()
        cls.display_str = f":{cls.disp_num}"
        if xvfb_bin:
            x_cmd = [xvfb_bin, cls.display_str, "-screen", "0", "1440x900x24", "-ac", "+extension", "GLX", "+render", "-noreset"]
        else:
            rfb_port = _find_free_port()
            x_cmd = [
                tiger_bin,
                cls.display_str,
                "-geometry",
                "1440x900",
                "-depth",
                "24",
                "-SecurityTypes",
                "None",
                "-localhost",
                "yes",
                "-rfbport",
                str(rfb_port),
            ]
        cls.x_proc = subprocess.Popen(
            x_cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

        # Wait for X11 display readiness
        x_env = {**os.environ, "DISPLAY": cls.display_str}
        ready = False
        for _ in range(50):
            if os.path.exists(f"/tmp/.X11-unix/X{cls.disp_num}"):
                if shutil.which("xdpyinfo"):
                    probe = subprocess.run(
                        ["xdpyinfo", "-display", cls.display_str],
                        env=x_env,
                        capture_output=True,
                    )
                    if probe.returncode == 0:
                        ready = True
                        break
                else:
                    ready = True
                    break
            time.sleep(0.1)
        if not ready:
            raise RuntimeError(f"Virtual X11 display {cls.display_str} failed to become ready")

        # Start local login + workspace fixture HTTP server
        cls.fixture_srv = _FixtureServer(("127.0.0.1", 0), _FixtureHandler)
        cls.fixture_thread = threading.Thread(target=cls.fixture_srv.serve_forever, daemon=True)
        cls.fixture_thread.start()
        cls.fixture_base = f"http://127.0.0.1:{cls.fixture_srv.server_address[1]}"

        # Track spawned Chrome processes for guaranteed cleanup
        cls.cdp_port = _find_free_port()
        cls.spawned_procs = []

        def tracked_spawn(argv, **kwargs):
            # Ensure fixture 127.0.0.1 traffic never bypasses through external proxy during E2E
            env = dict(kwargs.get("env") or {})
            for pk in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "TWINKLE_PROXY"):
                env.pop(pk, None)
            kwargs["env"] = env
            proc = subprocess.Popen(argv, **kwargs)
            cls.spawned_procs.append(proc)
            return proc

        cls.dm = TabManager(
            map_path=cls.map_path,
            primary_profile_dir=cls.primary_profile_dir,
            max_concurrent_screens=2,
            browser_idle_sec=300,
            browser_boot_timeout_sec=30.0,
            cdp_port=cls.cdp_port,
            display=cls.display_str,
            spawn_fn=tracked_spawn,
            browser_bin=cls.chrome_bin,
        )
        cls.token = "e2e-exec-token"
        cls.actions = Actions(
            browser=cls.chrome_bin,
            display=cls.display_str,
            cdp_port=cls.cdp_port,
            profile_dir=cls.primary_profile_dir,
        )
        cls.exec_srv = make_server(cls.actions, cls.token, host="127.0.0.1", port=0, display_manager=cls.dm)
        cls.exec_thread = threading.Thread(target=cls.exec_srv.serve_forever, daemon=True)
        cls.exec_thread.start()
        cls.exec_base = f"http://127.0.0.1:{cls.exec_srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        try:
            cls.exec_srv.shutdown()
            cls.exec_srv.server_close()
        except Exception:
            pass
        try:
            cls.fixture_srv.shutdown()
            cls.fixture_srv.server_close()
        except Exception:
            pass
        for p in getattr(cls, "spawned_procs", []):
            try:
                if p.poll() is None:
                    os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        try:
            if cls.x_proc.poll() is None:
                os.killpg(os.getpgid(cls.x_proc.pid), signal.SIGKILL)
        except Exception:
            try:
                cls.x_proc.kill()
            except Exception:
                pass
        try:
            cls.tmp_dir.cleanup()
        except Exception:
            pass

    def _req(self, path: str, body=None, bot_id: str = None, is_admin: bool = False):
        headers = {"Authorization": f"Bearer {self.token}"}
        if bot_id is not None:
            headers["X-Twinkle-Bot-Id"] = bot_id
        headers["X-Twinkle-Bot-Admin"] = "1" if is_admin else "0"
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            f"{self.exec_base}{path}",
            data=data,
            headers=headers,
            method="GET" if body is None else "POST",
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def _find_ref(self, snap: dict, *, tag: str = None, text_contains: str = None) -> str:
        for el in snap.get("elements") or []:
            if tag and el.get("tag") != tag:
                continue
            blob = f"{el.get('name', '')} {el.get('placeholder', '')}"
            if text_contains and text_contains not in blob:
                continue
            return el["ref"]
        raise AssertionError(f"Element not found in snapshot: tag={tag}, text={text_contains}, elements={snap.get('elements')}")

    def test_01_official_chrome_binary_and_unthrottled_flags(self):
        st, ensured = self._req("/displays/ensure", body={"bot_id": "bot-admin", "is_admin": True, "start_browser": True})
        self.assertEqual(st, 200)
        self.assertEqual(ensured["profile_dir"], self.primary_profile_dir)
        self.assertIsNotNone(ensured["target_id"])

        with urllib.request.urlopen(f"http://127.0.0.1:{self.cdp_port}/json/version", timeout=4.0) as resp:
            ver = json.loads(resp.read().decode("utf-8"))
        self.assertIn("Chrome/", ver.get("Browser", ""))

        self.assertGreaterEqual(len(self.spawned_procs), 1)
        pid = self.spawned_procs[0].pid
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read().decode("utf-8", errors="ignore")
        self.assertIn(f"--user-data-dir={self.primary_profile_dir}", cmdline)
        self.assertIn("--disable-background-timer-throttling", cmdline)
        self.assertIn("--disable-backgrounding-occluded-windows", cmdline)
        self.assertIn("--disable-renderer-backgrounding", cmdline)

    def test_02_shared_primary_profile_login_across_bots(self):
        # Bot-Admin logs into the fixture site in Tab 1
        st, snap = self._req(
            "/browser/snapshot",
            body={"url": f"{self.fixture_base}/login"},
            bot_id="bot-admin",
            is_admin=True,
        )
        self.assertEqual(st, 200)
        user_ref = self._find_ref(snap, tag="input", text_contains="Username")
        pass_ref = self._find_ref(snap, tag="input", text_contains="Password")

        self._req(
            "/browser/type",
            body={"ref": user_ref, "text": "alice", "submit": False, "clear": True},
            bot_id="bot-admin",
            is_admin=True,
        )
        self._req(
            "/browser/type",
            body={"ref": pass_ref, "text": "s3cr3t-pass", "submit": False, "clear": True},
            bot_id="bot-admin",
            is_admin=True,
        )
        snap2 = self._req("/browser/snapshot", body={}, bot_id="bot-admin", is_admin=True)[1]
        btn_ref = self._find_ref(snap2, tag="button", text_contains="Sign In")
        self._req("/browser/click", body={"ref": btn_ref}, bot_id="bot-admin", is_admin=True)

        # Wait briefly for redirect & localStorage write
        whoami_admin = {}
        for _ in range(15):
            whoami_admin = self._req("/browser/snapshot", body={}, bot_id="bot-admin", is_admin=True)[1]
            if "COOKIE:shared-ok-999" in whoami_admin.get("text_excerpt", "") and "LS:alice" in whoami_admin.get("text_excerpt", ""):
                break
            time.sleep(0.15)
        self.assertIn("COOKIE:shared-ok-999", whoami_admin.get("text_excerpt", ""))
        self.assertIn("LS:alice", whoami_admin.get("text_excerpt", ""))

        # Bot-2 opens a BRAND NEW tab in the same Chrome instance and immediately shares login state!
        st2, whoami_bot2 = self._req(
            "/browser/snapshot",
            body={"url": f"{self.fixture_base}/whoami"},
            bot_id="bot-second",
            is_admin=False,
        )
        self.assertEqual(st2, 200)
        self.assertIn("COOKIE:shared-ok-999", whoami_bot2.get("text_excerpt", ""))
        self.assertIn("LS:alice", whoami_bot2.get("text_excerpt", ""))
        self.assertNotEqual(
            self.dm.peek_bound_target_id("bot-admin", is_admin=True),
            self.dm.peek_bound_target_id("bot-second", is_admin=False),
        )

    def test_03_concurrent_multi_tab_dom_isolation_without_cross_talk(self):
        # Navigate Bot-Admin -> /workspace/alpha, Bot-2 -> /workspace/beta
        snap_a = self._req(
            "/browser/snapshot",
            body={"url": f"{self.fixture_base}/workspace/alpha"},
            bot_id="bot-admin",
            is_admin=True,
        )[1]
        snap_b = self._req(
            "/browser/snapshot",
            body={"url": f"{self.fixture_base}/workspace/beta"},
            bot_id="bot-second",
            is_admin=False,
        )[1]

        results = {}
        errors = []

        def worker(bot_id: str, is_admin: bool, snap: dict, slot: str, value: str):
            try:
                inp_ref = self._find_ref(snap, tag="input", text_contains=f"Task for {slot}")
                btn_ref = self._find_ref(snap, tag="button", text_contains=f"Save {slot}")
                self._req(
                    "/browser/type",
                    body={"ref": inp_ref, "text": value, "submit": False, "clear": True},
                    bot_id=bot_id,
                    is_admin=is_admin,
                )
                clicked = self._req(
                    "/browser/click",
                    body={"ref": btn_ref},
                    bot_id=bot_id,
                    is_admin=is_admin,
                )[1]
                results[bot_id] = clicked
            except Exception as e:
                errors.append((bot_id, e))

        t1 = threading.Thread(target=worker, args=("bot-admin", True, snap_a, "alpha", "VAL_ALPHA_111"))
        t2 = threading.Thread(target=worker, args=("bot-second", False, snap_b, "beta", "VAL_BETA_222"))
        t1.start()
        t2.start()
        t1.join(timeout=20)
        t2.join(timeout=20)

        self.assertEqual(errors, [])
        self.assertIn("SAVED_alpha:VAL_ALPHA_111", results["bot-admin"].get("text_excerpt", ""))
        self.assertNotIn("VAL_BETA_222", results["bot-admin"].get("text_excerpt", ""))
        self.assertIn("SAVED_beta:VAL_BETA_222", results["bot-second"].get("text_excerpt", ""))
        self.assertNotIn("VAL_ALPHA_111", results["bot-second"].get("text_excerpt", ""))

    def test_04_tab_pool_cap_idle_eviction_url_restore_and_zero_tab_guard(self):
        # Ensure bot-admin and bot-second occupy the 2 concurrent slots; simulate bot-second idle at /workspace/beta
        self._req(
            "/browser/snapshot",
            body={"url": f"{self.fixture_base}/workspace/beta"},
            bot_id="bot-second",
            is_admin=False,
        )
        # Hold both tabs briefly via acquire_bot_tab in background to verify FIFO queue when full
        t_a = self.dm.acquire_bot_tab("bot-admin", is_admin=True)
        t_b = self.dm.acquire_bot_tab("bot-second", is_admin=False)

        queued_res = {}
        started = threading.Event()

        def waiter():
            started.set()
            queued_res["snap"] = self._req(
                "/browser/snapshot",
                body={"url": f"{self.fixture_base}/workspace/gamma"},
                bot_id="bot-third",
                is_admin=False,
            )[1]

        wt = threading.Thread(target=waiter, daemon=True)
        wt.start()
        started.wait(1.0)
        time.sleep(0.25)
        self.assertNotIn("snap", queued_res, "3rd Bot must queue while 2 tabs are actively in-flight")

        self.dm.release_bot_tab_in_flight(t_b["bot_key"])
        wt.join(timeout=20)
        self.dm.release_bot_tab_in_flight(t_a["bot_key"])

        self.assertIn("Workspace gamma", queued_res.get("snap", {}).get("text_excerpt", ""))
        # Chrome must remain alive and <= max_concurrent_screens Bot tabs
        self.assertIsNotNone(fetch_cdp_browser_ws(port=self.cdp_port, timeout=2.0))
        self.assertIsNone(self.dm.peek_bound_target_id("bot-second", is_admin=False))

        # Re-wake evicted bot-second via /displays/ensure -> must restore its previous URL (/workspace/beta)
        _, woken = self._req("/displays/ensure", body={"bot_id": "bot-second", "is_admin": False, "start_browser": True})
        self.assertIn("/workspace/beta", woken.get("tab_url", ""))
        snap_restored = {}
        for _ in range(15):
            snap_restored = self._req("/browser/snapshot", body={}, bot_id="bot-second", is_admin=False)[1]
            if "/workspace/beta" in snap_restored.get("url", ""):
                break
            time.sleep(0.15)
        self.assertIn("/workspace/beta", snap_restored.get("url", ""))
        self.assertIn("Workspace beta", snap_restored.get("text_excerpt", ""))

        # Releasing bot-second closes its tab without harming Primary Profile or Chrome process
        _, rel = self._req("/displays/release", body={"bot_id": "bot-second"})
        self.assertTrue(rel.get("released"))
        self.assertIsNotNone(fetch_cdp_browser_ws(port=self.cdp_port, timeout=2.0))
        pages_after = [
            t for t in fetch_cdp_targets(port=self.cdp_port, timeout=2.0) if t.get("type") == "page"
        ]
        self.assertGreaterEqual(len(pages_after), 1)
        self.assertTrue(os.path.isdir(os.path.join(self.primary_profile_dir, "Default")))

    def test_05_physical_x11_screenshot_and_cli_bypass(self):
        # X11 /screenshot focuses target Bot tab and returns valid PNG on :95+
        self.assertIsNotNone(shutil.which("import"), "imagemagick 'import' is required for X11 screenshot E2E")
        st_shot, shot = self._req("/screenshot", body={}, bot_id="bot-admin", is_admin=True)
        self.assertEqual(st_shot, 200)
        self.assertIn("png_base64", shot)
        self.assertGreater(len(shot["png_base64"]), 100)

        # CLI /shell and /write + /read never allocate a Chrome tab for an unbound Bot
        st_sh, sh = self._req("/shell", body={"command": "echo e2e-cli-ok"}, bot_id="bot-cli-only", is_admin=False)
        self.assertEqual(st_sh, 200)
        self.assertIn("e2e-cli-ok", sh.get("stdout", ""))
        self.assertIsNone(self.dm.peek_bound_target_id("bot-cli-only", is_admin=False))

        target_file = os.path.join(self.tmp_dir.name, "cli-note.txt")
        self._req("/write", body={"path": target_file, "content": "hello-chrome-e2e"}, bot_id="bot-cli-only", is_admin=False)
        st_rd, rd = self._req("/read", body={"path": target_file}, bot_id="bot-cli-only", is_admin=False)
        self.assertEqual(st_rd, 200)
        self.assertEqual(rd.get("content"), "hello-chrome-e2e")

    def test_06_per_bot_dedicated_window_multi_tab_and_blank_popup(self):
        # 1. Admin & worker each own distinct real Chrome windowIds via CDP Browser.getWindowForTarget
        _, a_ens = self._req("/displays/ensure", body={"bot_id": "bot-admin", "is_admin": True, "start_browser": True})
        _, b_ens = self._req("/displays/ensure", body={"bot_id": "bot-win-test", "is_admin": False, "start_browser": True})
        a_wid = a_ens.get("window_id")
        b_wid = b_ens.get("window_id")
        self.assertIsNotNone(a_wid)
        self.assertIsNotNone(b_wid)
        self.assertNotEqual(a_wid, b_wid, "Each Bot must own a distinct Chrome windowId")

        # 2. Worker opens /popup-host and clicks a target="_blank" link -> auto-switches to popup in SAME windowId
        st_snap, snap = self._req(
            "/browser/snapshot",
            body={"url": f"{self.fixture_base}/popup-host"},
            bot_id="bot-win-test",
            is_admin=False,
        )
        self.assertEqual(st_snap, 200)
        link_el = next((e for e in snap.get("elements", []) if "Open Blank Dest" in (e.get("name") or "")), None)
        self.assertIsNotNone(link_el, f"target=_blank link missing: {snap}")

        st_clk, clk = self._req(
            "/browser/click",
            body={"ref": link_el["ref"]},
            bot_id="bot-win-test",
            is_admin=False,
        )
        self.assertEqual(st_clk, 200)
        self.assertTrue(clk.get("switched_to_new_tab"), f"Expected auto-switch to new tab: {clk}")
        self.assertIn("POPUP_DEST_LOADED", clk.get("text_excerpt", ""))
        self.assertGreaterEqual(clk.get("tab_count", 0), 2)

        # 3. /browser/tabs(new/list/switch/close) stays strictly inside bot-win-test's windowId
        st_new, new_tab = self._req(
            "/browser/tabs",
            body={"action": "new", "url": f"{self.fixture_base}/workspace/multi"},
            bot_id="bot-win-test",
            is_admin=False,
        )
        self.assertEqual(st_new, 200)
        self.assertEqual(new_tab.get("window_id"), b_wid)
        self.assertEqual(new_tab.get("tab_count"), 3)

        # Admin window still only has its own tab(s) and NOT bot-win-test's tabs
        st_alist, alist = self._req("/browser/tabs", body={"action": "list"}, bot_id="bot-admin", is_admin=True)
        self.assertEqual(st_alist, 200)
        self.assertEqual(alist.get("window_id"), a_wid)
        admin_tids = {x["target_id"] for x in alist.get("tabs", [])}
        self.assertNotIn(new_tab.get("target_id"), admin_tids)

        # Switch back to /popup-host by its listed index and close the extra tab
        host_entry = next((x for x in new_tab.get("tabs", []) if "/popup-host" in (x.get("url") or "")), None)
        self.assertIsNotNone(host_entry, f"Expected /popup-host in window tabs: {new_tab}")
        st_sw, sw = self._req(
            "/browser/tabs",
            body={"action": "switch", "index": host_entry["index"]},
            bot_id="bot-win-test",
            is_admin=False,
        )
        self.assertEqual(st_sw, 200)
        self.assertIn("/popup-host", sw.get("url", ""))

        st_cl, cl = self._req(
            "/browser/tabs",
            body={"action": "close", "target_id": new_tab["target_id"]},
            bot_id="bot-win-test",
            is_admin=False,
        )
        self.assertEqual(st_cl, 200)
        self.assertEqual(cl.get("tab_count"), 2)

        # 4. Releasing bot-win-test closes ALL remaining tabs in its window in one shot without harming bot-admin
        _, rel = self._req("/displays/release", body={"bot_id": "bot-win-test"})
        self.assertTrue(rel.get("released"))
        self.assertGreaterEqual(rel.get("closed_tabs", 0), 2)
        st_alist2, alist2 = self._req("/browser/tabs", body={"action": "list"}, bot_id="bot-admin", is_admin=True)
        self.assertEqual(st_alist2, 200)
        self.assertGreaterEqual(alist2.get("tab_count", 0), 1)


if __name__ == "__main__":
    unittest.main()
