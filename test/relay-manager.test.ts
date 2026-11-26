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

test("ISO/IEC 18004 QR encoder round-trip & Reed-Solomon syndromes pass for V1-V16 (including V7+ row/col 6 alignments)", () => {
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

  const ALIGN_POS: number[][] = [
    [],
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
  ];
  const EC_SPECS: Record<"L" | "M", Array<[number, number, number, number, number]>> = {
    L: [
      [0, 0, 0, 0, 0],
      [7, 1, 19, 0, 0],
      [10, 1, 34, 0, 0],
      [15, 1, 55, 0, 0],
      [20, 1, 80, 0, 0],
      [26, 1, 108, 0, 0],
      [18, 2, 68, 0, 0],
      [20, 2, 78, 0, 0],
      [24, 2, 97, 0, 0],
      [30, 2, 116, 0, 0],
      [18, 2, 68, 2, 69],
      [20, 4, 81, 0, 0],
      [24, 2, 92, 2, 93],
      [26, 4, 107, 0, 0],
      [30, 3, 115, 1, 116],
      [22, 5, 87, 1, 88],
      [24, 5, 98, 1, 99],
    ],
    M: [
      [0, 0, 0, 0, 0],
      [10, 1, 16, 0, 0],
      [16, 1, 28, 0, 0],
      [26, 1, 44, 0, 0],
      [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0],
      [16, 4, 27, 0, 0],
      [18, 4, 31, 0, 0],
      [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37],
      [26, 4, 43, 1, 44],
      [30, 1, 50, 4, 51],
      [22, 6, 36, 2, 37],
      [22, 8, 37, 1, 38],
      [24, 4, 40, 5, 41],
      [24, 5, 41, 5, 42],
      [28, 7, 45, 3, 46],
    ],
  };

  const maskFn = (m: number, r: number, c: number): boolean => {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  const decodeAndVerify = (text: string, expectedEc: "L" | "M") => {
    const mat = encodeQrMatrix(text, expectedEc);
    const n = mat.length;
    const version = (n - 17) / 4;
    assert.equal(Number.isInteger(version) && version >= 1 && version <= 16, true);

    // 1. Verify both format copies match
    const c1 = [
      mat[8][0], mat[8][1], mat[8][2], mat[8][3], mat[8][4], mat[8][5], mat[8][7], mat[8][8],
      mat[7][8], mat[5][8], mat[4][8], mat[3][8], mat[2][8], mat[1][8], mat[0][8],
    ];
    const c2 = [
      mat[n - 1][8], mat[n - 2][8], mat[n - 3][8], mat[n - 4][8], mat[n - 5][8], mat[n - 6][8], mat[n - 7][8],
      mat[8][n - 8], mat[8][n - 7], mat[8][n - 6], mat[8][n - 5], mat[8][n - 4], mat[8][n - 3], mat[8][n - 2], mat[8][n - 1],
    ];
    let f1 = 0;
    let f2 = 0;
    for (let i = 0; i < 15; i++) {
      f1 = (f1 << 1) | (c1[i] ? 1 : 0);
      f2 = (f2 << 1) | (c2[i] ? 1 : 0);
    }
    assert.equal(f1, f2, `V${version} format copies mismatch`);
    const unmaskedFmt = f1 ^ 0x5412;
    const ecBits = (unmaskedFmt >>> 13) & 3;
    const mask = (unmaskedFmt >>> 10) & 7;
    assert.equal(ecBits, expectedEc === "M" ? 0 : 1, `V${version} EC level bits mismatch`);

    // 2. Verify reserved patterns including ALL non-finder alignment patterns (including row 6 / col 6)
    const reserved: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
    const mark = (r: number, c: number) => {
      if (r >= 0 && c >= 0 && r < n && c < n) reserved[r][c] = true;
    };
    for (const [t, l] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) mark(t + dr, l + dc);
      }
    }
    for (let i = 8; i < n - 8; i++) {
      assert.equal(mat[6][i], i % 2 === 0, `V${version} horizontal timing mismatch at ${i}`);
      assert.equal(mat[i][6], i % 2 === 0, `V${version} vertical timing mismatch at ${i}`);
      mark(6, i);
      mark(i, 6);
    }
    for (const r0 of ALIGN_POS[version]) {
      for (const c0 of ALIGN_POS[version]) {
        const overlapsFinder =
          (r0 <= 8 && c0 <= 8) || (r0 <= 8 && c0 >= n - 9) || (r0 >= n - 9 && c0 <= 8);
        if (overlapsFinder) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const expDark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            assert.equal(
              mat[r0 + dr][c0 + dc],
              expDark,
              `V${version} missing/corrupt alignment pattern at (${r0},${c0}) offset (${dr},${dc})`
            );
            mark(r0 + dr, c0 + dc);
          }
        }
      }
    }
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        mark(8, i);
        mark(i, 8);
      }
    }
    for (let i = 0; i < 8; i++) mark(8, n - 1 - i);
    for (let i = 0; i < 7; i++) mark(n - 1 - i, 8);
    assert.equal(mat[n - 8][8], true, `V${version} dark module must be set`);
    mark(n - 8, 8);

    if (version >= 7) {
      let v1 = 0;
      let v2 = 0;
      for (let i = 0; i < 18; i++) {
        const r = Math.floor(i / 3);
        const c = n - 11 + (i % 3);
        if (mat[r][c]) v1 |= 1 << i;
        if (mat[c][r]) v2 |= 1 << i;
        mark(r, c);
        mark(c, r);
      }
      assert.equal(v1, v2, `V${version} version info copies mismatch`);
      assert.equal(v1 >>> 12, version, `V${version} version number mismatch`);
    }

    // 3. Unmask & extract codewords in zig-zag order
    const bits: number[] = [];
    let upward = true;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let i = 0; i < n; i++) {
        const r = upward ? n - 1 - i : i;
        for (let dc = 0; dc < 2; dc++) {
          const c = right - dc;
          if (reserved[r][c]) continue;
          bits.push(mat[r][c] !== maskFn(mask, r, c) ? 1 : 0);
        }
      }
      upward = !upward;
    }
    const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = EC_SPECS[expectedEc][version];
    const expectedTotalCw = g1Blocks * g1Data + g2Blocks * g2Data + (g1Blocks + g2Blocks) * ecPerBlock;
    const rawCw: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      rawCw.push(b);
    }
    assert.equal(rawCw.length, expectedTotalCw, `V${version} codeword count mismatch`);

    // 4. De-interleave blocks & verify Reed-Solomon syndromes === 0
    const totalBlocks = g1Blocks + g2Blocks;
    const dataBlocks: number[][] = Array.from({ length: totalBlocks }, () => []);
    const ecBlocks: number[][] = Array.from({ length: totalBlocks }, () => []);
    let idx = 0;
    const maxData = Math.max(g1Data, g2Data);
    for (let i = 0; i < maxData; i++) {
      for (let b = 0; b < totalBlocks; b++) {
        const cap = b < g1Blocks ? g1Data : g2Data;
        if (i < cap) dataBlocks[b].push(rawCw[idx++]);
      }
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (let b = 0; b < totalBlocks; b++) {
        ecBlocks[b].push(rawCw[idx++]);
      }
    }
    assert.equal(idx, expectedTotalCw);

    for (let b = 0; b < totalBlocks; b++) {
      const fullBlock = [...dataBlocks[b], ...ecBlocks[b]];
      for (let k = 0; k < ecPerBlock; k++) {
        const alpha = GF_EXP[k];
        let syn = 0;
        for (const coeff of fullBlock) syn = gfMul(syn, alpha) ^ coeff;
        assert.equal(syn, 0, `V${version} block ${b} RS syndrome S_${k} non-zero`);
      }
    }

    // 5. Decode Byte-mode UTF-8 payload
    const dataStream = dataBlocks.flat();
    const dataBits: number[] = [];
    for (const byteVal of dataStream) {
      for (let j = 7; j >= 0; j--) dataBits.push((byteVal >>> j) & 1);
    }
    const readBits = (offset: number, len: number) => {
      let v = 0;
      for (let i = 0; i < len; i++) v = (v << 1) | dataBits[offset + i];
      return v;
    };
    assert.equal(readBits(0, 4), 0b0100, "Must use Byte mode");
    const countBits = version <= 9 ? 8 : 16;
    const byteLen = readBits(4, countBits);
    const outBytes = new Uint8Array(byteLen);
    let bitCursor = 4 + countBits;
    for (let i = 0; i < byteLen; i++) {
      outBytes[i] = readBits(bitCursor, 8);
      bitCursor += 8;
    }
    assert.equal(new TextDecoder().decode(outBytes), text, `V${version} decoded payload mismatch`);
    return version;
  };

  const realisticInvite = encodeRelayInviteUri({
    v: 1,
    instanceId: "win-desktop-abcdef0123456789",
    hostname: "DESKTOP-TWINKLE-WIN11",
    platform: "win32",
    deployEnv: "local",
    relayUrl: "https://bot-relay.example.com",
    relayToken: "tok_0123456789abcdef0123456789abcdef",
    lanUrl: "http://192.168.10.88:3230",
  });

  assert.equal(decodeAndVerify("HELLO WORLD", "L"), 1);
  assert.equal(decodeAndVerify("HELLO WORLD", "M"), 1);
  assert.equal(decodeAndVerify("A".repeat(120), "L"), 6);
  assert.equal(decodeAndVerify("A".repeat(145), "L"), 7);
  assert.equal(decodeAndVerify("A".repeat(145), "M"), 8);
  const inviteVer = decodeAndVerify(realisticInvite, "L");
  assert.ok(inviteVer >= 10 && inviteVer <= 13, `Expected V10-V13 for invite, got V${inviteVer}`);
  assert.ok(decodeAndVerify(realisticInvite, "M") >= 11);
  assert.ok(decodeAndVerify("R".repeat(480), "L") >= 14);

  const svg = renderQrSvg(realisticInvite);
  const n = inviteVer * 4 + 17;
  assert.ok(svg.includes(`viewBox="0 0 ${n + 8} ${n + 8}"`), "Default quiet zone must be 4 modules");
  assert.ok(svg.includes('fill="#000000"'));
});
