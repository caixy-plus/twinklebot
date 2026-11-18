import { useEffect, useRef, useState } from "react";
import { buildPreviewSrcdoc } from "../../preview-utils.js";
import { openHtmlPreviewModal, showToast } from "../../services/actions.js";
import { BG_MODES } from "../../state/constants.js";
import {
  nextPreviewInstanceId,
  previewFrameRegistry,
  teardownPreviewIframe,
} from "../../state/helpers.js";
import { UiIcon } from "../common/Icon.js";

export function MarkupPreviewCard({
  code,
  kind = "html",
  badgeLabel = "HTML 预览",
  lang = "html",
  sourceLabel = "",
  downloadUrl = "",
}: {
  code: string;
  kind?: "html" | "svg";
  badgeLabel?: string;
  lang?: string;
  sourceLabel?: string;
  downloadUrl?: string;
}) {
  const cleanCode = String(code || "").trim();
  const [instanceId] = useState(() => nextPreviewInstanceId());
  const [bgIdx, setBgIdx] = useState(() => (kind === "svg" ? 1 : 0));
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [reloadNonce, setReloadNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const canvasBg = BG_MODES[bgIdx]?.key || "light";
  const srcdoc = cleanCode
    ? buildPreviewSrcdoc(cleanCode, {
        kind,
        instanceId,
        canvasBg,
      })
    : "";

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    previewFrameRegistry.set(instanceId, iframe);
    return () => {
      previewFrameRegistry.delete(instanceId);
      teardownPreviewIframe(iframe);
    };
  }, [instanceId]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      iframe.contentWindow?.postMessage(
        mode === "preview"
          ? { __twinklebotPreviewResume: true }
          : { __twinklebotPreviewPause: true },
        "*"
      );
    } catch {}
  }, [mode]);

  if (!cleanCode) return null;

  const isPrev = mode === "preview";

  const handleSvgBlobDownload = () => {
    const blob = new Blob([cleanCode], { type: "image/svg+xml;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = sourceLabel && /\.svg$/i.test(sourceLabel) ? sourceLabel : "drawing.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  };

  return (
    <div className="msg-preview-card" data-preview-kind={kind}>
      <div className="msg-preview-header">
        <div className="msg-preview-title-wrap">
          <span className="msg-preview-badge" data-kind={kind}>
            {badgeLabel}
          </span>
          {sourceLabel && <span className="msg-preview-sub">{sourceLabel}</span>}
        </div>
        <div className="msg-preview-actions">
          <div className="msg-preview-tabs" role="group" aria-label="切换预览与源码">
            <button
              type="button"
              className={`msg-preview-tab${isPrev ? " is-active" : ""}`}
              onClick={() => setMode("preview")}
            >
              预览
            </button>
            <button
              type="button"
              className={`msg-preview-tab${!isPrev ? " is-active" : ""}`}
              onClick={() => setMode("code")}
            >
              源码
            </button>
          </div>
          <button
            type="button"
            className="msg-preview-btn"
            hidden={!isPrev}
            onClick={() => setBgIdx((prev) => (prev + 1) % BG_MODES.length)}
          >
            {BG_MODES[bgIdx].label}
          </button>
          <button
            type="button"
            className="msg-preview-btn"
            aria-label="刷新预览"
            hidden={!isPrev}
            onClick={() => {
              teardownPreviewIframe(iframeRef.current);
              setReloadNonce((n) => n + 1);
            }}
          >
            <UiIcon name="refresh" className="inline-ui-icon" size={13} />
          </button>
          <button
            type="button"
            className="msg-preview-btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(cleanCode);
              } catch {}
              showToast("源码已复制");
            }}
          >
            复制
          </button>
          {downloadUrl ? (
            <a
              className="msg-preview-btn"
              href={downloadUrl}
              download={
                sourceLabel || (kind === "svg" ? "generated.svg" : `preview.${lang || "html"}`)
              }
              style={{ textDecoration: "none" }}
            >
              下载
            </a>
          ) : kind === "svg" ? (
            <button type="button" className="msg-preview-btn" onClick={handleSvgBlobDownload}>
              下载
            </button>
          ) : null}
          <button
            type="button"
            className="msg-preview-btn"
            onClick={() =>
              openHtmlPreviewModal({
                code: cleanCode,
                kind,
                badgeLabel,
                lang,
                canvasBg,
              })
            }
          >
            <UiIcon name="arrow-up-right" className="inline-ui-icon" size={13} />
            放大
          </button>
        </div>
      </div>

      <div className="msg-preview-stage" hidden={!isPrev}>
        <iframe
          key={reloadNonce}
          ref={(node) => {
            iframeRef.current = node;
            if (node) previewFrameRegistry.set(instanceId, node);
          }}
          className="msg-preview-iframe"
          sandbox="allow-scripts allow-forms"
          loading="lazy"
          title={`${badgeLabel}${sourceLabel ? ` (${sourceLabel})` : ""}`}
          srcDoc={srcdoc}
        />
      </div>

      <pre
        className="msg-preview-code-pre"
        role="region"
        aria-label={`${badgeLabel} 源码`}
        tabIndex={0}
        hidden={isPrev}
      >
        <code className={`language-${lang}`}>{cleanCode}</code>
      </pre>
    </div>
  );
}
