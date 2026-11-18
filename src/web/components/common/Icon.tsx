import type { CSSProperties, ReactNode } from "react";

export type UiIconName =
  | "gear"
  | "models-diamond"
  | "monitor"
  | "shield-check"
  | "vault-safe"
  | "bar-chart"
  | "sparkle"
  | "laptop"
  | "linux-container"
  | "cloud"
  | "cloud-download"
  | "smartphone"
  | "desktop-control"
  | "terminal"
  | "ai-image"
  | "collab-users"
  | "custom-modules"
  | "globe"
  | "pointer-cursor"
  | "mail"
  | "inbox"
  | "zap"
  | "brain"
  | "key"
  | "user"
  | "users"
  | "bot"
  | "lock"
  | "plus"
  | "x"
  | "check"
  | "check-circle"
  | "x-circle"
  | "alert-triangle"
  | "refresh"
  | "chevron-left"
  | "chevron-right"
  | "arrow-up"
  | "arrow-down"
  | "arrow-up-right"
  | "arrows-exchange"
  | "reply"
  | "quote"
  | "copy"
  | "star"
  | "file-text"
  | "pencil"
  | "thought"
  | "lightbulb"
  | "stop-square"
  | "alarm"
  | "pin"
  | "power";

function renderIconPaths(name: UiIconName): ReactNode {
  switch (name) {
    case "gear":
      return (
        <>
          <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.55" />
          <path
            d="M10 3.1V4.7M10 15.3V16.9M3.1 10H4.7M15.3 10H16.9M5.12 5.12L6.25 6.25M13.75 13.75L14.88 14.88M14.88 5.12L13.75 6.25M6.25 13.75L5.12 14.88"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
          />
          <circle cx="10" cy="10" r="5.3" stroke="currentColor" strokeWidth="1.45" strokeDasharray="2.1 2.05" />
        </>
      );
    case "models-diamond":
      return (
        <>
          <path d="M10 2.6L17.4 10L10 17.4L2.6 10L10 2.6Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
          <path d="M10 6.5L13.5 10L10 13.5L6.5 10L10 6.5Z" fill="currentColor" opacity="0.9" />
        </>
      );
    case "monitor":
      return (
        <>
          <rect x="2.8" y="3.8" width="14.4" height="9.6" rx="2" stroke="currentColor" strokeWidth="1.55" />
          <path d="M7.2 16.4H12.8M10 13.4V16.4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
        </>
      );
    case "shield-check":
      return (
        <>
          <path
            d="M10 2.8L15.8 5V9.5C15.8 13.3 13.3 15.9 10 17.2C6.7 15.9 4.2 13.3 4.2 9.5V5L10 2.8Z"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinejoin="round"
          />
          <path d="M7.5 10.1L9.2 11.8L12.7 8.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "vault-safe":
      return (
        <>
          <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="2.8" stroke="currentColor" strokeWidth="1.55" />
          <rect x="5.9" y="5.9" width="8.2" height="8.2" rx="1.4" stroke="currentColor" strokeWidth="1.35" />
          <circle cx="10" cy="10" r="1.55" fill="currentColor" />
        </>
      );
    case "bar-chart":
      return <path d="M5.4 15.8V10.8M10 15.8V4.6M14.6 15.8V8.2" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />;
    case "sparkle":
      return (
        <path
          d="M10 2.6C10.55 6.8 13.2 9.45 17.4 10C13.2 10.55 10.55 13.2 10 17.4C9.45 13.2 6.8 10.55 2.6 10C6.8 9.45 9.45 6.8 10 2.6Z"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinejoin="round"
        />
      );
    case "laptop":
      return (
        <>
          <rect x="3.8" y="4.5" width="12.4" height="8.6" rx="1.7" stroke="currentColor" strokeWidth="1.55" />
          <path d="M2.2 15.6H17.8" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
        </>
      );
    case "linux-container":
      return (
        <>
          <rect x="3" y="4" width="14" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.55" />
          <path d="M6.4 8.1L8.9 10.1L6.4 12.1M10.4 12.1H13.6" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "cloud":
      return (
        <path
          d="M6.2 15H14.1A3.1 3.1 0 0 0 14.6 8.9A4.4 4.4 0 0 0 6.1 9.7A2.65 2.65 0 0 0 6.2 15Z"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinejoin="round"
        />
      );
    case "cloud-download":
      return (
        <>
          <path
            d="M6.6 13.7C4.55 13.7 3 12.2 3 10.35C3 8.7 4.2 7.36 5.8 7.12C6.42 5.02 8.28 3.6 10.45 3.6C13.02 3.6 15.1 5.56 15.3 8.06C16.7 8.46 17.6 9.72 17.6 11.15C17.6 12.64 16.52 13.7 14.85 13.7H13.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10 9.4V16.1M7.65 13.85L10 16.2L12.35 13.85"
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "smartphone":
      return (
        <>
          <rect x="5.5" y="2.6" width="9" height="14.8" rx="2.2" stroke="currentColor" strokeWidth="1.55" />
          <path d="M8.7 14.8H11.3" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
        </>
      );
    case "desktop-control":
      return (
        <>
          <rect x="2.8" y="3.8" width="14.4" height="9.6" rx="2" stroke="currentColor" strokeWidth="1.55" />
          <path d="M7.2 16.4H12.8M10 13.4V16.4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
          <path d="M9.1 7.1L12.3 9.2L10.7 9.8L10.1 11.4L9.1 7.1Z" fill="currentColor" />
        </>
      );
    case "terminal":
      return (
        <>
          <rect x="2.8" y="4" width="14.4" height="12" rx="2.4" stroke="currentColor" strokeWidth="1.55" />
          <path d="M6.2 8.2L8.7 10.1L6.2 12M10.3 12H13.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "ai-image":
      return (
        <>
          <rect x="3" y="3.8" width="14" height="12.4" rx="2.4" stroke="currentColor" strokeWidth="1.55" />
          <circle cx="7.3" cy="7.9" r="1.25" fill="currentColor" />
          <path d="M4.3 14.5L8.2 10.6L11 13.2L12.9 11.4L15.7 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "collab-users":
    case "users":
      return (
        <>
          <circle cx="7.7" cy="7.3" r="2.3" stroke="currentColor" strokeWidth="1.55" />
          <path d="M3.6 15.6C3.9 13.3 5.6 12 7.7 12C9.8 12 11.5 13.3 11.8 15.6" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
          <circle cx="13.4" cy="8.1" r="1.8" stroke="currentColor" strokeWidth="1.45" />
          <path d="M13 12.4C14.7 12.6 16 13.7 16.3 15.5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
        </>
      );
    case "custom-modules":
      return (
        <>
          <rect x="3.3" y="3.3" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.55" />
          <rect x="11.3" y="3.3" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.55" />
          <rect x="3.3" y="11.3" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.55" />
          <path d="M14 11.4V16.6M11.4 14H16.6" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
        </>
      );
    case "globe":
      return (
        <>
          <circle cx="10" cy="10" r="6.8" stroke="currentColor" strokeWidth="1.55" />
          <ellipse cx="10" cy="10" rx="3" ry="6.8" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3.5 10H16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "pointer-cursor":
      return (
        <>
          <path d="M5.2 3.8L15.1 9.5L10.7 10.9L9.3 15.3L5.2 3.8Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
          <path d="M11.1 11.3L14.8 15" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
        </>
      );
    case "mail":
      return (
        <>
          <rect x="3" y="4.6" width="14" height="10.8" rx="2.2" stroke="currentColor" strokeWidth="1.55" />
          <path d="M4.1 6.1L10 10.7L15.9 6.1" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "inbox":
      return (
        <>
          <rect x="3" y="4" width="14" height="12" rx="2.4" stroke="currentColor" strokeWidth="1.55" />
          <path d="M3.4 11.4H6.9L8 13.1H12L13.1 11.4H16.6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M10 6.8V10.1M8.2 8.4L10 10.2L11.8 8.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "zap":
      return <path d="M11.1 2.7L4.8 11H9.7L8.9 17.3L15.2 9H10.3L11.1 2.7Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />;
    case "brain":
      return (
        <path
          d="M10 4.6V15.4M10 5.4C8.4 3.9 5.6 4.5 5 6.7C3.6 7.3 3.3 9.4 4.4 10.6C3.7 12.4 5 14.7 7.1 14.8C8 15.8 9.4 15.8 10 15.1M10 5.4C11.6 3.9 14.4 4.5 15 6.7C16.4 7.3 16.7 9.4 15.6 10.6C16.3 12.4 15 14.7 12.9 14.8C12 15.8 10.6 15.8 10 15.1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "key":
      return (
        <>
          <circle cx="7.1" cy="11.8" r="3.1" stroke="currentColor" strokeWidth="1.55" />
          <path d="M9.4 9.7L15.8 3.6M13.3 6L15.2 7.9M15 4.4L16.7 6.1" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "user":
      return (
        <>
          <circle cx="10" cy="6.9" r="2.8" stroke="currentColor" strokeWidth="1.55" />
          <path d="M4.6 16.2C5 13.3 7.2 11.7 10 11.7C12.8 11.7 15 13.3 15.4 16.2" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
        </>
      );
    case "bot":
      return (
        <>
          <rect x="4" y="6.2" width="12" height="9.6" rx="3.2" stroke="currentColor" strokeWidth="1.55" />
          <path d="M10 3.3V6.2" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
          <circle cx="8" cy="11" r="1.05" fill="currentColor" />
          <circle cx="12" cy="11" r="1.05" fill="currentColor" />
        </>
      );
    case "lock":
      return (
        <>
          <rect x="4.5" y="8.8" width="11" height="7.6" rx="2" stroke="currentColor" strokeWidth="1.55" />
          <path d="M7 8.8V6.7A3 3 0 0 1 13 6.7V8.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
        </>
      );
    case "plus":
      return <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />;
    case "x":
      return <path d="M5.5 5.5L14.5 14.5M14.5 5.5L5.5 14.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />;
    case "check":
      return <path d="M4.8 10.4L8.3 13.8L15.4 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />;
    case "check-circle":
      return (
        <>
          <circle cx="10" cy="10" r="6.8" stroke="currentColor" strokeWidth="1.55" />
          <path d="M7.1 10.2L9.1 12.2L13.1 8.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "x-circle":
      return (
        <>
          <circle cx="10" cy="10" r="6.8" stroke="currentColor" strokeWidth="1.55" />
          <path d="M7.6 7.6L12.4 12.4M12.4 7.6L7.6 12.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case "alert-triangle":
      return (
        <>
          <path
            d="M10 3.4L16.8 15.4C17.1 16 16.7 16.7 16 16.7H4C3.3 16.7 2.9 16 3.2 15.4L10 3.4Z"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinejoin="round"
          />
          <path d="M10 7.8V11.4" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
          <circle cx="10" cy="13.8" r="0.85" fill="currentColor" />
        </>
      );
    case "refresh":
      return (
        <>
          <path d="M15.6 8.3A5.8 5.8 0 0 0 5.4 6.5M4.4 11.7A5.8 5.8 0 0 0 14.6 13.5" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
          <path d="M15.8 4.8V8.4H12.2M4.2 15.2V11.6H7.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "chevron-left":
      return <path d="M12.2 5.2L7.4 10L12.2 14.8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />;
    case "chevron-right":
      return <path d="M7.8 5.2L12.6 10L7.8 14.8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />;
    case "arrow-up":
      return <path d="M10 15.2V4.8M10 4.8L5.7 9.1M10 4.8L14.3 9.1" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />;
    case "arrow-down":
      return <path d="M10 4.8V15.2M10 15.2L5.7 10.9M10 15.2L14.3 10.9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />;
    case "arrow-up-right":
      return <path d="M6.2 13.8L13.8 6.2M8.2 6.2H13.8V11.8" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />;
    case "arrows-exchange":
      return (
        <path
          d="M4.2 7.2H15.5M12.5 4.4L15.6 7.2L12.5 10M15.8 12.8H4.5M7.5 10L4.4 12.8L7.5 15.6"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "reply":
      return (
        <>
          <path d="M7.6 5.2L4.1 8.7L7.6 12.2" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.5 8.7H12.2A3.6 3.6 0 0 1 15.8 12.3V14.4" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
        </>
      );
    case "quote":
      return (
        <>
          <path d="M5.2 13.6V9.8C5.2 7.9 6.3 6.5 8.1 6.1M11.6 13.6V9.8C11.6 7.9 12.7 6.5 14.5 6.1" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
          <rect x="5" y="10.4" width="3.1" height="3.2" rx="0.8" stroke="currentColor" strokeWidth="1.45" />
          <rect x="11.4" y="10.4" width="3.1" height="3.2" rx="0.8" stroke="currentColor" strokeWidth="1.45" />
        </>
      );
    case "copy":
      return (
        <>
          <rect x="7.4" y="6.8" width="8.6" height="9.6" rx="1.8" stroke="currentColor" strokeWidth="1.55" />
          <path d="M12.6 6.8V5.2A1.6 1.6 0 0 0 11 3.6H5.6A1.6 1.6 0 0 0 4 5.2V11.6A1.6 1.6 0 0 0 5.6 13.2H7.4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
        </>
      );
    case "star":
      return <path d="M10 3.2L12.05 7.35L16.6 8.02L13.3 11.24L14.08 15.78L10 13.63L5.92 15.78L6.7 11.24L3.4 8.02L7.95 7.35L10 3.2Z" fill="currentColor" />;
    case "file-text":
      return (
        <>
          <path
            d="M5.2 3.2H11.5L14.8 6.5V16.2A1.4 1.4 0 0 1 13.4 17.6H5.2A1.4 1.4 0 0 1 3.8 16.2V4.6A1.4 1.4 0 0 1 5.2 3.2Z"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinejoin="round"
          />
          <path d="M11.3 3.4V6.7H14.6M7 10.2H12M7 13H10.5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
        </>
      );
    case "pencil":
      return (
        <>
          <path d="M12.9 4.2L15.8 7.1L7.5 15.4L4.2 16L4.8 12.7L12.9 4.2Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
          <path d="M11.1 6L14 8.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
    case "thought":
      return (
        <>
          <path
            d="M10 3.5C10.45 6.95 12.6 9.1 16 9.55C12.6 10 10.45 12.15 10 15.6C9.55 12.15 7.4 10 4 9.55C7.4 9.1 9.55 6.95 10 3.5Z"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinejoin="round"
          />
          <circle cx="15" cy="15" r="1.05" fill="currentColor" />
        </>
      );
    case "lightbulb":
      return (
        <>
          <path
            d="M7.7 13.5C7.4 12.2 6.2 11.2 6.2 9.2A3.8 3.8 0 0 1 13.8 9.2C13.8 11.2 12.6 12.2 12.3 13.5H7.7Z"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinejoin="round"
          />
          <path d="M8.2 16H11.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case "stop-square":
      return <rect x="5.4" y="5.4" width="9.2" height="9.2" rx="2" stroke="currentColor" strokeWidth="1.6" />;
    case "alarm":
      return (
        <>
          <circle cx="10" cy="10.8" r="5.6" stroke="currentColor" strokeWidth="1.55" />
          <path d="M10 8V11L12 12.2M5.2 4.3L3.5 5.9M14.8 4.3L16.5 5.9" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "pin":
      return (
        <>
          <path d="M7.3 4.3H12.7L12 8.7L14.2 10.7V11.8H5.8V10.7L8 8.7L7.3 4.3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M10 11.8V16.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case "power":
      return <path d="M10 3.5V10M6.2 5.4A6.2 6.2 0 1 0 13.8 5.4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />;
    default:
      return (
        <path
          d="M10 2.6C10.55 6.8 13.2 9.45 17.4 10C13.2 10.55 10.55 13.2 10 17.4C9.45 13.2 6.8 10.55 2.6 10C6.8 9.45 9.45 6.8 10 2.6Z"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinejoin="round"
        />
      );
  }
}

export function UiIcon({
  name,
  className,
  size,
  style,
}: {
  name: UiIconName;
  className?: string;
  size?: number;
  style?: CSSProperties;
}) {
  const mergedStyle: CSSProperties | undefined = size
    ? { width: `${size}px`, height: `${size}px`, ...style }
    : style;
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={className ? `icon-svg ${className}` : "icon-svg"}
      style={mergedStyle}
    >
      {renderIconPaths(name)}
    </svg>
  );
}

const SKILL_ICON_BY_KEY: Record<string, UiIconName> = {
  "desktop-control": "desktop-control",
  "shell-and-files": "terminal",
  "ai-image": "ai-image",
  "multi-bot-collab": "collab-users",
  "interactive-cards": "shield-check",
  "custom-skill-manager": "custom-modules",
  websearch: "globe",
  "kimi-cu": "pointer-cursor",
  qqmail: "mail",
  "custom-mail": "inbox",
  memory: "brain",
  "custom-skill": "zap",
  "🖥️": "desktop-control",
  "🖥": "desktop-control",
  "⌨️": "terminal",
  "⌨": "terminal",
  "🎨": "ai-image",
  "🤝": "collab-users",
  "🛡️": "shield-check",
  "🛡": "shield-check",
  "🧩": "custom-modules",
  "🌐": "globe",
  "🖱️": "pointer-cursor",
  "🖱": "pointer-cursor",
  "✉️": "mail",
  "✉": "mail",
  "📬": "inbox",
  "⚡": "zap",
  "🧠": "brain",
  "🤖": "bot",
  "👤": "user",
  "👥": "users",
  "🔑": "key",
  "🔒": "lock",
  "💻": "laptop",
  "🐧": "linux-container",
  "☁️": "cloud",
  "☁": "cloud",
  "📱": "smartphone",
};

export function resolveSkillIconName(
  skillId?: string | null,
  rawIcon?: string | null
): UiIconName | null {
  const id = String(skillId || "").trim();
  if (id && SKILL_ICON_BY_KEY[id]) return SKILL_ICON_BY_KEY[id];
  const raw = String(rawIcon || "").trim();
  if (raw && SKILL_ICON_BY_KEY[raw]) return SKILL_ICON_BY_KEY[raw];
  if (!raw) return "zap";
  return null;
}

const LEADING_STATUS_MAP: Array<[RegExp, UiIconName]> = [
  [/^(?:✓|✔|✅)\s*/, "check-circle"],
  [/^(?:❌|✕|✖)\s*/, "x-circle"],
  [/^(?:⚠️|⚠)\s*/, "alert-triangle"],
  [/^(?:📱)\s*/, "smartphone"],
  [/^(?:⏰)\s*/, "alarm"],
  [/^(?:📌)\s*/, "pin"],
  [/^(?:🔒)\s*/, "lock"],
  [/^(?:🛡|🛡️)\s*/, "shield-check"],
  [/^(?:💻)\s*/, "laptop"],
  [/^(?:☁️|☁)\s*/, "cloud"],
  [/^(?:🖱️|🖱)\s*/, "pointer-cursor"],
  [/^(?:⏹)\s*/, "stop-square"],
  [/^(?:💡)\s*/, "lightbulb"],
  [/^(?:↻)\s*/, "refresh"],
];

export function stripLeadingStatusGlyph(raw: string): { icon: UiIconName | null; text: string } {
  const s = String(raw || "");
  for (const [re, icon] of LEADING_STATUS_MAP) {
    if (re.test(s)) {
      return { icon, text: s.replace(re, "").trimStart() };
    }
  }
  return { icon: null, text: s };
}

export function StatusText({
  text,
  iconSize = 14,
  iconClassName = "inline-ui-icon",
}: {
  text: string;
  iconSize?: number;
  iconClassName?: string;
}) {
  const parsed = stripLeadingStatusGlyph(text);
  if (!parsed.icon) return <>{parsed.text}</>;
  return (
    <>
      <UiIcon name={parsed.icon} className={iconClassName} size={iconSize} />
      {parsed.text}
    </>
  );
}
