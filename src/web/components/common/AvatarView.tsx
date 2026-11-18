import {
  BOT_SHAPES,
  getMascotFaceElements,
  getResolvedColorMeta,
  resolveBotAvatar,
} from "../../avatars.js";

function toReactSvgProps(attrs: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "fill-opacity") out.fillOpacity = v;
    else if (k === "stroke-width") out.strokeWidth = v;
    else if (k === "stroke-linecap") out.strokeLinecap = v;
    else if (k === "stroke-linejoin") out.strokeLinejoin = v;
    else out[k] = v;
  }
  return out;
}

export function MascotSvg({
  shapeKey = "blob",
  colorKey = "black",
}: {
  shapeKey?: string;
  colorKey?: string;
}) {
  const shape = BOT_SHAPES.find((s) => s.key === shapeKey) || BOT_SHAPES[0];
  const color = getResolvedColorMeta(colorKey);
  const faceNodes = getMascotFaceElements(shape, color.eye || "#ffffff");

  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d={shape.path} fill={color.bright || ""} />
      {faceNodes.map((el, idx) => {
        const props = toReactSvgProps(el.attrs);
        if (el.tag === "rect") return <rect key={idx} {...props} />;
        if (el.tag === "circle") return <circle key={idx} {...props} />;
        return <path key={idx} {...props} />;
      })}
    </svg>
  );
}

export function AvatarNode({
  avatar,
}: {
  avatar?: { shape?: string; color?: string; imageDataUrl?: string | null } | null;
}) {
  if (avatar?.imageDataUrl) {
    return <img className="custom-avatar-img" src={avatar.imageDataUrl} alt="" />;
  }
  return <MascotSvg shapeKey={avatar?.shape || "blob"} colorKey={avatar?.color || "black"} />;
}

export function SessionAvatar({
  session,
  allSessions = [],
  primaryId = null,
  sizeVariant = "",
}: {
  session: any;
  allSessions?: any[];
  primaryId?: string | null;
  sizeVariant?: string;
}) {
  if (session?.type === "group") {
    const memberIds = Array.isArray(session.memberBotIds) ? session.memberBotIds : [];
    const members = memberIds
      .map((id: string) => allSessions.find((s: any) => s.id === id))
      .filter(Boolean)
      .slice(0, 2);

    const list =
      members.length >= 2
        ? members
        : [
            { avatar: { shape: "blob", color: "blue" } },
            { avatar: { shape: "clover", color: "green" } },
          ];

    return (
      <span className={`group-avatar-cluster ${sizeVariant}`.trim()}>
        {list.map((m: any, idx: number) => {
          const av = resolveBotAvatar(m, primaryId);
          return (
            <span key={m?.id || idx} className="cluster-member">
              <AvatarNode avatar={av} />
            </span>
          );
        })}
      </span>
    );
  }

  return <AvatarNode avatar={resolveBotAvatar(session, primaryId)} />;
}
