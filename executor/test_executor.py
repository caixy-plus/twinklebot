import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

try:
    from executor import (
        Actions,
        DEFAULT_BROWSER,
        DisplayManager,
        TabManager,
        _default_tcp_open,
        _read_proc_listening_ports,
        cdp_ws_call,
        close_redundant_blank_tabs,
        display_resources,
        make_server,
        normalize_element_ref,
        select_cdp_page_target,
    )
except ImportError:
    from executor.executor import (
        Actions,
        DEFAULT_BROWSER,
        DisplayManager,
        TabManager,
        _default_tcp_open,
        _read_proc_listening_ports,
        cdp_ws_call,
        close_redundant_blank_tabs,
        display_resources,
        make_server,
        normalize_element_ref,
        select_cdp_page_target,
    )


class FakeRun:
    def __init__(self, stdout=b"", returncode=0):
        self.calls = []
        self.stdout = stdout
        self.returncode = returncode

    def __call__(self, argv, input=None, timeout=30):
        self.calls.append((argv, input))
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, b"")


class TestActions(unittest.TestCase):
    def test_click_maps_left_button(self):
        run = FakeRun()
        Actions(run).click(10, 20, button="left")
        self.assertEqual(run.calls[-1][0], ["xdotool", "mousemove", "10", "20", "click", "1"])

    def test_click_maps_right_button(self):
        run = FakeRun()
        Actions(run).click(10, 20, button="right")
        self.assertEqual(run.calls[-1][0], ["xdotool", "mousemove", "10", "20", "click", "3"])

    def test_click_maps_middle_button(self):
        run = FakeRun()
        Actions(run).click(10, 20, button="middle")
        self.assertEqual(run.calls[-1][0], ["xdotool", "mousemove", "10", "20", "click", "2"])

    def test_click_double(self):
        run = FakeRun()
        Actions(run).click(10, 20, button="left", double=True)
        self.assertEqual(run.calls[-1][0], ["xdotool", "mousemove", "10", "20", "click", "--repeat", "2", "1"])

    def test_click_rejects_out_of_screen(self):
        with self.assertRaises(ValueError):
            Actions(FakeRun()).click(1440, 10)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).click(-1, 10)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).click(10, 900)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).click(10, -1)

    def test_click_rejects_non_int(self):
        with self.assertRaises(ValueError):
            Actions(FakeRun()).click(True, 10)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).click(10, False)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).click("10", 20)

    def test_click_rejects_invalid_button(self):
        with self.assertRaises(ValueError):
            Actions(FakeRun()).click(10, 20, button="fourth")

    def test_type_text_uses_clipboard_utf8(self):
        run = FakeRun()
        Actions(run).type_text("你好🙂")
        self.assertEqual(run.calls[0], (["xclip", "-selection", "clipboard"], "你好🙂".encode("utf-8")))
        self.assertEqual(run.calls[1][0], ["xdotool", "key", "--clearmodifiers", "ctrl+v"])
        self.assertEqual(len(run.calls), 2)

    def test_type_text_sensitive_wipes_clipboard(self):
        run = FakeRun()
        Actions(run).type_text("S3cr3t!", sensitive=True)
        self.assertEqual(run.calls[0], (["xclip", "-selection", "clipboard"], b"S3cr3t!"))
        self.assertEqual(run.calls[1][0], ["xdotool", "key", "--clearmodifiers", "ctrl+v"])
        self.assertEqual(run.calls[2], (["xclip", "-selection", "clipboard"], b""))

    def test_type_text_rejects_non_string(self):
        with self.assertRaises((ValueError, TypeError)):
            Actions(FakeRun()).type_text(123)

    def test_key(self):
        run = FakeRun()
        Actions(run).key("ctrl+l")
        self.assertEqual(run.calls[-1][0], ["xdotool", "key", "--clearmodifiers", "ctrl+l"])

    def test_key_rejects_empty(self):
        with self.assertRaises(ValueError):
            Actions(FakeRun()).key("")

    def test_scroll(self):
        run = FakeRun()
        Actions(run).scroll(100, 200, direction="up", amount=3)
        self.assertEqual(run.calls[-1][0], ["xdotool", "mousemove", "100", "200", "click", "--repeat", "3", "4"])
        run = FakeRun()
        Actions(run).scroll(100, 200, direction="down", amount=5)
        self.assertEqual(run.calls[-1][0], ["xdotool", "mousemove", "100", "200", "click", "--repeat", "5", "5"])
        run = FakeRun()
        Actions(run).scroll(100, 200, direction="left", amount=1)
        self.assertEqual(run.calls[-1][0], ["xdotool", "mousemove", "100", "200", "click", "--repeat", "1", "6"])
        run = FakeRun()
        Actions(run).scroll(100, 200, direction="right", amount=2)
        self.assertEqual(run.calls[-1][0], ["xdotool", "mousemove", "100", "200", "click", "--repeat", "2", "7"])

    def test_scroll_validation(self):
        with self.assertRaises(ValueError):
            Actions(FakeRun()).scroll(1440, 10, "up")
        with self.assertRaises(ValueError):
            Actions(FakeRun()).scroll(10, 20, "diagonal")
        with self.assertRaises(ValueError):
            Actions(FakeRun()).scroll(10, 20, "up", amount=0)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).scroll(10, 20, "up", amount=21)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).scroll(10, 20, "up", amount="3")

    def test_drag(self):
        run = FakeRun()
        Actions(run).drag(10, 20, 100, 200)
        self.assertEqual(
            run.calls[-1][0],
            ["xdotool", "mousemove", "10", "20", "mousedown", "1", "mousemove", "100", "200", "mouseup", "1"],
        )

    def test_drag_validation(self):
        with self.assertRaises(ValueError):
            Actions(FakeRun()).drag(1440, 20, 100, 200)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).drag(10, 900, 100, 200)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).drag(10, 20, 1440, 200)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).drag(10, 20, 100, 900)
        with self.assertRaises(ValueError):
            Actions(FakeRun()).drag("10", 20, 100, 200)

    def test_screenshot(self):
        fake_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00"
        run = FakeRun(stdout=fake_png)
        res = Actions(run).screenshot()
        self.assertEqual(run.calls[-1][0], ["import", "-window", "root", "png:-"])
        self.assertEqual(res["width"], 1440)
        self.assertEqual(res["height"], 900)
        self.assertEqual(res["png_base64"], base64.b64encode(fake_png).decode("ascii"))

    def test_list_windows(self):
        wmctrl_out = b"0x00a00003 -1 ubuntu xfce4-panel\n0x01200003  0 ubuntu My Window\n"
        run = FakeRun(stdout=wmctrl_out)
        res = Actions(run).list_windows()
        self.assertEqual(run.calls[-1][0], ["wmctrl", "-l"])
        self.assertEqual(
            res["windows"],
            [
                {"id": "0x00a00003", "title": "xfce4-panel"},
                {"id": "0x01200003", "title": "My Window"},
            ],
        )

    def test_focus_window(self):
        run = FakeRun()
        res = Actions(run).focus_window("0x01200003")
        self.assertEqual(run.calls[-1][0], ["wmctrl", "-i", "-a", "0x01200003"])
        self.assertEqual(res, {"ok": True})

    def test_shell_success(self):
        run = FakeRun(stdout=b"hello\n")
        res = Actions(run).shell("echo hello")
        self.assertEqual(run.calls[-1][0], ["bash", "-lc", "echo hello"])
        self.assertEqual(res, {"exit_code": 0, "stdout": "hello\n", "stderr": "", "truncated": False})

    def test_shell_truncates_long_output(self):
        r = Actions(FakeRun(stdout=b"x" * 30000)).shell("yes")
        self.assertEqual(len(r["stdout"]), 20000)
        self.assertTrue(r["truncated"])

    def test_shell_timeout(self):
        def timeout_run(argv, input=None, timeout=30):
            raise subprocess.TimeoutExpired(argv, timeout)

        res = Actions(timeout_run).shell("sleep 200", timeout=120)
        self.assertEqual(res["exit_code"], 124)
        self.assertEqual(res["stderr"], "timed out after 120s")
        self.assertFalse(res["truncated"])

    def test_read_denies_ssh_env_and_auth_files(self):
        for p in [
            "/Users/YOUR_USERNAME/.ssh/id",
            "/home/YOUR_USERNAME/.ssh/x",
            "/tmp/a/.env",
            "/tmp/codex_oauth_auth.json",
        ]:
            with self.assertRaises(PermissionError):
                Actions(FakeRun()).read_file(p)

    def test_write_denies_ssh_env_and_auth_files(self):
        for p in [
            "/Users/YOUR_USERNAME/.ssh/id",
            "/home/YOUR_USERNAME/.ssh/x",
            "/tmp/a/.env",
            "/tmp/codex_oauth_auth.json",
        ]:
            with self.assertRaises(PermissionError):
                Actions(FakeRun()).write_file(p, "test")

    def test_read_truncates_large_file(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("y" * 250000)
        try:
            r = Actions(FakeRun()).read_file(f.name)
            self.assertEqual(len(r["content"]), 200000)
            self.assertTrue(r["truncated"])
        finally:
            os.unlink(f.name)

    def test_write_and_read_file(self):
        with tempfile.TemporaryDirectory() as td:
            target = os.path.join(td, "sub", "test.txt")
            w_res = Actions(FakeRun()).write_file(target, "hello world!")
            self.assertEqual(w_res, {"bytes": len("hello world!".encode("utf-8"))})
            r_res = Actions(FakeRun()).read_file(target)
            self.assertEqual(r_res, {"content": "hello world!", "truncated": False})

    def test_relative_paths_rejected(self):
        with self.assertRaises(ValueError):
            Actions(FakeRun()).write_file("a.txt", "x")
        with self.assertRaises(ValueError):
            Actions(FakeRun()).read_file("a.txt")

    def test_open_url_rejects_non_http(self):
        with self.assertRaises(ValueError):
            Actions(FakeRun()).open_url("file:///etc/passwd")
        with self.assertRaises(ValueError):
            Actions(FakeRun()).open_url("javascript:alert(1)")

    def test_open_url_spawns_browser(self):
        spawn_calls = []

        def fake_spawn(argv, start_new_session=False):
            spawn_calls.append((argv, start_new_session))
            return None

        act = Actions(FakeRun(), browser="/usr/bin/firefox", spawn=fake_spawn)
        res = act.open_url("https://example.com")
        self.assertEqual(res, {"ok": True})
        self.assertEqual(spawn_calls, [((["/usr/bin/firefox", "https://example.com"]), True)])

    def test_default_browser_is_official_google_chrome(self):
        old_env = os.environ.pop("TWINKLEBOT_BROWSER", None)
        try:
            act = Actions(FakeRun())
            self.assertEqual(act.browser, DEFAULT_BROWSER)
            self.assertEqual(DEFAULT_BROWSER, "/usr/local/bin/google-chrome")
        finally:
            if old_env is not None:
                os.environ["TWINKLEBOT_BROWSER"] = old_env

    def test_normalize_element_ref(self):
        self.assertEqual(normalize_element_ref("e1"), "e1")
        self.assertEqual(normalize_element_ref("[e12]"), "e12")
        self.assertEqual(normalize_element_ref("7"), "e7")
        for bad in ("", "   ", "btn1", "e-1", None):
            with self.assertRaises(ValueError):
                normalize_element_ref(bad)

    def test_select_cdp_page_target_prefers_real_page(self):
        targets = [
            {
                "type": "browser_ui",
                "url": "chrome://omnibox-popup.top-chrome/",
                "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/OMNI",
            },
            {
                "type": "page",
                "url": "chrome://omnibox-popup.top-chrome/",
                "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/OMNI2",
            },
            {
                "type": "page",
                "url": "https://example.com/",
                "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/REAL",
            },
        ]
        picked = select_cdp_page_target(targets)
        self.assertEqual(picked["url"], "https://example.com/")

    def test_browser_snapshot_click_and_type_via_cdp_eval(self):
        eval_calls = []

        def fake_cdp_eval(expr):
            eval_calls.append(expr)
            return {
                "ok": True,
                "url": "https://example.com",
                "title": "Example",
                "element_count": 1,
                "elements": [{"ref": "e1", "tag": "button", "role": "button", "name": "Submit"}],
                "text_excerpt": "Example Domain",
            }

        spawn_calls = []
        act = Actions(
            FakeRun(),
            spawn=lambda argv, start_new_session=False: spawn_calls.append(argv),
            cdp_eval=fake_cdp_eval,
        )

        snap = act.browser_snapshot(url="https://example.com")
        self.assertTrue(snap["ok"])
        self.assertEqual(spawn_calls, [[DEFAULT_BROWSER, "https://example.com"]])
        self.assertEqual(len(eval_calls), 1)

        clk = act.browser_click("[e1]")
        self.assertTrue(clk["ok"])
        self.assertIn('"e1"', eval_calls[-1])

        typ = act.browser_type("e2", "hello world", submit=True)
        self.assertTrue(typ["ok"])
        self.assertIn('"e2"', eval_calls[-1])
        self.assertIn('"hello world"', eval_calls[-1])

    def test_cdp_ws_call_loopback_handshake_and_framing(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]

        def server_worker():
            conn, _ = srv.accept()
            with conn:
                data = b""
                while b"\r\n\r\n" not in data:
                    data += conn.recv(1024)
                headers = data.decode("latin1")
                sec_key = ""
                for line in headers.splitlines():
                    if line.lower().startswith("sec-websocket-key:"):
                        sec_key = line.split(":", 1)[1].strip()
                accept = base64.b64encode(
                    hashlib.sha1((sec_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
                ).decode("ascii")
                resp = (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                )
                conn.sendall(resp.encode("ascii"))

                # Read masked client frame
                b0, b1 = conn.recv(2)
                length = b1 & 0x7F
                if length == 126:
                    (length,) = struct.unpack(">H", conn.recv(2))
                mask = conn.recv(4)
                masked = conn.recv(length)
                payload = bytes(b ^ mask[i & 3] for i, b in enumerate(masked))
                req_json = json.loads(payload.decode("utf-8"))

                reply_bytes = json.dumps(
                    {
                        "id": req_json["id"],
                        "result": {"result": {"type": "object", "value": {"ok": True, "echo": req_json["method"]}}},
                    }
                ).encode("utf-8")
                frame = bytearray([0x81, len(reply_bytes)]) + reply_bytes
                conn.sendall(bytes(frame))

        t = threading.Thread(target=server_worker, daemon=True)
        t.start()
        try:
            res = cdp_ws_call(
                f"ws://127.0.0.1:{port}/devtools/page/TEST",
                "Runtime.evaluate",
                {"expression": "1+1"},
            )
            self.assertEqual(res["result"]["value"], {"ok": True, "echo": "Runtime.evaluate"})
        finally:
            srv.close()
            t.join(timeout=2)


class TestHTTPServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.token = "test-secret-token"
        cls.actions = Actions(
            FakeRun(),
            spawn=lambda argv, start_new_session=False: None,
            cdp_eval=lambda expr: {
                "ok": True,
                "url": "https://example.com",
                "title": "Example",
                "element_count": 1,
                "elements": [{"ref": "e1", "tag": "a", "role": "link", "name": "More info"}],
                "text_excerpt": "Example Domain",
            },
        )
        cls.server = make_server(cls.actions, cls.token, host="127.0.0.1", port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, method="GET", body=None, token="test-secret-token"):
        headers = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            return e.code, json.loads(raw) if raw else {}

    def test_no_token_returns_401(self):
        status, data = self.request("/health", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(data, {"error": "unauthorized"})

    def test_wrong_token_returns_401(self):
        status, data = self.request("/health", token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(data, {"error": "unauthorized"})

    def test_health_with_token_returns_200(self):
        status, data = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True, "width": 1440, "height": 900})

    def test_click_invalid_param_returns_400(self):
        status, data = self.request("/click", method="POST", body={"x": "a"})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_read_denied_path_returns_403(self):
        status, data = self.request("/read", method="POST", body={"path": "/home/YOUR_USERNAME/.ssh/id_rsa"})
        self.assertEqual(status, 403)
        self.assertIn("error", data)

    def test_write_denied_path_returns_403(self):
        status, data = self.request(
            "/write",
            method="POST",
            body={"path": "/home/YOUR_USERNAME/.ssh/authorized_keys", "content": "test"},
        )
        self.assertEqual(status, 403)
        self.assertIn("error", data)

    def test_unknown_route_returns_404(self):
        status, data = self.request("/nope", method="POST", body={})
        self.assertEqual(status, 404)
        self.assertIn("error", data)

    def test_http_all_routes_dispatch(self):
        # /screenshot
        status, data = self.request("/screenshot", method="POST", body={})
        self.assertEqual(status, 200)
        self.assertIn("png_base64", data)
        self.assertEqual(data["width"], 1440)
        self.assertEqual(data["height"], 900)

        # /click
        status, data = self.request("/click", method="POST", body={"x": 10, "y": 20, "button": "left"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})

        # /type
        status, data = self.request("/type", method="POST", body={"text": "hi"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})

        # /key
        status, data = self.request("/key", method="POST", body={"combo": "ctrl+c"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})

        # /scroll
        status, data = self.request("/scroll", method="POST", body={"x": 10, "y": 20, "direction": "up", "amount": 3})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})

        # /drag
        status, data = self.request("/drag", method="POST", body={"x1": 10, "y1": 20, "x2": 30, "y2": 40})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})

        # /windows
        status, data = self.request("/windows", method="POST", body={})
        self.assertEqual(status, 200)
        self.assertIn("windows", data)

        # /focus
        status, data = self.request("/focus", method="POST", body={"id": "0x123"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})

        # /shell
        status, data = self.request("/shell", method="POST", body={"command": "echo test"})
        self.assertEqual(status, 200)
        self.assertIn("stdout", data)
        self.assertIn("exit_code", data)

        # /write and /read
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "a.txt")
            status, data = self.request("/write", method="POST", body={"path": p, "content": "xyz"})
            self.assertEqual(status, 200)
            self.assertEqual(data, {"bytes": 3})

            status, data = self.request("/read", method="POST", body={"path": p})
            self.assertEqual(status, 200)
            self.assertEqual(data, {"content": "xyz", "truncated": False})

        # /open_url
        status, data = self.request("/open_url", method="POST", body={"url": "https://example.com"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})

        # /browser/snapshot
        status, data = self.request("/browser/snapshot", method="POST", body={})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertIn("elements", data)

        # /browser/click
        status, data = self.request("/browser/click", method="POST", body={"ref": "e1"})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

        # /browser/type
        status, data = self.request("/browser/type", method="POST", body={"ref": "e1", "text": "hello", "submit": True})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_http_missing_required_fields_return_400(self):
        cases = [
            ("/click", {"x": 10}),
            ("/click", {"y": 20}),
            ("/type", {}),
            ("/key", {}),
            ("/scroll", {"x": 10, "y": 20}),
            ("/drag", {"x1": 10, "y1": 20, "x2": 30}),
            ("/focus", {}),
            ("/shell", {}),
            ("/read", {}),
            ("/write", {"path": "/tmp/test"}),
            ("/open_url", {}),
            ("/browser/click", {}),
            ("/browser/type", {"ref": "e1"}),
            ("/browser/type", {"text": "abc"}),
        ]
        for path, body in cases:
            status, data = self.request(path, method="POST", body=body)
            self.assertEqual(status, 400, f"Expected 400 for {path} with {body}, got {status}")
            self.assertIn("error", data)

    def test_cdp_session_single_tab_navigation_and_trusted_input_dispatch(self):
        cdp_methods = []
        spawn_calls = []

        def fake_cdp_session(callback):
            def fake_call(method, params=None):
                cdp_methods.append((method, params or {}))
                if method == "Runtime.evaluate":
                    expr = (params or {}).get("expression", "")
                    if "document.readyState" in expr:
                        return {"result": {"value": "complete"}}
                    if "getBoundingClientRect" in expr:
                        return {
                            "result": {
                                "value": {
                                    "ok": True,
                                    "visible": True,
                                    "x": 240,
                                    "y": 320,
                                    "tag": "input",
                                    "name": "Email",
                                }
                            }
                        }
                    if "collectGbSnapshot" in expr:
                        return {
                            "result": {
                                "value": {
                                    "ok": True,
                                    "url": "https://accounts.google.com/",
                                    "title": "Sign in",
                                    "element_count": 1,
                                    "elements": [{"ref": "e1", "tag": "input"}],
                                }
                            }
                        }
                return {}

            return callback(fake_call)

        act = Actions(
            FakeRun(),
            spawn=lambda argv, start_new_session=False: spawn_calls.append(argv),
            cdp_session=fake_cdp_session,
        )
        act._has_active_cdp_page = lambda: True

        snap = act.browser_snapshot(url="https://accounts.google.com/")
        self.assertTrue(snap["ok"])
        self.assertEqual(spawn_calls, [], "Should reuse existing CDP tab instead of spawning a new tab")
        self.assertEqual(cdp_methods[0], ("Page.navigate", {"url": "https://accounts.google.com/"}))

        cdp_methods.clear()
        clk = act.browser_click("e1")
        self.assertEqual(clk["clicked"]["ref"], "e1")
        mouse_types = [p.get("type") for m, p in cdp_methods if m == "Input.dispatchMouseEvent"]
        self.assertEqual(mouse_types, ["mouseMoved", "mousePressed", "mouseReleased"])

        cdp_methods.clear()
        typ = act.browser_type("e1", "user@example.com", submit=True, clear=True)
        self.assertEqual(typ["typed"], {"ref": "e1", "submit": True})
        self.assertIn(("Input.insertText", {"text": "user@example.com"}), cdp_methods)
        key_events = [(p.get("type"), p.get("key")) for m, p in cdp_methods if m == "Input.dispatchKeyEvent"]
        self.assertIn(("rawKeyDown", "Backspace"), key_events)
        self.assertIn(("char", "Enter"), key_events)

    def test_select_cdp_page_target_deprioritizes_blank_and_newtab(self):
        targets = [
            {"type": "page", "url": "chrome-extension://ext/bg.html", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/1"},
            {"type": "page", "url": "about:blank", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/blank1"},
            {"type": "page", "url": "chrome://newtab/", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/nt"},
            {"type": "page", "url": "https://accounts.google.com/v3/signin/challenge/pwd", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/pwd"},
        ]
        picked = select_cdp_page_target(targets)
        self.assertIsNotNone(picked)
        self.assertEqual(picked["webSocketDebuggerUrl"], "ws://127.0.0.1:9222/pwd")

        only_blanks = [
            {"type": "page", "url": "devtools://devtools/bundled/inspector.html", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/dt"},
            {"type": "page", "url": "about:blank", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/blank"},
        ]
        picked_blank = select_cdp_page_target(only_blanks)
        self.assertEqual(picked_blank["webSocketDebuggerUrl"], "ws://127.0.0.1:9222/blank")

    def test_shared_primary_profile_and_multi_tab_lifecycle(self):
        self.assertIs(DisplayManager, TabManager)
        self.assertEqual(display_resources(1)["vnc_port"], 5901)
        self.assertEqual(display_resources(1)["novnc_port"], 6080)
        self.assertEqual(display_resources(1)["cdp_port"], 9222)

        with tempfile.TemporaryDirectory() as td:
            primary_prof = os.path.join(td, "chrome-profile")
            map_path = os.path.join(td, "display-map.json")
            os.makedirs(os.path.join(primary_prof, "Default"), exist_ok=True)
            cookies_marker = os.path.join(primary_prof, "Default", "Cookies")
            with open(cookies_marker, "w", encoding="utf-8") as f:
                f.write("shared-login-session")

            spawned = []
            cdp_up = {"ws": None}
            live_tabs = []
            next_tab_seq = [0]
            closed_tabs = []
            activated_tabs = []

            def fake_spawn(argv, **kwargs):
                spawned.append((list(argv), kwargs.get("env", {}).get("DISPLAY")))
                cdp_up["ws"] = "ws://127.0.0.1:9222/devtools/browser/MAIN"
                if not live_tabs:
                    live_tabs.append(
                        {
                            "id": "TAB-INIT-1",
                            "type": "page",
                            "url": "about:blank",
                            "title": "",
                            "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/TAB-INIT-1",
                        }
                    )
                return type("P", (), {"pid": 10001})()

            def fake_create_tab(url="about:blank", port=9222):
                next_tab_seq[0] += 1
                tid = f"TAB-NEW-{next_tab_seq[0]}"
                tab = {
                    "id": tid,
                    "type": "page",
                    "url": url or "about:blank",
                    "title": f"Tab {tid}",
                    "webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/devtools/page/{tid}",
                }
                live_tabs.append(tab)
                return tab

            def fake_close_tab(tid, port=9222):
                closed_tabs.append(tid)
                live_tabs[:] = [t for t in live_tabs if t["id"] != tid]

            dm = TabManager(
                map_path=map_path,
                primary_profile_dir=primary_prof,
                max_concurrent_screens=4,
                browser_idle_sec=5,
                browser_boot_timeout_sec=0.05,
                spawn_fn=fake_spawn,
                tcp_open_fn=lambda p: True,
                cdp_ws_fn=lambda port=9222, timeout=1.0: cdp_up["ws"],
                targets_fn=lambda port=9222, timeout=2.0: list(live_tabs),
                create_tab_fn=fake_create_tab,
                close_tab_fn=fake_close_tab,
                activate_tab_fn=lambda target, port=9222: activated_tabs.append(target.get("id")),
            )

            admin_info = dm.acquire_bot_tab("bot-admin", is_admin=True)
            dm.release_bot_tab_in_flight(admin_info["bot_key"])
            tu_info = dm.acquire_bot_tab("bot-tu", is_admin=False)
            dm.release_bot_tab_in_flight(tu_info["bot_key"])
            c_info = dm.acquire_bot_tab("bot-c", is_admin=False)
            dm.release_bot_tab_in_flight(c_info["bot_key"])

            # Single Google Chrome process spawned on :1 with Primary Profile & background-unthrottled flags
            self.assertEqual(len(spawned), 1)
            chrome_argv, chrome_disp = spawned[0]
            self.assertEqual(chrome_disp, ":1")
            self.assertEqual(chrome_argv[0], "/usr/local/bin/google-chrome")
            self.assertIn(f"--user-data-dir={primary_prof}", chrome_argv)
            self.assertIn("--disable-background-timer-throttling", chrome_argv)
            self.assertIn("--disable-backgrounding-occluded-windows", chrome_argv)
            self.assertIn("--disable-renderer-backgrounding", chrome_argv)

            # All 3 Bots share the same Primary Profile & CDP port 9222, but own distinct Tabs!
            self.assertEqual(admin_info["profile_dir"], primary_prof)
            self.assertEqual(tu_info["profile_dir"], primary_prof)
            self.assertEqual(c_info["profile_dir"], primary_prof)
            self.assertEqual(len({admin_info["target_id"], tu_info["target_id"], c_info["target_id"]}), 3)

            # Simulate bot-tu navigating to an authenticated page, then going idle
            for t in live_tabs:
                if t["id"] == tu_info["target_id"]:
                    t["url"] = "https://github.com/notifications"
            reclaimed = dm.reclaim_idle_browsers(now=time.time() + 10)
            self.assertIn("bot-tu", reclaimed)
            self.assertIn("bot-c", reclaimed)
            self.assertNotIn("bot-admin", reclaimed, "admin tab is never idle-evicted")
            self.assertGreaterEqual(len(live_tabs), 1, "Chrome must never drop to 0 open tabs")

            # Waking bot-tu restores its previous URL in a fresh tab
            tu_woken = dm.acquire_bot_tab("bot-tu", is_admin=False)
            dm.release_bot_tab_in_flight(tu_woken["bot_key"])
            self.assertEqual(tu_woken["tab_url"], "https://github.com/notifications")

            # Deleting bot-tu closes its tab WITHOUT deleting the shared Primary Profile!
            rel = dm.release_bot("bot-tu")
            self.assertTrue(rel.get("released"))
            self.assertTrue(os.path.isfile(cookies_marker), "shared Primary Profile must never be deleted")
            self.assertFalse(dm.release_bot("bot-admin").get("released"))

    def test_http_multi_tab_isolation_and_routes(self):
        with tempfile.TemporaryDirectory() as td:
            live_tabs = [
                {
                    "id": "TAB-1",
                    "type": "page",
                    "url": "about:blank",
                    "title": "Tab 1",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/TAB-1",
                }
            ]
            seq = [1]
            activated = []
            navigated_by_target = {}

            def fake_create_tab(url="about:blank", port=9222):
                seq[0] += 1
                tid = f"TAB-{seq[0]}"
                tab = {
                    "id": tid,
                    "type": "page",
                    "url": url or "about:blank",
                    "title": tid,
                    "webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/devtools/page/{tid}",
                }
                live_tabs.append(tab)
                return tab

            def fake_close_tab(tid, port=9222):
                live_tabs[:] = [t for t in live_tabs if t["id"] != tid]

            dm = TabManager(
                map_path=os.path.join(td, "map.json"),
                primary_profile_dir=os.path.join(td, "chrome-profile"),
                max_concurrent_screens=4,
                browser_boot_timeout_sec=0.05,
                spawn_fn=lambda *a, **kw: type("P", (), {"pid": 9999})(),
                tcp_open_fn=lambda p: True,
                cdp_ws_fn=lambda port=9222, timeout=1.0: "ws://127.0.0.1:9222/devtools/browser/1",
                targets_fn=lambda port=9222, timeout=2.0: list(live_tabs),
                create_tab_fn=fake_create_tab,
                close_tab_fn=fake_close_tab,
                activate_tab_fn=lambda target, port=9222: activated.append(target.get("id")),
            )
            srv = make_server(
                Actions(FakeRun(), spawn=lambda *a, **kw: None, cdp_eval=lambda expr: {"ok": True, "url": "https://ok.test"}),
                "tok-md",
                host="127.0.0.1",
                port=0,
                display_manager=dm,
            )
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            port = srv.server_address[1]
            try:
                def req(path, method="POST", body=None, headers=None):
                    hdrs = {"Authorization": "Bearer tok-md", **(headers or {})}
                    data = None
                    if body is not None:
                        data = json.dumps(body).encode("utf-8")
                        hdrs["Content-Type"] = "application/json"
                    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=hdrs)
                    with urllib.request.urlopen(r) as resp:
                        return resp.status, json.loads(resp.read().decode("utf-8"))

                st, ensure_admin = req("/displays/ensure", body={"bot_id": "bot-1", "is_admin": True})
                self.assertEqual(st, 200)
                self.assertEqual(ensure_admin["display"], ":1")
                self.assertEqual(ensure_admin["novnc_port"], 6080)
                self.assertEqual(ensure_admin["target_id"], "TAB-1")

                st, ensure_tu = req("/displays/ensure", body={"bot_id": "bot-tu", "is_admin": False})
                self.assertEqual(st, 200)
                self.assertEqual(ensure_tu["display"], ":1")
                self.assertEqual(ensure_tu["novnc_port"], 6080)
                self.assertEqual(ensure_tu["cdp_port"], 9222)
                self.assertEqual(ensure_tu["target_id"], "TAB-2")
                self.assertNotEqual(ensure_admin["target_id"], ensure_tu["target_id"])

                st, listed = req("/displays", method="GET")
                self.assertEqual(st, 200)
                self.assertEqual(listed["mode"], "shared-profile-multi-tab")
                self.assertIn("bot-1", listed["bindings"])
                self.assertIn("bot-tu", listed["bindings"])

                # Background browser routes bind to each Bot's own target_id WITHOUT stealing foreground focus
                activated.clear()
                actions_tu, dnum = srv.get_actions_for_request(bot_id="bot-tu", is_admin=False, route="/browser/snapshot")
                self.assertEqual(dnum, 1)
                self.assertEqual(actions_tu.target_id, "TAB-2")
                self.assertEqual(activated, [], "background CDP tab actions must not steal foreground focus")

                # Physical X11 /screenshot focuses that Bot's tab before capturing :1
                st, _shot = req("/screenshot", headers={"X-Twinkle-Bot-Id": "bot-tu", "X-Twinkle-Bot-Admin": "0"})
                self.assertEqual(st, 200)
                self.assertIn("TAB-2", activated)

                # Protected blank tabs of concurrent Bots are never closed by close_redundant_blank_tabs
                self.assertEqual(
                    close_redundant_blank_tabs(port=9222, protected_ids=dm.protected_target_ids()),
                    0,
                )

                st, synced = req("/displays/sync_cookies", body={"bot_id": "bot-tu"})
                self.assertEqual(st, 200)
                self.assertTrue(synced.get("shared_profile"))

                st, released = req("/displays/release", body={"bot_id": "bot-tu"})
                self.assertEqual(st, 200)
                self.assertTrue(released["released"])
            finally:
                srv.shutdown()
                srv.server_close()

    def test_unlimited_bots_tab_pool_queue_and_cli_shell_skip_tab(self):
        with tempfile.TemporaryDirectory() as td:
            primary_dir = os.path.join(td, "chrome-profile")
            live_tabs = [
                {
                    "id": "TAB-0",
                    "type": "page",
                    "url": "about:blank",
                    "title": "",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/TAB-0",
                }
            ]
            seq = [0]

            def fake_create_tab(url="about:blank", port=9222):
                seq[0] += 1
                tid = f"TAB-{seq[0]}"
                tab = {
                    "id": tid,
                    "type": "page",
                    "url": url or "about:blank",
                    "title": "",
                    "webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/devtools/page/{tid}",
                }
                live_tabs.append(tab)
                return tab

            def fake_close_tab(tid, port=9222):
                live_tabs[:] = [t for t in live_tabs if t["id"] != tid]

            dm = TabManager(
                map_path=os.path.join(td, "map.json"),
                primary_profile_dir=primary_dir,
                max_concurrent_screens=2,
                browser_boot_timeout_sec=0.05,
                spawn_fn=lambda *a, **kw: type("P", (), {"pid": 12345})(),
                tcp_open_fn=lambda p: True,
                cdp_ws_fn=lambda port=9222, timeout=1.0: "ws://127.0.0.1:9222/devtools/browser/1",
                targets_fn=lambda port=9222, timeout=2.0: list(live_tabs),
                create_tab_fn=fake_create_tab,
                close_tab_fn=fake_close_tab,
                activate_tab_fn=lambda target, port=9222: None,
            )

            # 15 distinct Bots rotate cleanly through max_concurrent_screens=2 tabs inside the SAME shared profile
            for idx in range(1, 16):
                bid = f"bot-unlimited-{idx}"
                info = dm.acquire_bot_tab(bid, is_admin=False)
                self.assertEqual(info["profile_dir"], primary_dir)
                self.assertIsNotNone(info["target_id"])
                dm.release_bot_tab_in_flight(info["bot_key"])
                self.assertLessEqual(len(dm._bot_targets), 2)
                self.assertGreaterEqual(len(live_tabs), 1)

            # Hold both concurrent tab slots in-flight; a 3rd Bot MUST queue FIFO until one finishes
            t1 = dm.acquire_bot_tab("bot-active-a", is_admin=False)
            t2 = dm.acquire_bot_tab("bot-active-b", is_admin=False)
            self.assertNotEqual(t1["target_id"], t2["target_id"])

            queued_result = {}
            started_evt = threading.Event()

            def _waiter():
                started_evt.set()
                info_c = dm.acquire_bot_tab("bot-queued-c", is_admin=False, wait_timeout=5.0)
                queued_result["target_id"] = info_c["target_id"]
                dm.release_bot_tab_in_flight(info_c["bot_key"])

            wt = threading.Thread(target=_waiter, daemon=True)
            wt.start()
            started_evt.wait(1.0)
            time.sleep(0.08)
            self.assertNotIn("target_id", queued_result, "3rd concurrent Bot must queue while 2 tabs are in-flight")

            dm.release_bot_tab_in_flight(t1["bot_key"])
            wt.join(timeout=2.0)
            self.assertIsNotNone(queued_result.get("target_id"), "queued Bot wakes as soon as t1 finishes")
            dm.release_bot_tab_in_flight(t2["bot_key"])

            # Pure CLI `/shell` for an unbound Bot must NOT allocate a Chrome tab
            srv = make_server(
                Actions(FakeRun(), spawn=lambda *a, **kw: None, cdp_eval=lambda expr: {"ok": True}),
                "tok-pool",
                host="127.0.0.1",
                port=0,
                display_manager=dm,
            )
            try:
                _act_shell, shell_disp = srv.get_actions_for_request(
                    bot_id="bot-pure-cli-99", is_admin=False, route="/shell"
                )
                self.assertEqual(shell_disp, 1)
                self.assertIsNone(dm.peek_bound_target_id("bot-pure-cli-99", is_admin=False))
            finally:
                srv.server_close()

    def test_per_bot_workspace_shell_cwd_isolation(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ws_a = os.path.join(tmpdir, "bots", "bot-alpha")
            ws_b = os.path.join(tmpdir, "bots", "bot-beta")
            os.makedirs(ws_a, exist_ok=True)
            os.makedirs(ws_b, exist_ok=True)
            srv = make_server(Actions(browser="/usr/bin/true"), "tok-ws", host="127.0.0.1", port=0)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            try:
                port = srv.server_address[1]
                for bid, ws in [("bot-alpha", ws_a), ("bot-beta", ws_b)]:
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/shell",
                        data=json.dumps({"command": f"pwd && echo {bid} > owned.txt"}).encode("utf-8"),
                        headers={
                            "Authorization": "Bearer tok-ws",
                            "Content-Type": "application/json",
                            "X-Twinkle-Bot-Id": bid,
                            "X-Twinkle-Bot-Workspace": ws,
                        },
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(data["exit_code"], 0)
                    self.assertIn(os.path.realpath(ws), os.path.realpath(data["stdout"].strip()))

                with open(os.path.join(ws_a, "owned.txt"), "r", encoding="utf-8") as f:
                    self.assertEqual(f.read().strip(), "bot-alpha")
                with open(os.path.join(ws_b, "owned.txt"), "r", encoding="utf-8") as f:
                    self.assertEqual(f.read().strip(), "bot-beta")
            finally:
                srv.shutdown()
                srv.server_close()

    def test_passive_proc_port_check_avoids_vnc_blacklist_handshake(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            proc_tcp = os.path.join(tmpdir, "tcp")
            with open(proc_tcp, "w", encoding="utf-8") as f:
                f.write(
                    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt\n"
                    "   0: 00000000:170D 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n"
                    "   1: 0100007F:17C0 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n"
                    "   2: 0100007F:9999 00000000:0000 01 00000000:00000000 00:00000000 00000000\n"
                )
            ports = _read_proc_listening_ports((proc_tcp,))
            self.assertEqual(ports, {5901, 6080})

        # On a live listening loopback socket on Linux, _default_tcp_open returns True
        # without opening an extra client connection (no RFB aborted-handshake blacklist).
        srv_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv_sock.bind(("127.0.0.1", 0))
        srv_sock.listen(1)
        try:
            ephemeral_port = srv_sock.getsockname()[1]
            self.assertTrue(_default_tcp_open(ephemeral_port))
            srv_sock.settimeout(0.05)
            accepted = False
            try:
                conn, _ = srv_sock.accept()
                conn.close()
                accepted = True
            except socket.timeout:
                pass
            if os.path.exists("/proc/net/tcp"):
                self.assertFalse(accepted, "/proc/net/tcp probe must not open an RFB/TCP connection")
        finally:
            srv_sock.close()


if __name__ == "__main__":
    unittest.main()
