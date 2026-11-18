export const VALID_PROFILE_COLORS = new Set([
  "slate",
  "blue",
  "green",
  "amber",
  "rose",
  "purple",
  "teal",
]);

export const VALID_HOST_EXEC_MODES = new Set(["always", "ask", "off"]);

export const DEFAULT_POLICY = {
  autoAudit: true,
  askRules: [] as string[],
  allowRules: [] as string[],
};

export const DEFAULT_PRIVATE_SKILLS = [
  {
    id: "workspace-files",
    name: "工作区文件读写",
    description: "允许 Bot 在配置的工作区白名单目录内读写文件",
    enabled: true,
  },
  {
    id: "desktop-automation",
    name: "Bot 电脑桌面自动化",
    description: "允许 Bot 操控隔离的 Ubuntu XFCE 桌面与浏览器",
    enabled: true,
  },
];
