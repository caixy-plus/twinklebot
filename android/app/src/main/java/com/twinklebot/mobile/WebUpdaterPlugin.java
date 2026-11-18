package com.twinklebot.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.plugin.WebView;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

@CapacitorPlugin(name = "WebUpdater")
public class WebUpdaterPlugin extends Plugin {
    private static final String OTA_DIR_NAME = "twinklebot_ota";
    private static final String RELEASES_DIR_NAME = "releases";
    private static final String STATE_FILE_NAME = "ota-state.json";
    private static final long MAX_UNPACK_BYTES = 34L * 1024L * 1024L;

    private static final ExecutorService DOWNLOAD_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static Runnable pendingWatchdogRunnable = null;
    private static Bridge boundBridge = null;

    private static final class NativeShellInfo {
        final String versionName;
        final long versionCode;
        final String key;

        NativeShellInfo(String versionName, long versionCode) {
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.key = versionName + "(" + versionCode + ")";
        }
    }

    private static NativeShellInfo readShellInfo(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pi = pm.getPackageInfo(ctx.getPackageName(), 0);
            String vn = pi.versionName != null ? pi.versionName : "1.0.0";
            long vc = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
            return new NativeShellInfo(vn, vc);
        } catch (Exception e) {
            return new NativeShellInfo("1.0.0", 1L);
        }
    }

    private static File getOtaRoot(Context ctx) {
        return new File(ctx.getFilesDir(), OTA_DIR_NAME);
    }

    private static File getReleasesRoot(Context ctx) {
        return new File(getOtaRoot(ctx), RELEASES_DIR_NAME);
    }

    private static File getStateFile(Context ctx) {
        return new File(getOtaRoot(ctx), STATE_FILE_NAME);
    }

    private static String sanitizeBuildId(String raw) {
        if (raw == null) return "";
        String cleaned = raw.trim().replaceAll("[^a-zA-Z0-9._+\\-]", "_");
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) return "";
        return cleaned;
    }

    private static File releaseDirFor(Context ctx, String buildId) {
        String safe = sanitizeBuildId(buildId);
        if (safe.isEmpty()) return null;
        return new File(getReleasesRoot(ctx), safe);
    }

    private static boolean hasValidRelease(Context ctx, String buildId) {
        File dir = releaseDirFor(ctx, buildId);
        return dir != null && new File(dir, "index.html").isFile();
    }

    private static void deleteRecursive(File target) {
        if (target == null || !target.exists()) return;
        File[] children = target.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursive(child);
            }
        }
        target.delete();
    }

    private static String readUtf8Stream(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) != -1) {
            bos.write(buf, 0, n);
        }
        return bos.toString(StandardCharsets.UTF_8.name());
    }

    private static JSONObject loadStateLocked(Context ctx, NativeShellInfo shell) {
        File stateFile = getStateFile(ctx);
        if (stateFile.isFile()) {
            try (FileInputStream fis = new FileInputStream(stateFile)) {
                JSONObject obj = new JSONObject(readUtf8Stream(fis));
                if (shell.key.equals(obj.optString("builtInNativeKey", ""))) {
                    return obj;
                }
            } catch (Exception ignored) {
            }
        }
        // Binary upgraded or first run -> wipe old OTA cache and fall back cleanly to APK assets
        deleteRecursive(getReleasesRoot(ctx));
        getReleasesRoot(ctx).mkdirs();
        JSONObject fresh = new JSONObject();
        try {
            fresh.put("builtInNativeKey", shell.key);
            fresh.put("activeBuild", "");
            fresh.put("lastGoodBuild", "");
            fresh.put("pendingBuild", "");
            fresh.put("bootAttempts", 0);
            fresh.put("lastRollbackReason", "");
        } catch (Exception ignored) {}
        saveStateLocked(ctx, fresh);
        return fresh;
    }

    private static void saveStateLocked(Context ctx, JSONObject state) {
        File root = getOtaRoot(ctx);
        if (!root.exists()) root.mkdirs();
        File target = getStateFile(ctx);
        File tmp = new File(root, STATE_FILE_NAME + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(state.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return;
        }
        tmp.renameTo(target);
    }

    private static void writeCapacitorServerPathPref(Context ctx, String path) {
        SharedPreferences prefs = ctx.getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        if (path == null || path.isEmpty()) {
            editor.remove(WebView.CAP_SERVER_PATH);
        } else {
            editor.putString(WebView.CAP_SERVER_PATH, path);
        }
        editor.apply();
    }

    /**
     * Must run from MainActivity.onCreate() before super.onCreate() so Capacitor's Bridge
     * immediately boots into either the verified OTA directory or built-in assets.
     */
    public static synchronized void prepareBeforeBridgeCreate(Context ctx) {
        NativeShellInfo shell = readShellInfo(ctx);
        JSONObject st = loadStateLocked(ctx, shell);

        String lastGood = st.optString("lastGoodBuild", "");
        if (!lastGood.isEmpty() && !hasValidRelease(ctx, lastGood)) {
            lastGood = "";
        }
        String active = st.optString("activeBuild", "");
        String pending = st.optString("pendingBuild", "");
        int attempts = st.optInt("bootAttempts", 0);
        String rollbackReason = st.optString("lastRollbackReason", "");

        if (!pending.isEmpty()) {
            attempts += 1;
            if (attempts >= 2 || !hasValidRelease(ctx, pending)) {
                String fallback = hasValidRelease(ctx, lastGood) ? lastGood : "";
                rollbackReason = "版本 " + pending + " 启动确认失败，已自动回滚至" +
                        (fallback.isEmpty() ? "内置基线版" : fallback);
                active = fallback;
                pending = "";
                attempts = 0;
                deleteRecursive(releaseDirFor(ctx, pending));
            }
        } else if (!active.isEmpty() && !hasValidRelease(ctx, active)) {
            active = hasValidRelease(ctx, lastGood) ? lastGood : "";
        }

        try {
            st.put("activeBuild", active);
            st.put("lastGoodBuild", lastGood);
            st.put("pendingBuild", pending);
            st.put("bootAttempts", attempts);
            st.put("lastRollbackReason", rollbackReason);
        } catch (Exception ignored) {}
        saveStateLocked(ctx, st);

        File activeDir = !active.isEmpty() ? releaseDirFor(ctx, active) : null;
        writeCapacitorServerPathPref(ctx, activeDir != null ? activeDir.getAbsolutePath() : null);

        if (!pending.isEmpty()) {
            armWatchdog(ctx.getApplicationContext(), pending);
        }
    }

    public static void bindBridge(Bridge bridge) {
        boundBridge = bridge;
    }

    private static void armWatchdog(Context appCtx, String buildId) {
        MAIN_HANDLER.post(() -> {
            if (pendingWatchdogRunnable != null) {
                MAIN_HANDLER.removeCallbacks(pendingWatchdogRunnable);
            }
            pendingWatchdogRunnable = () -> {
                synchronized (WebUpdaterPlugin.class) {
                    NativeShellInfo shell = readShellInfo(appCtx);
                    JSONObject st = loadStateLocked(appCtx, shell);
                    if (buildId.equals(st.optString("pendingBuild", ""))) {
                        performRollback(appCtx, "前端热更新包 " + buildId + " 超过 5 秒未就绪，已自动回滚", false);
                    }
                }
            };
            MAIN_HANDLER.postDelayed(pendingWatchdogRunnable, 5000L);
        });
    }

    private static void cancelWatchdog() {
        MAIN_HANDLER.post(() -> {
            if (pendingWatchdogRunnable != null) {
                MAIN_HANDLER.removeCallbacks(pendingWatchdogRunnable);
                pendingWatchdogRunnable = null;
            }
        });
    }

    private static synchronized void performRollback(Context ctx, String reason, boolean resetToBuiltIn) {
        cancelWatchdog();
        NativeShellInfo shell = readShellInfo(ctx);
        JSONObject st = loadStateLocked(ctx, shell);

        String pending = st.optString("pendingBuild", "");
        String active = st.optString("activeBuild", "");
        String failed = !pending.isEmpty() ? pending : active;
        String lastGood = st.optString("lastGoodBuild", "");
        String fallback = (!resetToBuiltIn && !lastGood.equals(failed) && hasValidRelease(ctx, lastGood))
                ? lastGood
                : "";

        try {
            st.put("activeBuild", fallback);
            st.put("lastGoodBuild", resetToBuiltIn ? "" : lastGood);
            st.put("pendingBuild", "");
            st.put("bootAttempts", 0);
            st.put("lastRollbackReason", resetToBuiltIn ? "" : reason);
        } catch (Exception ignored) {}
        saveStateLocked(ctx, st);

        if (resetToBuiltIn) {
            deleteRecursive(getReleasesRoot(ctx));
            getReleasesRoot(ctx).mkdirs();
        } else if (!failed.isEmpty() && !failed.equals(fallback)) {
            deleteRecursive(releaseDirFor(ctx, failed));
        }

        File fallbackDir = !fallback.isEmpty() ? releaseDirFor(ctx, fallback) : null;
        writeCapacitorServerPathPref(ctx, fallbackDir != null ? fallbackDir.getAbsolutePath() : null);

        Bridge bridge = boundBridge;
        if (bridge != null) {
            MAIN_HANDLER.post(() -> {
                if (fallbackDir != null) {
                    bridge.setServerBasePath(fallbackDir.getAbsolutePath());
                } else {
                    bridge.setServerAssetPath("public");
                }
            });
        }
    }

    private static synchronized JSObject buildStateSnapshot(Context ctx) {
        NativeShellInfo shell = readShellInfo(ctx);
        JSONObject st = loadStateLocked(ctx, shell);
        String active = st.optString("activeBuild", "");
        File activeDir = !active.isEmpty() ? releaseDirFor(ctx, active) : null;
        boolean usingBuiltIn = (activeDir == null || !new File(activeDir, "index.html").isFile());

        String webBuild = "";
        if (!usingBuiltIn) {
            File metaFile = new File(activeDir, "web-meta.json");
            if (metaFile.isFile()) {
                try (FileInputStream fis = new FileInputStream(metaFile)) {
                    JSONObject meta = new JSONObject(readUtf8Stream(fis));
                    webBuild = meta.optString("webBuild", "");
                } catch (Exception ignored) {}
            }
        } else {
            try (InputStream is = ctx.getAssets().open("public/web-meta.json")) {
                JSONObject meta = new JSONObject(readUtf8Stream(is));
                webBuild = meta.optString("webBuild", "");
            } catch (Exception ignored) {}
        }

        JSObject out = new JSObject();
        out.put("platform", "android");
        out.put("nativeVersion", shell.versionName);
        out.put("nativeBuildCode", (int) shell.versionCode);
        out.put("activeWebBuild", !webBuild.isEmpty() ? webBuild : active);
        out.put("activeBuildId", active);
        out.put("lastGoodBuild", st.optString("lastGoodBuild", ""));
        out.put("pendingBuild", st.optString("pendingBuild", ""));
        out.put("lastRollbackReason", st.optString("lastRollbackReason", ""));
        out.put("usingBuiltIn", usingBuiltIn);
        return out;
    }

    private static boolean isTrustedGithubUrl(URL url) {
        if (url == null || !"https".equalsIgnoreCase(url.getProtocol())) {
            return false;
        }
        String host = url.getHost() != null ? url.getHost().toLowerCase(Locale.US) : "";
        String path = url.getPath() != null ? url.getPath().toLowerCase(Locale.US) : "";
        if ("github.com".equals(host)) {
            return path.matches("^/caixy-plus/[a-z0-9._-]+/releases/.*");
        }
        if ("api.github.com".equals(host)) {
            return path.matches("^/repos/caixy-plus/[a-z0-9._-]+/releases(/.*)?$");
        }
        return "objects.githubusercontent.com".equals(host)
                || "release-assets.githubusercontent.com".equals(host)
                || "github-releases.githubusercontent.com".equals(host)
                || host.endsWith(".githubusercontent.com");
    }

    @PluginMethod
    public void getState(PluginCall call) {
        bindBridge(getBridge());
        call.resolve(buildStateSnapshot(getContext()));
    }

    @PluginMethod
    public void fetchManifest(PluginCall call) {
        String urlStr = call.getString("url", "");
        DOWNLOAD_EXECUTOR.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                if (!isTrustedGithubUrl(url)) {
                    call.reject("Untrusted GitHub URL");
                    return;
                }
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(12000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "TwinkleBot-Android/1.0.0");
                conn.setRequestProperty("Accept", "application/json, application/vnd.github+json");
                int code = conn.getResponseCode();
                if (!isTrustedGithubUrl(conn.getURL())) {
                    call.reject("Untrusted redirect URL");
                    return;
                }
                if (code < 200 || code >= 300) {
                    call.reject("HTTP " + code);
                    return;
                }
                try (InputStream is = new BufferedInputStream(conn.getInputStream())) {
                    String jsonText = readUtf8Stream(is);
                    JSObject res = new JSObject();
                    res.put("ok", true);
                    res.put("jsonText", jsonText);
                    call.resolve(res);
                }
            } catch (Exception e) {
                call.reject("请求失败: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void confirmReady(PluginCall call) {
        String webBuild = call.getString("webBuild", "");
        cancelWatchdog();
        Context ctx = getContext();
        synchronized (WebUpdaterPlugin.class) {
            NativeShellInfo shell = readShellInfo(ctx);
            JSONObject st = loadStateLocked(ctx, shell);
            String pending = st.optString("pendingBuild", "");
            if (!pending.isEmpty() && (webBuild == null || webBuild.isEmpty() || webBuild.equals(pending))) {
                String oldGood = st.optString("lastGoodBuild", "");
                try {
                    st.put("activeBuild", pending);
                    st.put("lastGoodBuild", pending);
                    st.put("pendingBuild", "");
                    st.put("bootAttempts", 0);
                    st.put("lastRollbackReason", "");
                } catch (Exception ignored) {}
                saveStateLocked(ctx, st);
                File[] dirs = getReleasesRoot(ctx).listFiles();
                if (dirs != null) {
                    for (File d : dirs) {
                        String n = d.getName();
                        if (!n.equals(pending) && !n.equals(oldGood)) {
                            deleteRecursive(d);
                        }
                    }
                }
            } else if (st.optInt("bootAttempts", 0) > 0) {
                try {
                    st.put("bootAttempts", 0);
                } catch (Exception ignored) {}
                saveStateLocked(ctx, st);
            }
        }
        call.resolve(buildStateSnapshot(ctx));
    }

    @PluginMethod
    public void rollbackToBuiltIn(PluginCall call) {
        bindBridge(getBridge());
        performRollback(getContext(), "用户手动恢复内置界面", true);
        call.resolve(buildStateSnapshot(getContext()));
    }

    @PluginMethod
    public void downloadAndApply(PluginCall call) {
        String urlStr = call.getString("url", "");
        String expectedSha = call.getString("sha256", "");
        String webBuild = call.getString("webBuild", "");

        String cleanBuild = sanitizeBuildId(webBuild);
        if (urlStr == null || urlStr.isEmpty() || expectedSha == null || expectedSha.isEmpty() || cleanBuild.isEmpty()) {
            call.reject("Missing url, sha256, or webBuild");
            return;
        }
        bindBridge(getBridge());
        Context appCtx = getContext().getApplicationContext();

        DOWNLOAD_EXECUTOR.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                if (!isTrustedGithubUrl(url)) {
                    call.reject("Untrusted GitHub download URL");
                    return;
                }
                JSObject p1 = new JSObject();
                p1.put("phase", "downloading");
                p1.put("percent", 20);
                p1.put("message", "正在从 GitHub Releases 下载热更新包…");
                notifyListeners("otaProgress", p1);

                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(45000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "TwinkleBot-Android/1.0.0");
                int code = conn.getResponseCode();
                if (!isTrustedGithubUrl(conn.getURL())) {
                    call.reject("更新包重定向到了未受信任地址");
                    return;
                }
                if (code < 200 || code >= 300) {
                    call.reject("下载失败: HTTP " + code);
                    return;
                }
                byte[] gzBytes;
                try (InputStream is = new BufferedInputStream(conn.getInputStream());
                     ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                    byte[] buf = new byte[16384];
                    int n;
                    long total = 0;
                    while ((n = is.read(buf)) != -1) {
                        total += n;
                        if (total > MAX_UNPACK_BYTES) {
                            throw new IOException("更新包超出安全大小限制");
                        }
                        bos.write(buf, 0, n);
                    }
                    gzBytes = bos.toByteArray();
                }

                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] digest = md.digest(gzBytes);
                StringBuilder hex = new StringBuilder();
                for (byte b : digest) {
                    hex.append(String.format(Locale.US, "%02x", b));
                }
                if (!hex.toString().equals(expectedSha.trim().toLowerCase(Locale.US))) {
                    call.reject("更新包 SHA-256 校验失败");
                    return;
                }

                JSObject p2 = new JSObject();
                p2.put("phase", "extracting");
                p2.put("percent", 75);
                p2.put("message", "正在校验并切换前端资源…");
                notifyListeners("otaProgress", p2);

                File stageDir = new File(getOtaRoot(appCtx), "stage-" + cleanBuild + "-" + System.currentTimeMillis());
                deleteRecursive(stageDir);
                stageDir.mkdirs();

                try {
                    extractTarGzSafely(gzBytes, stageDir);
                    if (!new File(stageDir, "index.html").isFile()) {
                        throw new IOException("更新包缺少 index.html");
                    }
                    File targetDir = releaseDirFor(appCtx, cleanBuild);
                    deleteRecursive(targetDir);
                    targetDir.getParentFile().mkdirs();
                    if (!stageDir.renameTo(targetDir)) {
                        throw new IOException("无法落盘热更新目录");
                    }

                    synchronized (WebUpdaterPlugin.class) {
                        NativeShellInfo shell = readShellInfo(appCtx);
                        JSONObject st = loadStateLocked(appCtx, shell);
                        String curActive = st.optString("activeBuild", "");
                        String curPending = st.optString("pendingBuild", "");
                        String prevStable = (!curActive.isEmpty() && curPending.isEmpty() && hasValidRelease(appCtx, curActive))
                                ? curActive
                                : st.optString("lastGoodBuild", "");
                        st.put("activeBuild", cleanBuild);
                        st.put("lastGoodBuild", prevStable);
                        st.put("pendingBuild", cleanBuild);
                        st.put("bootAttempts", 0);
                        st.put("lastRollbackReason", "");
                        saveStateLocked(appCtx, st);
                    }

                    writeCapacitorServerPathPref(appCtx, targetDir.getAbsolutePath());
                    armWatchdog(appCtx, cleanBuild);

                    JSObject p3 = new JSObject();
                    p3.put("phase", "done");
                    p3.put("percent", 100);
                    p3.put("message", "热更新成功，正在重载…");
                    notifyListeners("otaProgress", p3);

                    Bridge bridge = boundBridge;
                    if (bridge != null) {
                        MAIN_HANDLER.post(() -> bridge.setServerBasePath(targetDir.getAbsolutePath()));
                    }
                    call.resolve(buildStateSnapshot(appCtx));
                } finally {
                    deleteRecursive(stageDir);
                }
            } catch (Exception e) {
                call.reject("热更新失败: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private static String readTarString(byte[] header, int offset, int length) {
        int end = offset;
        int limit = offset + length;
        while (end < limit && header[end] != 0) end++;
        return new String(header, offset, end - offset, StandardCharsets.UTF_8);
    }

    private static long readTarOctal(byte[] header, int offset, int length) {
        String s = readTarString(header, offset, length).trim();
        if (s.isEmpty()) return 0L;
        return Long.parseLong(s, 8);
    }

    private static void extractTarGzSafely(byte[] gzBytes, File destDir) throws IOException {
        String destCanonical = destDir.getCanonicalPath();
        try (GZIPInputStream gis = new GZIPInputStream(new java.io.ByteArrayInputStream(gzBytes))) {
            byte[] header = new byte[512];
            long totalBytes = 0L;
            int fileCount = 0;

            while (true) {
                int read = readFully(gis, header, 512);
                if (read < 512) break;

                boolean allZero = true;
                for (byte b : header) {
                    if (b != 0) {
                        allZero = false;
                        break;
                    }
                }
                if (allZero) break;

                String name = readTarString(header, 0, 100);
                String prefix = readTarString(header, 345, 155);
                String rawRel = prefix.isEmpty() ? name : (prefix + "/" + name);
                byte typeFlag = header[156];
                long size = readTarOctal(header, 124, 12);

                if (typeFlag == '1' || typeFlag == '2') {
                    throw new IOException("Unsafe link entry rejected: " + rawRel);
                }

                String cleaned = rawRel.replace('\\', '/').replaceAll("^/+", "");
                if (!cleaned.isEmpty() && typeFlag != 'x' && typeFlag != 'g') {
                    for (String seg : cleaned.split("/")) {
                        if (".".equals(seg) || "..".equals(seg)) {
                            throw new IOException("Unsafe traversal path rejected: " + rawRel);
                        }
                    }
                }

                if (typeFlag == '5') {
                    File dir = new File(destDir, cleaned);
                    String c = dir.getCanonicalPath();
                    if (!c.equals(destCanonical) && !c.startsWith(destCanonical + File.separator)) {
                        throw new IOException("Tar-Slip directory escape rejected: " + rawRel);
                    }
                    dir.mkdirs();
                    continue;
                }

                if (typeFlag == '0' || typeFlag == 0) {
                    fileCount += 1;
                    totalBytes += size;
                    if (fileCount > 1000 || totalBytes > MAX_UNPACK_BYTES) {
                        throw new IOException("Archive exceeds safety limits");
                    }
                    File outFile = new File(destDir, cleaned);
                    String c = outFile.getCanonicalPath();
                    if (!c.startsWith(destCanonical + File.separator)) {
                        throw new IOException("Tar-Slip file escape rejected: " + rawRel);
                    }
                    if (outFile.getParentFile() != null) outFile.getParentFile().mkdirs();
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        copyExact(gis, fos, size);
                    }
                } else {
                    skipExact(gis, size);
                }

                long pad = (512 - (size % 512)) % 512;
                if (pad > 0) skipExact(gis, pad);
            }
        }
    }

    private static int readFully(InputStream is, byte[] buf, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = is.read(buf, off, len - off);
            if (n < 0) break;
            off += n;
        }
        return off;
    }

    private static void copyExact(InputStream is, FileOutputStream fos, long len) throws IOException {
        byte[] buf = new byte[8192];
        long rem = len;
        while (rem > 0) {
            int n = is.read(buf, 0, (int) Math.min(buf.length, rem));
            if (n < 0) throw new IOException("Truncated tar payload");
            fos.write(buf, 0, n);
            rem -= n;
        }
    }

    private static void skipExact(InputStream is, long len) throws IOException {
        byte[] buf = new byte[4096];
        long rem = len;
        while (rem > 0) {
            int n = is.read(buf, 0, (int) Math.min(buf.length, rem));
            if (n < 0) break;
            rem -= n;
        }
    }
}
