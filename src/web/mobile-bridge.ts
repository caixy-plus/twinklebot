/**
 * Mobile Bridge — Pure-client Capacitor & responsive viewport adapter.
 * Gracefully falls back to standard browser APIs when running on desktop/web.
 */

function resolveBridgeLocale(): "zh-CN" | "en" {
  try {
    const stored = String(
      typeof localStorage !== "undefined" ? localStorage.getItem("twinklebot.language") || "" : ""
    )
      .trim()
      .toLowerCase();
    if (stored === "en" || stored.startsWith("en-")) return "en";
    if (stored === "zh" || stored.startsWith("zh-") || stored.startsWith("zh_")) return "zh-CN";
    if (typeof window !== "undefined") {
      const nav = window.navigator;
      const candidate =
        (Array.isArray(nav?.languages) && nav.languages.find((l) => typeof l === "string" && l.trim())) ||
        nav?.language ||
        "";
      const norm = String(candidate).trim().toLowerCase();
      if (!norm || norm === "zh" || norm.startsWith("zh-") || norm.startsWith("zh_")) {
        return "zh-CN";
      }
      return "en";
    }
    return "zh-CN";
  } catch {
    return "zh-CN";
  }
}

export function isMobileAppTarget() {
  if (typeof window === "undefined") return false;
  if (window.__TWINKLEBOT_APP_TARGET__ === "mobile") return true;
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

export function isNativeMobileContainer() {
  if (typeof window === "undefined") return false;
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

export function getMobilePlatform() {
  if (typeof window === "undefined") return "web";
  const capPlatform = window.Capacitor?.getPlatform?.();
  if (capPlatform && capPlatform !== "web") return capPlatform;
  const ua = String(navigator?.userAgent || "").toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/android/.test(ua)) return "android";
  return "web";
}

function getPreferencesPlugin() {
  return typeof window !== "undefined" ? window.Capacitor?.Plugins?.Preferences || null : null;
}

function getAppPlugin() {
  return typeof window !== "undefined" ? window.Capacitor?.Plugins?.App || null : null;
}

function getLanDiscoveryPlugin() {
  return typeof window !== "undefined" ? window.Capacitor?.Plugins?.LanDiscovery || null : null;
}

function getWebUpdaterPlugin() {
  return typeof window !== "undefined" ? window.Capacitor?.Plugins?.WebUpdater || null : null;
}

export async function getMobileWebUpdaterState() {
  const plugin = getWebUpdaterPlugin();
  if (plugin && typeof plugin.getState === "function") {
    try {
      return await plugin.getState();
    } catch {}
  }
  return null;
}

export async function confirmMobileWebOtaReady(webBuild?: string) {
  const plugin = getWebUpdaterPlugin();
  if (plugin && typeof plugin.confirmReady === "function") {
    try {
      return await plugin.confirmReady({ webBuild: webBuild || "" });
    } catch {}
  }
  return null;
}

export async function fetchMobileGithubJson(url: string): Promise<any | null> {
  const plugin = getWebUpdaterPlugin();
  if (plugin && typeof plugin.fetchManifest === "function") {
    const res = await plugin.fetchManifest({ url });
    if (res?.ok && typeof res.jsonText === "string") {
      return JSON.parse(res.jsonText);
    }
  }
  return null;
}

export async function downloadAndApplyMobileWebOta({
  url,
  sha256,
  webBuild,
}: {
  url: string;
  sha256: string;
  webBuild: string;
}) {
  const plugin = getWebUpdaterPlugin();
  if (!plugin || typeof plugin.downloadAndApply !== "function") {
    throw new Error(
      resolveBridgeLocale() === "en"
        ? "Native hot-update plugin is not supported in the current client"
        : "当前客户端暂不支持原生热更新插件"
    );
  }
  return await plugin.downloadAndApply({ url, sha256, webBuild });
}

export async function rollbackMobileWebOtaToBuiltIn() {
  const plugin = getWebUpdaterPlugin();
  if (plugin && typeof plugin.rollbackToBuiltIn === "function") {
    return await plugin.rollbackToBuiltIn();
  }
  return null;
}

export function onMobileWebOtaProgress(handler: (ev: any) => void) {
  const plugin = getWebUpdaterPlugin();
  if (!plugin || typeof plugin.addListener !== "function" || typeof handler !== "function") {
    return () => {};
  }
  try {
    const handlePromise = plugin.addListener("otaProgress", (ev: any) => handler(ev));
    return () => {
      Promise.resolve(handlePromise)
        .then((h: any) => h?.remove?.())
        .catch(() => {});
    };
  } catch {
    return () => {};
  }
}

export async function storageGet(key) {
  const prefs = getPreferencesPlugin();
  if (prefs && typeof prefs.get === "function") {
    try {
      const res = await prefs.get({ key });
      if (res && typeof res.value === "string") return res.value;
    } catch {}
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function storageSet(key, value) {
  const str = String(value ?? "");
  try {
    localStorage.setItem(key, str);
  } catch {}
  const prefs = getPreferencesPlugin();
  if (prefs && typeof prefs.set === "function") {
    try {
      await prefs.set({ key, value: str });
    } catch {}
  }
}

export async function getLanNetworkInfo() {
  const plugin = getLanDiscoveryPlugin();
  if (plugin && typeof plugin.getNetworkInfo === "function") {
    try {
      return await plugin.getNetworkInfo();
    } catch {}
  }
  return null;
}

export async function discoverLanDevices({ timeoutMs = 1200 } = {}) {
  const plugin = getLanDiscoveryPlugin();
  if (plugin && typeof plugin.discover === "function") {
    try {
      const res = await plugin.discover({ timeoutMs });
      const list = Array.isArray(res?.devices) ? res.devices : [];
      return list.map((d) => {
        const host = String(d.host || "").trim();
        const port = Number(d.port) || 3230;
        const baseUrl = String(d.baseUrl || (host ? `http://${host}:${port}` : "")).trim();
        return {
          instanceId: String(d.instanceId || "").trim(),
          hostname: String(
            d.hostname || host || (resolveBridgeLocale() === "en" ? "Desktop" : "桌面电脑")
          ).trim(),
          platform: String(d.platform || "").trim(),
          port,
          host,
          baseUrl,
          appVersion: String(d.appVersion || "").trim(),
          lanAccessEnabled: d.lanAccessEnabled !== false,
        };
      });
    } catch {}
  }
  return [];
}

async function probeHostDiscovery(host, port = 3230, timeoutMs = 800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseUrl = `http://${host}:${port}`;
  try {
    const res = await fetch(`${baseUrl}/api/discovery/info`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.ok || !data.instanceId) return null;
    return {
      instanceId: String(data.instanceId),
      hostname: String(data.hostname || host),
      platform: String(data.platform || ""),
      port: Number(data.port) || port,
      host,
      baseUrl,
      appVersion: String(data.appVersion || ""),
      lanAccessEnabled: data.lanAccessEnabled !== false,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fallback /24 subnet scanner: probes in batches of 25 IPs with 800ms timeout
 * so the WebView connection pool is never saturated.
 */
export async function scanSubnetForDevices({
  subnetPrefix = "",
  port = 3230,
  timeoutMs = 800,
  batchSize = 25,
  selfIp = "",
  onProgress,
}: any = {}) {
  let prefix = String(subnetPrefix || "").trim().replace(/\.$/, "");
  let skipIp = String(selfIp || "").trim();
  if (!prefix) {
    const info = await getLanNetworkInfo();
    if (info?.subnetPrefix) prefix = String(info.subnetPrefix).replace(/\.$/, "");
    if (!skipIp && info?.ip) skipIp = String(info.ip);
  }
  if (!prefix || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) {
    return [];
  }

  const hosts: string[] = [];
  for (let i = 1; i <= 254; i += 1) {
    const candidate = `${prefix}.${i}`;
    if (candidate !== skipIp) hosts.push(candidate);
  }

  const found: any[] = [];
  const seen = new Set();
  for (let idx = 0; idx < hosts.length; idx += batchSize) {
    const batch = hosts.slice(idx, idx + batchSize);
    const results = await Promise.all(
      batch.map((h) => probeHostDiscovery(h, port, timeoutMs))
    );
    for (const item of results) {
      if (item && !seen.has(item.instanceId)) {
        seen.add(item.instanceId);
        found.push(item);
      }
    }
    if (typeof onProgress === "function") {
      try {
        onProgress({ scanned: Math.min(idx + batchSize, hosts.length), total: hosts.length, found: [...found] });
      } catch {}
    }
  }
  return found;
}

export function onAppForeground(callback) {
  if (typeof window === "undefined" || typeof callback !== "function") return () => {};
  const cleanups: Array<() => void> = [];

  const onVis = () => {
    if (document.visibilityState === "visible") {
      callback();
    }
  };
  document.addEventListener("visibilitychange", onVis);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVis));

  const appPlugin = getAppPlugin();
  if (appPlugin && typeof appPlugin.addListener === "function") {
    try {
      const handlePromise = appPlugin.addListener("appStateChange", (state) => {
        if (state?.isActive) {
          callback();
        }
      });
      cleanups.push(() => {
        Promise.resolve(handlePromise)
          .then((h) => h?.remove?.())
          .catch(() => {});
      });
    } catch {}
  }

  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {}
    }
  };
}

export function onHardwareBackButton(handler) {
  const appPlugin = getAppPlugin();
  if (!appPlugin || typeof appPlugin.addListener !== "function" || typeof handler !== "function") {
    return () => {};
  }
  try {
    const handlePromise = appPlugin.addListener("backButton", (ev) => {
      handler(ev);
    });
    return () => {
      Promise.resolve(handlePromise)
        .then((h) => h?.remove?.())
        .catch(() => {});
    };
  } catch {
    return () => {};
  }
}

/**
 * Send the mobile app task to background (Android standard root-back behavior),
 * falling back to exiting the activity if minimizeApp is unavailable.
 */
export async function minimizeOrExitMobileApp(): Promise<boolean> {
  const appPlugin = getAppPlugin();
  if (!appPlugin) return false;
  if (typeof appPlugin.minimizeApp === "function") {
    try {
      await appPlugin.minimizeApp();
      return true;
    } catch {}
  }
  if (typeof appPlugin.exitApp === "function") {
    try {
      await appPlugin.exitApp();
      return true;
    } catch {}
  }
  return false;
}

export async function setScreenOrientation(mode = "portrait") {
  const normalized = mode === "sensor" ? "sensor" : "portrait";
  const plugin = getLanDiscoveryPlugin();
  if (plugin && typeof plugin.setScreenOrientation === "function") {
    try {
      await plugin.setScreenOrientation({ mode: normalized });
      return;
    } catch {}
  }
  try {
    if (normalized === "portrait" && window.screen?.orientation?.lock) {
      await window.screen.orientation.lock("portrait").catch(() => {});
    } else if (normalized === "sensor" && window.screen?.orientation?.unlock) {
      window.screen.orientation.unlock();
    }
  } catch {}
}
