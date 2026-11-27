const REPO = "caixy-plus/twinklebot";
const FALLBACK_VERSION = "v1.0.0";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const SCENES = {
  collab: {
    title: "TwinkleBot · 产品研发协作群",
    meta: "3 Bots 在线 · 引用回复与 @ 协同",
    thinking: "正在整理接口测试结论",
    placeholder: "输入 @ 点名特定 Bot 或发送任务…",
    html: `
      <div class="sim-stream">
        <div class="sim-row is-user">
          <div class="sim-author">你</div>
          <div class="sim-bubble">@架构师 @测试Bot 帮我看下登录接口这次改完还有没有边界问题？</div>
        </div>
        <div class="sim-row is-bot">
          <div class="sim-author"><span class="sim-dot" style="background:#1e86fc"></span>架构师</div>
          <div class="sim-bubble">已核查路由鉴权边界：Cloud 模式下仅放行 <code>/api/system/health</code> 与 <code>/novnc/</code>，<code>/</code> 返回 <code>ok</code> 且无多余页面暴露。交给 @测试Bot 跑回归。</div>
        </div>
        <div class="sim-row is-bot">
          <div class="sim-author"><span class="sim-dot" style="background:#2fd486"></span>测试Bot</div>
          <div class="sim-bubble">282 项自动化测试全部通过，移动端断线重连与主机桥接用例已覆盖。</div>
        </div>
      </div>
    `,
  },
  desktop: {
    title: "TwinkleBot · 双电脑协同 (Ubuntu + Mac)",
    meta: "noVNC 实时画面 · 审批护栏开启",
    thinking: "正在核查运行环境",
    placeholder: "继续补充指令，实时插话调整任务…",
    html: `
      <div class="sim-desktop-grid">
        <div class="sim-vnc-screen">
          <div class="sim-vnc-bar">
            <span>Ubuntu XFCE (:1 · 1440×900)</span>
            <span>仅画面 · 无干扰工具栏</span>
          </div>
          <div class="sim-vnc-window">
            <div>$ npm test</div>
            <div style="color:#2fd486;margin-top:6px;"># pass 282 / fail 0</div>
            <div style="color:#9a9aa6;margin-top:4px;">点击画面随时接管鼠标与键盘</div>
          </div>
          <div class="sim-vnc-pill">原生鼠标可直接点击 · 取得控制权</div>
        </div>
        <div class="sim-stream">
          <div class="sim-row is-bot">
            <div class="sim-author"><span class="sim-dot" style="background:#ffb536"></span>Twinkle</div>
            <div class="sim-bubble">沙箱内构建完成，现在需要同步打包本机 Mac 应用，请确认执行权限：</div>
          </div>
          <div class="sim-approval-card">
            <div class="sim-approval-head">⚠ 高危 / 跨机命令审批 (host_run_shell)</div>
            <div class="sim-approval-cmd">npx electron-builder --mac dmg --arm64</div>
            <div class="sim-approval-btns">
              <span class="sim-btn-ok">允许这一次</span>
              <span class="sim-btn-ok" style="background:#2fd486;">总是允许</span>
              <span class="sim-btn-no">拒绝</span>
            </div>
          </div>
        </div>
      </div>
    `,
  },
  mobile: {
    title: "TwinkleBot Mobile · 局域网直连 + 横屏看桌面",
    meta: "纯客户端 APK · 6 位配对码",
    thinking: "正在查看桌面操作",
    placeholder: "在手机上随时发消息或语音输入…",
    html: `
      <div class="sim-stream">
        <div class="sim-row is-user">
          <div class="sim-author">手机客户端 (LAN 192.168.1.25)</div>
          <div class="sim-bubble">帮我打开电脑上的终端看看下载进度，我横屏盯着画面</div>
        </div>
        <div class="sim-row is-bot">
          <div class="sim-author"><span class="sim-dot" style="background:#9e44ff"></span>Twinkle</div>
          <div class="sim-bubble">已通过局域网配对通道连接 Mac。日常保持竖屏聊天；点击右上角电脑卡片并横屏，即可自动进入全屏桌面控制模式，退出后自动恢复竖屏。</div>
        </div>
      </div>
    `,
  },
  routing: {
    title: "TwinkleBot · 智能路由调度器",
    meta: "Hydrogen [Low/Med/High/XHigh] · Argon · Carbon",
    thinking: "正在分析当前需求",
    placeholder: "支持上传图片、文档或代码块…",
    html: `
      <div class="sim-stream">
        <div class="sim-row is-user">
          <div class="sim-author">你 (附带 1 张架构截图)</div>
          <div class="sim-bubble">帮我分析这张图里的时序瓶颈，并给出重构补丁</div>
        </div>
        <div class="sim-row is-bot">
          <div class="sim-author"><span class="sim-dot" style="background:#ff5478"></span>智能路由</div>
          <div class="sim-bubble">
            <div>① 意图规划：检测到图片附件与代码重构任务 → 开局分配 <strong>Gemini 4 Hydrogen High</strong> 识图定位</div>
            <div style="margin-top:6px;">② 深度编码阶段：自动升档至 <strong>Gemini 4 Argon / Carbon</strong> 生成补丁并统计精确分模型账单</div>
          </div>
        </div>
      </div>
    `,
  },
};

function detectPlatform() {
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/android/.test(ua)) return "android";
  if (/macintosh|mac os x/.test(ua)) return "macos";
  if (/windows|win32|win64/.test(ua)) return "windows";
  if (/linux/.test(ua)) return "linux";
  return "macos";
}

function applyPlatformHighlight(platform) {
  const labels = {
    macos: "下载 macOS 版 (.dmg)",
    windows: "下载 Windows 版 (.exe)",
    linux: "下载 Linux 版 (.AppImage)",
    android: "下载 Android 版 (.apk)",
  };
  const targetLinks = {
    macos: "#dl-mac-arm64",
    windows: "#dl-win-exe",
    linux: "#dl-linux-appimage",
    android: "#dl-android-apk",
  };
  const primaryBtn = document.getElementById("primary-download-btn");
  const primaryLabel = document.getElementById("primary-download-label");
  if (primaryLabel && labels[platform]) {
    primaryLabel.textContent = labels[platform];
  }
  if (primaryBtn && targetLinks[platform]) {
    const targetEl = document.querySelector(targetLinks[platform]);
    if (targetEl?.getAttribute("href")) {
      primaryBtn.setAttribute("href", targetEl.getAttribute("href"));
      primaryBtn.setAttribute("target", "_blank");
      primaryBtn.setAttribute("rel", "noopener noreferrer");
    }
  }
  for (const chip of document.querySelectorAll<HTMLElement>("[data-jump-platform]")) {
    chip.classList.toggle("is-current", chip.dataset.jumpPlatform === platform);
  }
  for (const card of document.querySelectorAll<HTMLElement>("[data-platform-card]")) {
    card.classList.toggle("is-highlighted", card.dataset.platformCard === platform);
  }
}

function renderScene(key) {
  const scene = SCENES[key] || SCENES.collab;
  const titleEl = document.getElementById("stage-chrome-title");
  const metaEl = document.getElementById("stage-chrome-meta");
  const bodyEl = document.getElementById("stage-body");
  if (titleEl) titleEl.textContent = scene.title;
  if (metaEl) metaEl.textContent = scene.meta;
  if (bodyEl) {
    bodyEl.innerHTML = `
      ${scene.html}
      <div class="sim-footer">
        <div class="sim-thinking-pill">
          <span class="pulse-dot" aria-hidden="true"></span>
          <span>${scene.thinking}</span>
        </div>
        <div class="sim-composer">
          <span>${scene.placeholder}</span>
          <span>↵ 发送</span>
        </div>
      </div>
    `;
  }
  for (const tab of document.querySelectorAll<HTMLElement>(".scene-tab")) {
    const active = tab.dataset.scene === key;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
}

async function hydrateLatestReleaseLinks(platform) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=8`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const releases = await res.json();
    if (!Array.isArray(releases) || releases.length === 0) return;

    const desktopRel =
      releases.find((r) => /^v\d+\.\d+\.\d+/.test(r.tag_name || "") && Array.isArray(r.assets) && r.assets.length > 0) ||
      releases.find((r) => r.tag_name === "latest") ||
      releases[0];
    const allAssets = releases.flatMap((r) => (Array.isArray(r.assets) ? r.assets : []));

    const pickAsset = (regex, preferred = desktopRel?.assets || []) =>
      preferred.find((a) => regex.test(a.name || "")) ||
      allAssets.find((a) => regex.test(a.name || ""));

    const macDmg = pickAsset(/arm64.*\.dmg$/i) || pickAsset(/\.dmg$/i);
    const winExe = pickAsset(/\.exe$/i);
    const winZip = pickAsset(/win\.zip$/i);
    const linuxApp = pickAsset(/\.AppImage$/i);
    const linuxTar = pickAsset(/\.tar\.gz$/i);
    const androidApk = pickAsset(/release\.apk$/i) || pickAsset(/\.apk$/i);

    const bind = (id, asset, fallbackUrl = desktopRel?.html_url || RELEASES_PAGE) => {
      const a = document.getElementById(id) as HTMLAnchorElement | null;
      if (a) a.href = asset?.browser_download_url || fallbackUrl;
    };

    bind("dl-mac-arm64", macDmg);
    bind("dl-mac-x64", null, desktopRel?.html_url || RELEASES_PAGE);
    bind("dl-win-exe", winExe);
    bind("dl-win-zip", winZip);
    bind("dl-linux-appimage", linuxApp);
    bind("dl-linux-tar", linuxTar);
    bind("dl-android-apk", androidApk);

    const ver = desktopRel?.tag_name && desktopRel.tag_name !== "latest"
      ? desktopRel.tag_name
      : FALLBACK_VERSION;
    const navPill = document.getElementById("nav-version-pill");
    const relTag = document.getElementById("release-version-tag");
    const heroRel = document.getElementById("hero-release-label");
    if (navPill) navPill.textContent = ver;
    if (relTag) relTag.textContent = ver;
    if (heroRel) heroRel.textContent = `TwinkleBot ${ver} 正式发布 · 桌面端 & Android 同步上线`;
    applyPlatformHighlight(platform);
  } catch {
    // Keep static GitHub Releases links when offline or rate-limited
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const platform = detectPlatform();
  renderScene("collab");
  applyPlatformHighlight(platform);
  hydrateLatestReleaseLinks(platform);

  for (const tab of document.querySelectorAll<HTMLElement>(".scene-tab")) {
    tab.addEventListener("click", () => renderScene(tab.dataset.scene));
  }

  for (const chip of document.querySelectorAll<HTMLElement>("[data-jump-platform]")) {
    chip.addEventListener("click", () => {
      const card = document.querySelector(`[data-platform-card="${chip.dataset.jumpPlatform}"]`);
      applyPlatformHighlight(chip.dataset.jumpPlatform);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  for (const btn of document.querySelectorAll<HTMLElement>("[data-copy-target]")) {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.copyTarget;
      const codeEl = targetId ? document.getElementById(targetId) : null;
      if (!codeEl) return;
      const defaultLabel = btn.dataset.copyLabel || "复制";
      try {
        await navigator.clipboard.writeText(codeEl.textContent || "");
        btn.textContent = "已复制 ✓";
        setTimeout(() => {
          btn.textContent = defaultLabel;
        }, 1800);
      } catch {
        btn.textContent = "复制失败";
      }
    });
  }
});
