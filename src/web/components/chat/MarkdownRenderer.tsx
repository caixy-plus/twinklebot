import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  isSafeMarkdownUrl,
  parseMarkdownBlocks,
  tokenizeInlineMarkdown,
} from "../../markdown-utils.js";
import {
  detectPreviewableMarkup,
  extractMessageSegments,
} from "../../preview-utils.js";
import {
  openImageLightbox,
  openLocalFile,
  showToast,
} from "../../services/actions.js";
import { apiFetch, apiUrl } from "../../services/api-client.js";
import {
  describeFileExtension,
  formatFileBuildTime,
  formatFileBytes,
} from "../../state/helpers.js";
import { UiIcon } from "../common/Icon.js";
import { MarkupPreviewCard } from "./MarkupPreviewCard.js";

function InlineTokens({ tokens }: { tokens: any[] }) {
  return (
    <>
      {tokens.map((tok, idx) => {
        if (!tok) return null;
        if (tok.type === "code") {
          return <code key={idx}>{tok.text}</code>;
        }
        if (tok.type === "strong") {
          return (
            <strong key={idx}>
              {Array.isArray(tok.children) && tok.children.length > 0 ? (
                <InlineTokens tokens={tok.children} />
              ) : (
                tok.text
              )}
            </strong>
          );
        }
        if (tok.type === "em") {
          return (
            <em key={idx}>
              {Array.isArray(tok.children) && tok.children.length > 0 ? (
                <InlineTokens tokens={tok.children} />
              ) : (
                tok.text
              )}
            </em>
          );
        }
        if (tok.type === "del") {
          return (
            <del key={idx}>
              {Array.isArray(tok.children) && tok.children.length > 0 ? (
                <InlineTokens tokens={tok.children} />
              ) : (
                tok.text
              )}
            </del>
          );
        }
        if (tok.type === "link" && isSafeMarkdownUrl(tok.href)) {
          return (
            <a
              key={idx}
              className="msg-md-link"
              href={tok.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {Array.isArray(tok.children) && tok.children.length > 0 ? (
                <InlineTokens tokens={tok.children} />
              ) : (
                tok.text || tok.href
              )}
            </a>
          );
        }
        if (tok.type === "file_link" && tok.path) {
          return (
            <button
              key={idx}
              type="button"
              className="msg-md-link msg-file-inline-link"
              title={`点击打开本地文件: ${tok.path}`}
              onClick={() => openLocalFile(tok.path)}
            >
              <span className="msg-file-inline-icon">
                <UiIcon name="file-text" size={13} />
              </span>
              <span>
                {Array.isArray(tok.children) && tok.children.length > 0 ? (
                  <InlineTokens tokens={tok.children} />
                ) : (
                  tok.text || tok.path
                )}
              </span>
            </button>
          );
        }
        return <Fragment key={idx}>{tok.text || ""}</Fragment>;
      })}
    </>
  );
}

function InlineFormatted({ text }: { text: string }) {
  const tokens = tokenizeInlineMarkdown(String(text ?? ""));
  return <InlineTokens tokens={tokens} />;
}

function CodeBlock({ code, langLabel = "code" }: { code: string; langLabel?: string }) {
  const label = langLabel || "code";
  return (
    <div className="msg-code-block">
      <div className="msg-code-header">
        <span>{label}</span>
        <button
          type="button"
          className="msg-code-copy-btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
            } catch {}
            showToast("代码已复制");
          }}
        >
          复制
        </button>
      </div>
      <pre
        className="msg-code-pre"
        role="region"
        aria-label={`${langLabel || "代码"} 代码片段`}
        tabIndex={0}
      >
        <code className={langLabel ? `language-${langLabel}` : undefined}>{code}</code>
      </pre>
    </div>
  );
}

function TableBlock({ block }: { block: any }) {
  return (
    <div className="msg-table-wrap">
      <div className="msg-table-toolbar">
        <span className="msg-table-meta">表格 · {block.rows.length} 行</span>
        <button
          type="button"
          className="msg-code-copy-btn msg-table-copy-btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(block.tsv || block.raw || "");
            } catch {}
            showToast("表格已复制");
          }}
        >
          复制表格
        </button>
      </div>
      <div className="msg-table-scroll">
        <table className="msg-table">
          <thead>
            <tr>
              {block.headers.map((hText: string, colIdx: number) => {
                const align = block.alignments[colIdx] || "left";
                return (
                  <th
                    key={colIdx}
                    style={align !== "left" ? { textAlign: align } : undefined}
                  >
                    <InlineFormatted text={hText} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row: string[], rIdx: number) => (
              <tr key={rIdx}>
                {row.map((cellText: string, colIdx: number) => {
                  const align = block.alignments[colIdx] || "left";
                  return (
                    <td
                      key={colIdx}
                      style={align !== "left" ? { textAlign: align } : undefined}
                    >
                      <InlineFormatted text={cellText} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ListItemView({ item }: { item: any }) {
  const cls = [
    item.task ? "msg-task-item" : "",
    item.task && item.checked ? "is-checked" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const hasChildren = Array.isArray(item.children) && item.children.length > 0;
  const subOrdered = hasChildren && Boolean(item.children[0]?.ordered);
  const SubListTag = subOrdered ? "ol" : "ul";

  return (
    <li className={cls || undefined}>
      {item.task ? (
        <>
          <input
            type="checkbox"
            className="msg-task-checkbox"
            checked={Boolean(item.checked)}
            disabled
            readOnly
          />
          <span className="msg-task-label">
            <InlineFormatted text={item.text} />
          </span>
        </>
      ) : (
        <InlineFormatted text={item.text} />
      )}
      {hasChildren && (
        <SubListTag className="msg-list msg-sublist">
          {item.children.map((child: any, idx: number) => (
            <ListItemView key={idx} item={child} />
          ))}
        </SubListTag>
      )}
    </li>
  );
}

function AsyncSvgAttachment({ name, url }: { name: string; url: string }) {
  const [svgText, setSvgText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("fetch failed"))))
      .then((txt) => {
        if (!cancelled) setSvgText(txt);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (failed) {
    return <img className="msg-inline-img" src={url} alt={name} loading="lazy" />;
  }
  if (svgText === null) {
    return <div />;
  }
  const sep = url.includes("?") ? "&" : "?";
  return (
    <MarkupPreviewCard
      code={svgText}
      kind="svg"
      badgeLabel="SVG 预览"
      lang="svg"
      sourceLabel={name}
      downloadUrl={`${url}${sep}download=1&name=${encodeURIComponent(name)}`}
    />
  );
}

function FileAttachmentCard({ name, filePath }: { name: string; filePath: string }) {
  const info = describeFileExtension(name || filePath);
  const fullName = name || filePath?.split("/").pop() || "文件附件";
  const [subText, setSubText] = useState(info.kind);
  const [disabledReason, setDisabledReason] = useState<string | null>(null);
  const [markupText, setMarkupText] = useState<string | null>(null);

  const isPreviewableFile = /\.(?:html?|xhtml|svg)$/i.test(name || "");

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    apiFetch(`/api/files/meta?path=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (cancelled || !m || !m.ok) return;
        if (!m.exists) {
          setSubText(`${info.kind} · 原路径文件不存在`);
          setDisabledReason("原路径文件不存在");
          return;
        }
        const sizeLabel = formatFileBytes(m.size);
        const timeLabel = formatFileBuildTime(m.mtime);
        const subParts = [info.kind, sizeLabel, timeLabel].filter(Boolean);
        setSubText(subParts.join(" · "));
        if (!m.inWorkspace) {
          setDisabledReason("文件不在可下载工作区目录内");
        }
      })
      .catch(() => {});

    if (isPreviewableFile) {
      apiFetch(`/api/workspace/file?path=${encodeURIComponent(filePath)}`)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error("load failed"))))
        .then((txt) => {
          if (!cancelled) setMarkupText(txt);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [filePath, info.kind, isPreviewableFile]);

  const dlHref = apiUrl(
    `/api/workspace/file?path=${encodeURIComponent(filePath)}&download=1&name=${encodeURIComponent(name || "")}`
  );
  const isSvgFile = /\.svg$/i.test(name || "");
  const isHtmFile = /\.htm$/i.test(name || "");

  return (
    <>
      <div className="msg-file-card" title={filePath || fullName}>
        <div className={`msg-file-badge ${info.cls}`}>{info.badge}</div>
        <div className="msg-file-meta">
          <div className="msg-file-title" title={fullName}>
            {fullName}
          </div>
          <div className="msg-file-sub">{subText}</div>
        </div>
        <div className="msg-file-actions">
          <a
            className={`msg-file-btn is-primary${disabledReason ? " is-disabled" : ""}`}
            title={disabledReason || "下载到本地"}
            aria-disabled={disabledReason ? "true" : undefined}
            href={disabledReason ? undefined : dlHref}
            download={name || ""}
            onClick={(e) => {
              e.stopPropagation();
              if (disabledReason) {
                e.preventDefault();
                showToast(disabledReason || "当前文件暂不可下载");
              }
            }}
          >
            下载
          </a>
        </div>
      </div>
      {markupText !== null && (
        <MarkupPreviewCard
          code={markupText}
          kind={isSvgFile ? "svg" : "html"}
          badgeLabel={isSvgFile ? "SVG 预览" : isHtmFile ? "HTM 预览" : "HTML 预览"}
          lang={isSvgFile ? "svg" : isHtmFile ? "htm" : "html"}
          sourceLabel={name}
        />
      )}
    </>
  );
}

function ProseSegment({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);
  const rendered: ReactNode[] = [];
  let mediaBatch: Array<{ name: string; url: string }> = [];

  const seenImageUrls = new Set<string>();
  const normalizeMediaKey = (rawUrl: string): string => {
    const clean = String(rawUrl || "").trim();
    if (!clean) return "";
    try {
      const parsed = new URL(clean, "http://local.invalid");
      return decodeURIComponent(`${parsed.pathname}${parsed.search}`);
    } catch {
      try {
        return decodeURIComponent(clean);
      } catch {
        return clean;
      }
    }
  };

  const flushMediaBatch = (keyPrefix: string) => {
    if (mediaBatch.length === 0) return;
    const batch = mediaBatch;
    mediaBatch = [];
    rendered.push(
      <div
        key={`media-${keyPrefix}`}
        className="msg-media-grid"
        data-count={String(batch.length)}
      >
        {batch.map((imgItem, mIdx) => (
          <img
            key={`${imgItem.url}-${mIdx}`}
            src={imgItem.url}
            alt={imgItem.name}
            loading="lazy"
            onClick={() => openImageLightbox(imgItem.url, imgItem.name)}
          />
        ))}
      </div>
    );
  };

  blocks.forEach((block: any, idx: number) => {
    if (block.type === "attachment_image") {
      const attName = block.name || "AI 生成图片";
      const attUrl = apiUrl(block.url);
      const dedupKey = normalizeMediaKey(block.url || attUrl);
      if (dedupKey && seenImageUrls.has(dedupKey)) {
        return;
      }
      if (dedupKey) seenImageUrls.add(dedupKey);
      if (/\.svg$/i.test(attName)) {
        flushMediaBatch(`pre-svg-${idx}`);
        rendered.push(<AsyncSvgAttachment key={`svg-${idx}`} name={attName} url={attUrl} />);
      } else {
        mediaBatch.push({ name: attName, url: attUrl });
      }
      return;
    }

    flushMediaBatch(`blk-${idx}`);

    if (block.type === "hr") {
      rendered.push(<hr key={idx} className="msg-hr" />);
    } else if (block.type === "table") {
      rendered.push(<TableBlock key={idx} block={block} />);
    } else if (block.type === "attachment_file") {
      rendered.push(
        <FileAttachmentCard key={idx} name={block.name} filePath={block.path} />
      );
    } else if (block.type === "blockquote") {
      rendered.push(
        <blockquote key={idx} className="msg-blockquote">
          {block.lines.map((lineStr: string, lIdx: number) => (
            <Fragment key={lIdx}>
              {lIdx > 0 && <br />}
              <InlineFormatted text={lineStr} />
            </Fragment>
          ))}
        </blockquote>
      );
    } else if (block.type === "list") {
      const hasTask = block.items.some((it: any) => it.task);
      const cls = `msg-list${hasTask ? " has-task-items" : ""}`;
      if (block.ordered) {
        rendered.push(
          <ol
            key={idx}
            className={cls}
            start={block.start && block.start !== 1 ? block.start : undefined}
          >
            {block.items.map((item: any, iIdx: number) => (
              <ListItemView key={iIdx} item={item} />
            ))}
          </ol>
        );
      } else {
        rendered.push(
          <ul key={idx} className={cls}>
            {block.items.map((item: any, iIdx: number) => (
              <ListItemView key={iIdx} item={item} />
            ))}
          </ul>
        );
      }
    } else if (block.type === "heading") {
      rendered.push(
        <div
          key={idx}
          className={`msg-heading msg-h${block.level}`}
          role="heading"
          aria-level={block.level}
        >
          <InlineFormatted text={block.text} />
        </div>
      );
    } else {
      rendered.push(
        <p key={idx}>
          <InlineFormatted text={block.text} />
        </p>
      );
    }
  });

  flushMediaBatch("end");

  return <>{rendered}</>;
}

export function MarkdownRenderer({ text }: { text: string }) {
  const segments = extractMessageSegments(text);
  return (
    <>
      {segments.map((seg: any, idx: number) => {
        if (seg.type === "fence") {
          const meta = detectPreviewableMarkup(seg.code, seg.lang);
          if (meta.previewable) {
            return (
              <MarkupPreviewCard
                key={idx}
                code={seg.code}
                kind={(meta.kind as "html" | "svg") || "html"}
                badgeLabel={meta.badgeLabel}
                lang={meta.lang}
              />
            );
          }
          return <CodeBlock key={idx} code={seg.code} langLabel={seg.lang || "code"} />;
        }
        if (seg.type === "raw_markup") {
          return (
            <MarkupPreviewCard
              key={idx}
              code={seg.code}
              kind={seg.kind}
              badgeLabel={
                seg.kind === "svg"
                  ? "SVG 预览"
                  : seg.lang === "htm"
                    ? "HTM 预览"
                    : "HTML 预览"
              }
              lang={seg.lang || (seg.kind === "svg" ? "svg" : "html")}
              sourceLabel="纯代码片段"
            />
          );
        }
        return <ProseSegment key={idx} text={seg.text} />;
      })}
    </>
  );
}
