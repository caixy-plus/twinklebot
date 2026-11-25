/**
 * TwinkleBot 13 Astro/Geometric Mascot Shapes × 11 Colors & Group Cluster Avatar Renderer
 */

export type MascotFaceKind = "visor" | "star" | "happy" | "focused";

export interface BotShapeSpec {
  key: string;
  label: string;
  labelEn: string;
  keywords: string[];
  path: string;
  face: MascotFaceKind;
  faceY: number;
}

export interface MascotFaceElement {
  tag: "rect" | "circle" | "path";
  attrs: Record<string, string>;
}

export const BOT_COLORS = [
  {
    key: "black",
    label: "黑色",
    labelEn: "Obsidian",
    swatch: "#1c1c1e",
    darkBright: "#f5f5f7",
    darkBrightFg: "#121212",
    darkEye: "#121212",
    darkBubble: "#2b2b2b",
    darkBubbleFg: "#f3f3f4",
    lightBright: "#18181b",
    lightBrightFg: "#ffffff",
    lightEye: "#ffffff",
    lightBubble: "#27272a",
    lightBubbleFg: "#ffffff",
  },
  {
    key: "brown",
    label: "棕色",
    labelEn: "Bronze",
    swatch: "#a06b39",
    bright: "#a06b39",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#86592e",
    bubbleFg: "#ffffff",
  },
  {
    key: "red",
    label: "红色",
    labelEn: "Crimson",
    swatch: "#fb2b3e",
    bright: "#fb2b3e",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#c82532",
    bubbleFg: "#ffffff",
  },
  {
    key: "orange",
    label: "橙色",
    labelEn: "Tangerine",
    swatch: "#fd690f",
    bright: "#fd690f",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#d2550a",
    bubbleFg: "#ffffff",
  },
  {
    key: "yellow",
    label: "黄色",
    labelEn: "Amber",
    swatch: "#f59312",
    bright: "#f59312",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#c2730b",
    bubbleFg: "#ffffff",
  },
  {
    key: "green",
    label: "绿色",
    labelEn: "Emerald",
    swatch: "#14c16f",
    bright: "#14c16f",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#0d9655",
    bubbleFg: "#ffffff",
  },
  {
    key: "cyan",
    label: "青色",
    labelEn: "Teal",
    swatch: "#13b7a2",
    bright: "#13b7a2",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#0d9381",
    bubbleFg: "#ffffff",
  },
  {
    key: "blue",
    label: "蓝色",
    labelEn: "Cobalt",
    swatch: "#1e86fc",
    bright: "#1e86fc",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#126fd4",
    bubbleFg: "#ffffff",
  },
  {
    key: "violet",
    label: "紫罗兰色",
    labelEn: "Violet",
    swatch: "#8f59f9",
    bright: "#8f59f9",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#7442d1",
    bubbleFg: "#ffffff",
  },
  {
    key: "magenta",
    label: "洋红色",
    labelEn: "Magenta",
    swatch: "#f93498",
    bright: "#f93498",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#c82779",
    bubbleFg: "#ffffff",
  },
  {
    key: "gray",
    label: "灰色",
    labelEn: "Slate",
    swatch: "#71717a",
    bright: "#71717a",
    brightFg: "#ffffff",
    eye: "#ffffff",
    bubble: "#52525b",
    bubbleFg: "#ffffff",
  },
];

export const BOT_SHAPES: BotShapeSpec[] = [
  {
    key: "blob",
    label: "星灵",
    labelEn: "Astro",
    keywords: ["星灵", "机甲", "默认", "主控", "圆", "astro", "bot", "default"],
    // Primary TwinkleBot Astro-Visor Mascot: rounded squircle helmet + side ear-pods + top antenna orb
    path:
      "M32 4.6C34.1 4.6 35.8 6.3 35.8 8.4C35.8 9.9 34.9 11.2 33.6 11.8V14.2H40.2C47.8 14.2 53.2 19.6 53.2 27.2V28.2H54.6C56.6 28.2 58.2 29.8 58.2 31.8V37.2C58.2 39.2 56.6 40.8 54.6 40.8H53.2V42.4C53.2 50 47.8 55.4 40.2 55.4H23.8C16.2 55.4 10.8 50 10.8 42.4V40.8H9.4C7.4 40.8 5.8 39.2 5.8 37.2V31.8C5.8 29.8 7.4 28.2 9.4 28.2H10.8V27.2C10.8 19.6 16.2 14.2 23.8 14.2H30.4V11.8C29.1 11.2 28.2 9.9 28.2 8.4C28.2 6.3 29.9 4.6 32 4.6Z",
    face: "visor",
    faceY: 34.5,
  },
  {
    key: "cloud",
    label: "云灵",
    labelEn: "Cloud",
    keywords: ["云", "天气", "同步", "cloud", "sync"],
    path:
      "M23.5 12.5C27.8 8.2 36.2 8.2 40.5 12.5C46.5 12 52.2 16.2 53.2 22C58 25.8 58.8 33 55.2 38.2C57.2 44.2 53.8 50.8 47.6 52.8C43.2 56.8 36.4 57.2 32 55C27.6 57.2 20.8 56.8 16.4 52.8C10.2 50.8 6.8 44.2 8.8 38.2C5.2 33 6 25.8 10.8 22C11.8 16.2 17.5 12 23.5 12.5Z",
    face: "happy",
    faceY: 33.5,
  },
  {
    key: "square",
    label: "魔方",
    labelEn: "Cube",
    keywords: ["方", "盒", "块", "代码", "工程", "cube", "code", "dev"],
    // Cyber module block with top tech crown notch & chamfered side tabs
    path:
      "M19.5 8.5H26.5L28.5 11H35.5L37.5 8.5H44.5C51.2 8.5 55.5 12.8 55.5 19.5V44.5C55.5 51.2 51.2 55.5 44.5 55.5H19.5C12.8 55.5 8.5 51.2 8.5 44.5V19.5C8.5 12.8 12.8 8.5 19.5 8.5Z",
    face: "visor",
    faceY: 33,
  },
  {
    key: "sparkle",
    label: "双子星",
    labelEn: "Gemini",
    keywords: ["芒", "闪", "光", "双子", "spark", "gemini", "light"],
    // Plump rounded 4-point Gemini star
    path:
      "M32 5.5C34.4 5.5 36.1 7.3 37.3 10.8C39.8 18.2 45.8 24.2 53.2 26.7C56.7 27.9 58.5 29.6 58.5 32C58.5 34.4 56.7 36.1 53.2 37.3C45.8 39.8 39.8 45.8 37.3 53.2C36.1 56.7 34.4 58.5 32 58.5C29.6 58.5 27.9 56.7 26.7 53.2C24.2 45.8 18.2 39.8 10.8 37.3C7.3 36.1 5.5 34.4 5.5 32C5.5 29.6 7.3 27.9 10.8 26.7C18.2 24.2 24.2 18.2 26.7 10.8C27.9 7.3 29.6 5.5 32 5.5Z",
    face: "star",
    faceY: 32,
  },
  {
    key: "clover",
    label: "四叶灵",
    labelEn: "Clover",
    keywords: ["草", "叶", "幸运", "clover", "leaf"],
    path:
      "M32 7C38.6 7 43.8 11.8 44.4 18.2C50.8 18.8 55.6 24 55.6 30.6C55.6 34.2 54.1 37.4 51.6 39.6C54.1 41.8 55.6 45 55.6 48.6C55.6 54.2 51 57 45.2 57C40.4 57 35.6 54.6 32 51.2C28.4 54.6 23.6 57 18.8 57C13 57 8.4 54.2 8.4 48.6C8.4 45 9.9 41.8 12.4 39.6C9.9 37.4 8.4 34.2 8.4 30.6C8.4 24 13.2 18.8 19.6 18.2C20.2 11.8 25.4 7 32 7Z",
    face: "happy",
    faceY: 33.5,
  },
  {
    key: "heart",
    label: "暖心核",
    labelEn: "Heart",
    keywords: ["心", "爱", "关怀", "heart", "care", "love"],
    path:
      "M32 55.5C28.6 55.5 9.2 42.8 7.6 25.8C6.4 14.6 14.4 8.2 22.4 8.2C26.9 8.2 30.2 10.6 32 13.8C33.8 10.6 37.1 8.2 41.6 8.2C49.6 8.2 57.6 14.6 56.4 25.8C54.8 42.8 35.4 55.5 32 55.5Z",
    face: "happy",
    faceY: 29.5,
  },
  {
    key: "flower",
    label: "向阳花",
    labelEn: "Blossom",
    keywords: ["花", "设计", "创意", "flower", "design", "creative"],
    path:
      "M32 6.5C36.8 6.5 40.4 9.8 41 14.2C45.2 12.2 50.2 14.2 52.6 18.2C55 22.2 53.6 27.2 50 30.2C53.8 32.8 55.2 37.8 52.8 42C50.4 46 45.4 47.6 41 45.8C40.4 50.5 36.8 54.5 32 54.5C27.2 54.5 23.6 50.5 23 45.8C18.6 47.6 13.6 46 11.2 42C8.8 37.8 10.2 32.8 14 30.2C10.4 27.2 9 22.2 11.4 18.2C13.8 14.2 18.8 12.2 23 14.2C23.6 9.8 27.2 6.5 32 6.5Z",
    face: "happy",
    faceY: 31.5,
  },
  {
    key: "teardrop",
    label: "灵火滴",
    labelEn: "Flame",
    keywords: ["水", "滴", "火", "灵感", "flame", "drop", "idea"],
    path:
      "M32 6.8C35.8 6.8 53.5 23.2 53.5 37.8C53.5 49.4 44.2 56.8 32 56.8C19.8 56.8 10.5 49.4 10.5 37.8C10.5 23.2 28.2 6.8 32 6.8Z",
    face: "star",
    faceY: 37,
  },
  {
    key: "tablet",
    label: "护盾舱",
    labelEn: "Pod",
    keywords: ["胶囊", "屏", "盾", "终端", "pod", "terminal", "screen"],
    path:
      "M19 12H45C52.2 12 57.5 18.2 57.5 32C57.5 45.8 52.2 52 45 52H19C11.8 52 6.5 45.8 6.5 32C6.5 18.2 11.8 12 19 12Z",
    face: "visor",
    faceY: 32,
  },
  {
    key: "wedge",
    label: "灵狐",
    labelEn: "Fox",
    keywords: ["三角", "狐", "猫", "敏捷", "fox", "cat", "agile"],
    // Cyber-fox / cat-ear bot silhouette instead of plain wedge
    path:
      "M14.5 9.5C17.2 9.5 22.5 13.5 25.8 17.2H38.2C41.5 13.5 46.8 9.5 49.5 9.5C52.2 9.5 53.8 11.8 53.8 15.5V36.5C53.8 48.2 45 55.5 32 55.5C19 55.5 10.2 48.2 10.2 36.5V15.5C10.2 11.8 11.8 9.5 14.5 9.5Z",
    face: "focused",
    faceY: 35,
  },
  {
    key: "house",
    label: "守护堡",
    labelEn: "Fortress",
    keywords: ["房", "家", "屋", "管家", "安全", "home", "steward", "security"],
    path:
      "M32 7.5C34.2 7.5 36.2 8.4 38 9.8L52.5 21.5C55 23.6 56 26.2 56 29.8V45.5C56 51.5 51.8 55.5 45.8 55.5H18.2C12.2 55.5 8 51.5 8 45.5V29.8C8 26.2 9 23.6 11.5 21.5L26 9.8C27.8 8.4 29.8 7.5 32 7.5Z",
    face: "focused",
    faceY: 34.5,
  },
  {
    key: "star",
    label: "五芒星",
    labelEn: "Star",
    keywords: ["星", "五角星", "精选", "star"],
    path:
      "M32 6.8C34.2 6.8 35.8 8.2 37 11L40.8 19.8L50.4 20.8C53.4 21.1 55 22.8 55 25C55 26.6 54.1 28.1 52 30L44.8 36.4L46.9 45.8C47.6 48.8 46.6 51 44.4 52.2C42.6 53.1 40.6 52.8 38.2 51.4L32 47.6L25.8 51.4C23.4 52.8 21.4 53.1 19.6 52.2C17.4 51 16.4 48.8 17.1 45.8L19.2 36.4L12 30C9.9 28.1 9 26.6 9 25C9 22.8 10.6 21.1 13.6 20.8L23.2 19.8L27 11C28.2 8.2 29.8 6.8 32 6.8Z",
    face: "star",
    faceY: 33.5,
  },
  {
    key: "hex",
    label: "晶核盾",
    labelEn: "Hex",
    keywords: ["六边", "宝石", "机械", "运维", "hex", "ops"],
    path:
      "M28.2 7.8C30.6 6.5 33.4 6.5 35.8 7.8L50.8 16.4C53.2 17.8 54.6 20.2 54.6 23V41C54.6 43.8 53.2 46.2 50.8 47.6L35.8 56.2C33.4 57.5 30.6 57.5 28.2 56.2L13.2 47.6C10.8 46.2 9.4 43.8 9.4 41V23C9.4 20.2 10.8 17.8 13.2 16.4L28.2 7.8Z",
    face: "visor",
    faceY: 32,
  },
];

export function getBotColorLabel(
  key: string,
  locale: "zh-CN" | "en" = "zh-CN"
): string {
  const found = BOT_COLORS.find((c) => c.key === key);
  if (!found) return key;
  return locale === "en" ? found.labelEn : found.label;
}

export function getBotShapeLabel(
  key: string,
  locale: "zh-CN" | "en" = "zh-CN"
): string {
  const found = BOT_SHAPES.find((s) => s.key === key);
  if (!found) return key;
  return locale === "en" ? found.labelEn : found.label;
}

export const APPS_CATALOG = [
  {
    id: "qqmail",
    name: "QQ 邮箱",
    nameEn: "QQ Mail",
    desc: "使用 QQ 邮箱账号与 16 位授权码快速接入收发信",
    descEn: "Connect QQ Mail via email & 16-digit authorization code",
    cat: "communication",
    section: "邮箱接入",
    icon: "✉️",
  },
  {
    id: "custom-mail",
    name: "通用邮箱 (POP3 / IMAP + SMTP)",
    nameEn: "Generic Email (POP3 / IMAP + SMTP)",
    desc: "自定义 POP3/IMAP 收件服务器与 SMTP 发件服务器接入任意邮箱",
    descEn: "Configure custom POP3/IMAP & SMTP servers for any mailbox",
    cat: "communication",
    section: "邮箱接入",
    icon: "📬",
  },
];

export function hashString(str: unknown) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function isCurrentlyDark() {
  if (typeof document === "undefined") return false;
  const meta =
    (document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement | null)?.content ||
    "light dark";
  if (meta === "dark") return true;
  if (meta === "light") return false;
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true;
}

export function getResolvedColorMeta(colorKey = "black") {
  const raw = BOT_COLORS.find((c) => c.key === colorKey) || BOT_COLORS[0];
  if (raw.key !== "black") {
    return {
      key: raw.key,
      swatch: raw.swatch,
      bright: raw.bright,
      brightFg: raw.brightFg,
      eye: "#ffffff",
      bubble: raw.bubble,
      bubbleFg: raw.bubbleFg,
    };
  }
  const dark = isCurrentlyDark();
  return {
    key: "black",
    swatch: raw.swatch,
    bright: dark ? raw.darkBright : raw.lightBright,
    brightFg: dark ? raw.darkBrightFg : raw.lightBrightFg,
    eye: dark ? raw.darkEye : raw.lightEye,
    bubble: dark ? raw.darkBubble : raw.lightBubble,
    bubbleFg: dark ? raw.darkBubbleFg : raw.lightBubbleFg,
  };
}

export function getMascotFaceElements(
  shape: BotShapeSpec,
  eyeColor: string
): MascotFaceElement[] {
  const fy = shape.faceY || 32;
  switch (shape.face) {
    case "visor":
      return [
        {
          tag: "rect",
          attrs: {
            x: "16.5",
            y: String(fy - 7.5),
            width: "31",
            height: "15",
            rx: "7.5",
            fill: eyeColor,
            "fill-opacity": "0.2",
          },
        },
        {
          tag: "rect",
          attrs: {
            x: "22.2",
            y: String(fy - 4.1),
            width: "4.6",
            height: "8.2",
            rx: "2.3",
            fill: eyeColor,
          },
        },
        {
          tag: "rect",
          attrs: {
            x: "37.2",
            y: String(fy - 4.1),
            width: "4.6",
            height: "8.2",
            rx: "2.3",
            fill: eyeColor,
          },
        },
      ];

    case "star": {
      const sy = fy - 0.5;
      const starPath = `M38.8 ${sy - 5}C39.5 ${sy - 1.9} 41.9 ${sy - 0.8} 43.8 ${sy}C41.9 ${sy + 0.8} 39.5 ${sy + 1.9} 38.8 ${sy + 5}C38.1 ${sy + 1.9} 35.7 ${sy + 0.8} 33.8 ${sy}C35.7 ${sy - 0.8} 38.1 ${sy - 1.9} 38.8 ${sy - 5}Z`;
      return [
        {
          tag: "circle",
          attrs: {
            cx: "25.2",
            cy: String(sy),
            r: "3.2",
            fill: eyeColor,
          },
        },
        {
          tag: "path",
          attrs: {
            d: starPath,
            fill: eyeColor,
          },
        },
        {
          tag: "path",
          attrs: {
            d: `M28.8 ${fy + 5.6}Q32 ${fy + 7.8} 35.2 ${fy + 5.6}`,
            fill: "none",
            stroke: eyeColor,
            "stroke-width": "2.2",
            "stroke-linecap": "round",
          },
        },
      ];
    }

    case "happy":
      return [
        {
          tag: "path",
          attrs: {
            d: `M21.2 ${fy + 0.8}C22.2 ${fy - 3.4} 27.4 ${fy - 3.4} 28.4 ${fy + 0.8}`,
            fill: "none",
            stroke: eyeColor,
            "stroke-width": "3",
            "stroke-linecap": "round",
          },
        },
        {
          tag: "path",
          attrs: {
            d: `M35.6 ${fy + 0.8}C36.6 ${fy - 3.4} 41.8 ${fy - 3.4} 42.8 ${fy + 0.8}`,
            fill: "none",
            stroke: eyeColor,
            "stroke-width": "3",
            "stroke-linecap": "round",
          },
        },
        {
          tag: "path",
          attrs: {
            d: `M29.2 ${fy + 5.4}Q32 ${fy + 7.6} 34.8 ${fy + 5.4}`,
            fill: "none",
            stroke: eyeColor,
            "stroke-width": "2.2",
            "stroke-linecap": "round",
          },
        },
      ];

    case "focused":
      return [
        {
          tag: "circle",
          attrs: {
            cx: "24.6",
            cy: String(fy - 0.5),
            r: "3.3",
            fill: eyeColor,
          },
        },
        {
          tag: "circle",
          attrs: {
            cx: "39.4",
            cy: String(fy - 0.5),
            r: "3.3",
            fill: eyeColor,
          },
        },
        {
          tag: "path",
          attrs: {
            d: `M29.2 ${fy + 5.2}Q32 ${fy + 7.2} 34.8 ${fy + 5.2}`,
            fill: "none",
            stroke: eyeColor,
            "stroke-width": "2.2",
            "stroke-linecap": "round",
          },
        },
      ];
  }
}

export function createMascotSvg(shapeKey = "blob", colorKey = "black") {
  const shape = BOT_SHAPES.find((s) => s.key === shapeKey) || BOT_SHAPES[0];
  const color = getResolvedColorMeta(colorKey);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");

  const body = document.createElementNS(ns, "path");
  body.setAttribute("d", shape.path);
  body.setAttribute("fill", color.bright || "");
  svg.appendChild(body);

  for (const elSpec of getMascotFaceElements(shape, color.eye || "#ffffff")) {
    const node = document.createElementNS(ns, elSpec.tag);
    for (const [k, v] of Object.entries(elSpec.attrs)) {
      node.setAttribute(k, v);
    }
    svg.appendChild(node);
  }

  return svg;
}

export function renderAvatarNode(avatar: any = {}, _sizeVariant = "") {
  if (avatar?.imageDataUrl) {
    const img = document.createElement("img");
    img.className = "custom-avatar-img";
    img.src = avatar.imageDataUrl;
    img.alt = "";
    return img;
  }
  return createMascotSvg(avatar?.shape || "blob", avatar?.color || "black");
}

export function renderSessionAvatar(
  session: any,
  allSessions: any[] = [],
  primaryId: any = null,
  sizeVariant = ""
) {
  if (session?.type === "group") {
    const wrap = document.createElement("span");
    wrap.className = `group-avatar-cluster ${sizeVariant}`.trim();
    const memberIds = Array.isArray(session.memberBotIds) ? session.memberBotIds : [];
    const members = memberIds
      .map((id: any) => allSessions.find((s: any) => s.id === id))
      .filter(Boolean)
      .slice(0, 2);

    const list =
      members.length >= 2
        ? members
        : [
            { avatar: { shape: "blob", color: "blue" } },
            { avatar: { shape: "clover", color: "green" } },
          ];

    for (const m of list) {
      const slot = document.createElement("span");
      slot.className = "cluster-member";
      const av = resolveBotAvatar(m, primaryId);
      slot.appendChild(renderAvatarNode(av));
      wrap.appendChild(slot);
    }
    return wrap;
  }

  return renderAvatarNode(resolveBotAvatar(session, primaryId), sizeVariant);
}

export function resolveBotAvatar(session: any, primaryId: string | null = null) {
  if (!session) return { shape: "blob", color: "black" };
  if (session.avatar && (session.avatar.shape || session.avatar.color || session.avatar.imageDataUrl)) {
    return {
      shape: session.avatar.shape || "blob",
      color: session.avatar.color || (session.id === primaryId ? "black" : "blue"),
      imageDataUrl: session.avatar.imageDataUrl || null,
    };
  }
  if (session.id === primaryId) {
    return { shape: "blob", color: "black", imageDataUrl: null };
  }
  const h = hashString(session.id || session.title);
  const colorful = BOT_COLORS.slice(1, 10).map((c) => c.key);
  return {
    shape: BOT_SHAPES[h % BOT_SHAPES.length].key,
    color: colorful[h % colorful.length],
    imageDataUrl: null,
  };
}

export function parsePromptToAvatar(promptText = "") {
  const p = String(promptText || "").toLowerCase();
  const colorMap = [
    ["蓝", "blue"],
    ["blue", "blue"],
    ["绿", "green"],
    ["green", "green"],
    ["红", "red"],
    ["red", "red"],
    ["橙", "orange"],
    ["orange", "orange"],
    ["黄", "yellow"],
    ["yellow", "yellow"],
    ["amber", "yellow"],
    ["紫", "violet"],
    ["violet", "violet"],
    ["purple", "violet"],
    ["粉", "magenta"],
    ["洋红", "magenta"],
    ["magenta", "magenta"],
    ["pink", "magenta"],
    ["青", "cyan"],
    ["cyan", "cyan"],
    ["teal", "cyan"],
    ["棕", "brown"],
    ["brown", "brown"],
    ["灰", "gray"],
    ["gray", "gray"],
    ["grey", "gray"],
    ["黑", "black"],
    ["black", "black"],
  ];
  let matchedColor: string | null = null;
  for (const [kw, key] of colorMap) {
    if (p.includes(kw)) {
      matchedColor = key;
      break;
    }
  }

  let matchedShape: string | null = null;
  for (const s of BOT_SHAPES) {
    if (
      p.includes(s.label) ||
      p.includes(s.labelEn.toLowerCase()) ||
      s.keywords.some((kw) => p.includes(kw))
    ) {
      matchedShape = s.key;
      break;
    }
  }

  const h = hashString(p);
  const colorful = BOT_COLORS.slice(1, 10).map((c) => c.key);
  return {
    shape: matchedShape || BOT_SHAPES[h % BOT_SHAPES.length].key,
    color: matchedColor || colorful[h % colorful.length],
    imageDataUrl: null,
  };
}

export function cropImageFileToDataUrl(
  file: Blob,
  size = 128,
  locale: "zh-CN" | "en" = "zh-CN"
) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(locale === "en" ? "Failed to read image" : "读取图片失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () =>
        reject(new Error(locale === "en" ? "Failed to decode image" : "解析图片失败"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d")!;
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
