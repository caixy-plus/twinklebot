import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { assessToolCall } from "../src/agent/policy.js";
import { handleSystemBotTool } from "../src/agent/bot-tools/system-tools.js";
import {
  createRelayManager,
  generateServerTemplates,
  parseFrpcToml,
  renderFrpcToml,
} from "../src/lib/relay-manager.js";
import { createServer } from "../src/server/index.js";
import { createAccountDirectoryActions } from "../src/server/routes/relay.js";
import {
  encodeRelayInviteUri,
  normalizeAccountsState,
  parseRelayInvite,
  probeRemoteNodeIdentity,
  upsertRelayForLanAccount,
} from "../src/shared/accounts-store.js";
import { encodeQrMatrix, renderQrSvg } from "../src/shared/qr-svg.js";
import { createStore } from "../src/store/index.js";

function makeTmpDir(t: any, prefix = "tb-relay-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("relay-auth.json & accounts-auth.json use AES-256-GCM encryption and policy.ts blocks relay secrets", (t) => {
  const tmpDir = makeTmpDir(t);
  const store = createStore(tmpDir);

  store.writeRelayAuth({
    mode: "frpc",
    enabled: true,
    accessToken: "super-secret-relay-token-1234",
    frpc: { authToken: "super-secret-frp-handshake" },
  });
  store.writeAccountsAuth({
    accounts: [{ id: "cloud-1", type: "cloud", baseUrl: "https://bot.example.com", authToken: "secret-cloud-jwt" }],
  });

  const rawRelay = fs.readFileSync(path.join(tmpDir, "relay-auth.json"), "utf8");
  const rawAccounts = fs.readFileSync(path.join(tmpDir, "accounts-auth.json"), "utf8");
  assert.doesNotMatch(rawRelay, /super-secret-relay-token-1234/);
  assert.doesNotMatch(rawRelay, /super-secret-frp-handshake/);
  assert.doesNotMatch(rawAccounts, /secret-cloud-jwt/);
  assert.equal(store.readRelayAuth().accessToken, "super-secret-relay-token-1234");
  assert.equal(store.readAccountsAuth().accounts[0].authToken, "secret-cloud-jwt");

  const cfg = { sandboxMode: "restricted", writeRoots: [tmpDir] };
  for (const sensitivePath of [
    path.join(tmpDir, "relay-auth.json"),
    path.join(tmpDir, "accounts-auth.json"),
    path.join(os.homedir(), ".config/geminibot-frpc/frpc.toml"),
    path.join(os.homedir(), ".config/geminibot-frpc/relay-token"),
    "/etc/frp/frps.toml",
  ]) {
    assert.equal(
      assessToolCall("read_file", { path: sensitivePath }, cfg).decision,
      "deny",
      `Expected policy deny for ${sensitivePath}`
    );
  }
});

test("parseFrpcToml & renderFrpcToml preserve WSS/TLS settings and importLegacyRelay migrates LaunchAgent cleanly", async (t) => {
  const tmpDir = makeTmpDir(t, "tb-legacy-relay-");
  const store = createStore(tmpDir);
  const legacyDir = path.join(tmpDir, "geminibot-frpc");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "frpc.toml"),
    [
      'serverAddr = "caixy.xin" # edge domain',
      "serverPort = 443",
      'auth.method = "token"',
      'auth.token = "tok#with-hash-inside"',
      'transport.protocol = "wss"',
      "transport.tcpMux = true",
      '[transport.tls]',
      "enable = false",
      "",
      "[[proxies]]",
      'name = "geminibot-relay"',
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      "localPort = 3230",
      "remotePort = 13230",
      "transport.wsPath = \"/~!frp\"",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(legacyDir, "relay-token"), "legacy-bearer-token-999\n", "utf8");
  const plistPath = path.join(tmpDir, "com.geminibot.frpc.plist");
  fs.writeFileSync(plistPath, "<plist/>", "utf8");

  const parsed = parseFrpcToml(fs.readFileSync(path.join(legacyDir, "frpc.toml"), "utf8"));
  assert.equal(parsed.serverAddr, "caixy.xin");
  assert.equal(parsed.serverPort, 443);
  assert.equal(parsed.authToken, "tok#with-hash-inside");
  assert.equal(parsed.transportProtocol, "wss");
  assert.equal(parsed.tlsEnable, false);
  assert.equal(parsed.proxyName, "geminibot-relay");
  assert.equal(parsed.remotePort, 13230);
  assert.equal(parsed.wsPath, "/~!frp");

  const execCalls: Array<{ file: string; args: string[] }> = [];
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  const manager = createRelayManager({
    store,
    dataDir: tmpDir,
    mainPort: 3230,
    getInstanceId: () => "inst-mac-legacy-1",
    legacySearchDirs: [{ source: "geminibot-frpc", dir: legacyDir }],
    legacyPlistPath: plistPath,
    execSyncFn: ((file: string, args: string[]) => {
      execCalls.push({ file, args });
      if (file === "launchctl" && args[0] === "list") {
        return Buffer.from("12345\t0\tcom.geminibot.frpc\n");
      }
      if (file === "which") {
        return Buffer.from("/opt/homebrew/bin/frpc\n");
      }
      if (String(file).includes("frpc")) {
        return Buffer.from("0.61.1\n");
      }
      return Buffer.from("");
    }) as any,
    execFileFn: ((file: string, args: string[], _opts: any, cb: any) => {
      const callback = typeof _opts === "function" ? _opts : cb;
      execCalls.push({ file, args });
      callback?.(null, "", "");
      return {} as any;
    }) as any,
    spawnFn: ((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      const child: any = new EventEmitter();
      child.pid = 42424;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        queueMicrotask(() => child.emit("exit", 0, null));
      };
      return child;
    }) as any,
  });
  t.after(() => manager.stop());

  const detected = manager.detectLegacyRelay();
  assert.equal(detected.detected, true);
  assert.equal(detected.source, "geminibot-frpc");
  assert.equal(detected.plistLoaded, true);
  assert.equal(detected.remotePort, 13230);

  const imported = await manager.importLegacyRelay({
    unloadLaunchAgent: true,
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.runtime.ok, true);
  assert.ok(spawnCalls.length >= 1, "Managed frpc supervisor must start after import");
  assert.ok(execCalls.some((c) => c.file === "launchctl" && c.args[0] === "bootout"));

  const savedCfg = manager.readConfig();
  assert.equal(savedCfg.mode, "frpc");
  assert.equal(savedCfg.enabled, true);
  assert.equal(savedCfg.accessToken, "legacy-bearer-token-999");
  assert.equal(savedCfg.relayLocalPort, 3231);
  assert.equal(savedCfg.frpc.serverAddr, "caixy.xin");
  assert.equal(savedCfg.frpc.tlsEnable, false);

  const renderedToml = renderFrpcToml(savedCfg);
  assert.match(renderedToml, /localPort = 3231/);
  assert.match(renderedToml, /remotePort = 13230/);
  assert.match(renderedToml, /transport\.tls\.enable = false/);

  const tpls = generateServerTemplates({
    domain: "bot.caixy.xin",
    mainDomain: "caixy.xin",
    pathMode: "subpath",
    subpath: "/twinklebot",
    remotePort: 13230,
    wsPath: "/~!frp",
    frpAuthToken: "frp-tok",
  });
  assert.match(tpls.frpsToml, /bindAddr = "127\.0\.0\.1"/);
  assert.match(tpls.caddySubdomain, /reverse_proxy 127\.0\.0\.1:13230/);
  assert.match(tpls.caddySubpath, /handle_path \/twinklebot\*/);
});

test("dedicated relay listener enforces strict auth on HTTP/WS/noVNC, blocks config mutation (403), and supports subpath redirects", async (t) => {
  const tmpDir = makeTmpDir(t, "tb-relay-srv-");
  const store = createStore(tmpDir);
  const relayToken = "relay-strict-token-abcdef";
  store.writeRelayAuth({
    mode: "external",
    enabled: true,
    publicUrl: "https://bot.example.com",
    accessToken: relayToken,
    relayLocalPort: 0,
    enforceAuthOnRelayPort: true,
  });

  const srv = createServer({
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      stop: () => {},
      broadcastGlobal: () => {},
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      port: 0,
      relayListenPort: 0,
      forceRelayListener: true,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-argon"],
      writeRoots: [tmpDir],
    },
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const mainPort = (srv.address() as any).port;
  const mainUrl = `http://127.0.0.1:${mainPort}`;
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  // Main desktop loopback port returns relay status + dynamically bound relay port
  const statusRes = await fetch(`${mainUrl}/api/relay/status?reveal=1`);
  assert.equal(statusRes.status, 200);
  const statusJson: any = await statusRes.json();
  const relayPort = Number(statusJson.runtime?.relayListeningPort);
  assert.ok(relayPort > 0 && relayPort !== mainPort, `Expected separate relay port, got ${relayPort}`);
  assert.equal(statusJson.config.accessToken, relayToken);

  const relayUrl = `http://127.0.0.1:${relayPort}`;

  // 1. No token on relay loopback MUST return 401 across API, ping, HTML, noVNC, and WS
  for (const p of ["/api/sessions", "/api/relay/ping", "/", "/novnc/vnc.html"]) {
    const r = await fetch(`${relayUrl}${p}`, { redirect: "manual" });
    assert.equal(r.status, 401, `Relay port must reject unauthenticated ${p} even on 127.0.0.1`);
  }

  const wsUnauthStatus = await new Promise<number>((resolve, reject) => {
    const req = http.request(`${relayUrl}/ws`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("1234567890123456").toString("base64"),
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(wsUnauthStatus, 401, "Relay /ws must refuse unauthenticated upgrade with 401");

  // 2. /api/system/health remains readable on relay port with authoritative deployEnv + instanceId
  const healthRes: any = await (await fetch(`${relayUrl}/api/system/health`)).json();
  assert.equal(healthRes.ok, true);
  assert.equal(healthRes.deployEnv, "local");
  assert.ok(healthRes.instanceId);

  // 3. Valid Bearer returns /api/relay/ping with relay=true
  const pingRes = await fetch(`${relayUrl}/api/relay/ping`, {
    headers: { Authorization: `Bearer ${relayToken}` },
  });
  assert.equal(pingRes.status, 200);
  const pingJson: any = await pingRes.json();
  assert.equal(pingJson.relay, true);
  assert.equal(pingJson.deployEnv, "local");
  assert.equal(pingJson.instanceId, healthRes.instanceId);

  // 4. Browser ?token= auth sets HttpOnly tb_relay_auth cookie & HTML uses relative ./ assets + importmap
  const htmlRes = await fetch(`${relayUrl}/?token=${encodeURIComponent(relayToken)}`);
  assert.equal(htmlRes.status, 200);
  const setCookie = htmlRes.headers.get("set-cookie") || "";
  assert.match(setCookie, /tb_relay_auth=/);
  assert.match(setCookie, /HttpOnly/i);
  const htmlText = await htmlRes.text();
  assert.match(htmlText, /href="\.\/style\.css(?:\?[^"]*)?"/);
  assert.match(htmlText, /src="\.\/dist\/app\.js"/);
  assert.match(htmlText, /<script type="importmap">/);

  // Cookie permits follow-up static & /novnc redirect without URL ?token=
  const cookieHeader = setCookie.split(";")[0];
  const novncRel = await fetch(`${relayUrl}/novnc`, {
    headers: { Cookie: cookieHeader },
    redirect: "manual",
  });
  assert.equal(novncRel.status, 302);
  assert.equal(novncRel.headers.get("location"), "novnc/vnc.html");

  const novncPrefixed = await fetch(`${relayUrl}/novnc?autoconnect=true`, {
    headers: {
      Authorization: `Bearer ${relayToken}`,
      "X-Forwarded-Prefix": "/twinklebot",
    },
    redirect: "manual",
  });
  assert.equal(novncPrefixed.status, 302);
  assert.equal(novncPrefixed.headers.get("location"), "/twinklebot/novnc/vnc.html?autoconnect=true");

  // 5. Mutating relay config/rotate over relay ingress is strictly blocked (403)
  const mutateCfg = await fetch(`${relayUrl}/api/relay/config`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${relayToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode: "off" }),
  });
  assert.equal(mutateCfg.status, 403);

  const rotateOverRelay = await fetch(`${relayUrl}/api/relay/control`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${relayToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "rotate_token" }),
  });
  assert.equal(rotateOverRelay.status, 403);
});

test("accounts-store invite parsing, same-instanceId LAN+Relay merge, remote probing & pure-TS QR SVG", async () => {
  const inviteUri = encodeRelayInviteUri({
    v: 1,
    instanceId: "mac-studio-01",
    hostname: "MyMacStudio",
    platform: "darwin",
    deployEnv: "local",
    relayUrl: "https://bot.caixy.xin/",
    relayToken: "tok-qr-123",
    lanUrl: "http://192.168.1.25:3230/",
  });
  assert.ok(inviteUri.startsWith("twinklebot://relay?data="));

  const parsedInvite = parseRelayInvite(inviteUri);
  assert.equal(parsedInvite?.relayUrl, "https://bot.caixy.xin");
  assert.equal(parsedInvite?.relayToken, "tok-qr-123");
  assert.equal(parsedInvite?.instanceId, "mac-studio-01");
  assert.equal(parsedInvite?.deployEnv, "local");
  assert.equal(parsedInvite?.lanUrl, "http://192.168.1.25:3230");

  const parsedHttpWithToken = parseRelayInvite("https://caixy.xin/twinklebot/?token=abc999");
  assert.equal(parsedHttpWithToken?.relayUrl, "https://caixy.xin/twinklebot");
  assert.equal(parsedHttpWithToken?.relayToken, "abc999");

  // Merge Relay onto existing LAN node with matching instanceId without creating duplicates
  const initial = normalizeAccountsState({
    activeAccountId: "lan-mac-studio-01",
    accounts: [
      { id: "local", type: "local", name: "本地电脑", baseUrl: "" },
      {
        id: "lan-mac-studio-01",
        type: "lan",
        name: "MyMacStudio",
        instanceId: "mac-studio-01",
        baseUrl: "http://192.168.1.25:3230",
        authToken: "lan-dev-tok",
      },
    ],
  });
  const merged = upsertRelayForLanAccount(initial, parsedInvite!);
  assert.equal(merged.accounts.length, 2, "Must merge into existing LAN account instead of duplicating");
  assert.equal(merged.accounts[1].relayUrl, "https://bot.caixy.xin");
  assert.equal(merged.accounts[1].relayToken, "tok-qr-123");
  assert.equal(merged.accounts[1].baseUrl, "http://192.168.1.25:3230");
  assert.equal(merged.accounts[1].preferredRoute, "auto");

  // Remote identity probe against mocked /api/relay/ping endpoint
  const fakeProbeFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        relay: true,
        deployEnv: "cloud",
        instanceId: "cloud-vps-1",
        hostname: "Aliyun-SG",
        platform: "linux",
        appVersion: "1.0.4",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as any;
  const probed = await probeRemoteNodeIdentity("https://vps.example.com", "t1", {
    fetchImpl: fakeProbeFetch,
  });
  assert.equal(probed.ok, true);
  assert.equal(probed.deployEnv, "cloud");
  assert.equal(probed.hostname, "Aliyun-SG");

  // Pure-TS QR Code matrix & compact SVG
  const mat = encodeQrMatrix(inviteUri);
  assert.ok(mat.length >= 21 && mat[0].length === mat.length);
  const svg = renderQrSvg(inviteUri, { size: 184 });
  assert.match(svg, /^<svg[^>]+viewBox=/);
  assert.match(svg, /<path d="/);
});

test("account_manage tool & /api/accounts configure remote/cloud accounts without leaking secrets or auto-switching", async (t) => {
  const tmpDir = makeTmpDir(t, "tb-acct-tool-");
  const store = createStore(tmpDir);
  const adminBot = store.createSession({ title: "Nori", isAdmin: true });
  const workerBot = store.createSession({ title: "Worker", isAdmin: false });
  const broadcasts: any[] = [];

  const mockFetch: typeof fetch = (async (input: any) => {
    const url = String(input || "");
    if (url.startsWith("https://nori-cloud.example.com")) {
      return new Response(
        JSON.stringify({
          ok: true,
          deployEnv: "cloud",
          instanceId: "cloud-nori-9",
          hostname: "Nori-VPS",
          platform: "linux",
          appVersion: "1.0.4",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        relay: true,
        deployEnv: "local",
        instanceId: "home-mac-2",
        hostname: "Home-MacMini",
        platform: "darwin",
        appVersion: "1.0.4",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as any;

  const accountActions = createAccountDirectoryActions({
    store,
    fetchImpl: mockFetch,
    getOwnInstanceId: () => "self-mac-instance-1",
    getOwnPublicUrl: () => "https://self.example.com",
    getOwnDeployEnv: () => "local",
    getOwnPorts: () => [3230, 3231],
    broadcastEvent: (ev) => broadcasts.push(ev),
  });

  // 1. Non-admin bot denied on upsert/test/remove, allowed read-only list
  const nonAdminUpsert = await handleSystemBotTool(
    "account_manage",
    { action: "upsert", name: "Evil", base_url: "https://nori-cloud.example.com", auth_token: "sec-1" },
    { store, senderSessionId: workerBot.id, accountActions }
  );
  assert.equal(nonAdminUpsert.ok, false);

  // 2. Admin bot upserts cloud account -> secret stored encrypted, NOT echoed in tool output or broadcasts
  const cloudRes = await handleSystemBotTool(
    "account_manage",
    {
      action: "upsert",
      name: "阿里云 Nori",
      base_url: "https://nori-cloud.example.com",
      auth_token: "cloud-secret-xyz",
    },
    { store, senderSessionId: adminBot.id, senderBot: adminBot, accountActions }
  );
  assert.equal(cloudRes.ok, true);
  assert.equal(cloudRes.manualSwitchOnly, true);
  assert.equal(cloudRes.account.type, "cloud");
  assert.equal(cloudRes.account.hasAuthToken, true);
  assert.equal("authToken" in cloudRes.account, false);
  assert.doesNotMatch(JSON.stringify(cloudRes), /cloud-secret-xyz/);
  assert.doesNotMatch(JSON.stringify(broadcasts), /cloud-secret-xyz/);
  assert.equal(broadcasts.some((b) => b.type === "accounts_updated" && b.action === "upsert"), true);

  // 3. Admin bot upserts relay URL belonging to another local Mac -> unified client Cloud Account ("cloud") with internal nodeDeployEnv="local"
  const macRes = await handleSystemBotTool(
    "account_manage",
    {
      action: "upsert",
      name: "家里 Mac mini",
      base_url: "https://home.example.com",
      auth_token: "home-secret-111",
    },
    { store, senderSessionId: adminBot.id, senderBot: adminBot, accountActions }
  );
  assert.equal(macRes.ok, true);
  assert.equal(macRes.account.type, "cloud");
  assert.equal(macRes.account.nodeDeployEnv, "local");

  // 3b. Self-connect guard: blocks own publicUrl, loopback+ownPort, and matching own instanceId
  const selfPublicRes = await accountActions.upsert({
    name: "Self Public",
    baseUrl: "https://self.example.com",
    authToken: "t-self",
    probe: false,
  });
  assert.equal(selfPublicRes.ok, false);
  const selfLoopMain = await accountActions.upsert({
    name: "Self Loop Main",
    baseUrl: "http://127.0.0.1:3230",
    probe: false,
  });
  assert.equal(selfLoopMain.ok, false);
  const selfLoopRelay = await accountActions.upsert({
    name: "Self Loop Relay",
    baseUrl: "http://localhost:3231",
    probe: false,
  });
  assert.equal(selfLoopRelay.ok, false);
  const selfInviteRes = await accountActions.upsert({
    inviteUri: encodeRelayInviteUri({
      v: 1,
      instanceId: "self-mac-instance-1",
      hostname: "This-Mac",
      platform: "darwin",
      deployEnv: "local",
      relayUrl: "https://other-host-alias.example.com",
      relayToken: "tok",
    }),
    probe: false,
  });
  assert.equal(selfInviteRes.ok, false);

  // 4. List & Test never reveal plaintext tokens
  const listed = await handleSystemBotTool(
    "account_manage",
    { action: "list" },
    { store, senderSessionId: adminBot.id, senderBot: adminBot, accountActions }
  );
  assert.equal(listed.accounts.length, 2);
  assert.doesNotMatch(JSON.stringify(listed), /cloud-secret-xyz|home-secret-111/);

  const tested = await handleSystemBotTool(
    "account_manage",
    { action: "test", account_id: cloudRes.account.id },
    { store, senderSessionId: adminBot.id, senderBot: adminBot, accountActions }
  );
  assert.equal(tested.ok, true);
  assert.equal(tested.probe.deployEnv, "cloud");

  // 5. External channel remove blocked; no switch action exists
  const extRemove = await handleSystemBotTool(
    "account_manage",
    { action: "remove", account_id: cloudRes.account.id },
    { store, senderSessionId: adminBot.id, senderBot: adminBot, userMeta: { channelMeta: { platform: "feishu" } }, accountActions }
  );
  assert.equal(extRemove.ok, false);

  const unsupportedSwitch = await handleSystemBotTool(
    "account_manage",
    { action: "switch", account_id: cloudRes.account.id },
    { store, senderSessionId: adminBot.id, senderBot: adminBot, accountActions }
  );
  assert.equal(unsupportedSwitch.ok, false);

  // 6. Local App remove succeeds and removes encrypted entry
  const localRemove = await handleSystemBotTool(
    "account_manage",
    { action: "remove", account_id: cloudRes.account.id },
    { store, senderSessionId: adminBot.id, senderBot: adminBot, accountActions }
  );
  assert.equal(localRemove.ok, true);
  assert.equal(accountActions.list().length, 1);
});
