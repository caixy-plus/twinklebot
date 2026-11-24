import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { ServerContext } from "./context.js";
import { FALLBACK_HTML, MIME_TYPES, sendJson } from "./http-utils.js";

function serveJsBuffer(
  res: http.ServerResponse,
  method: string,
  filePath: string
) {
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-cache",
  });
  if (method === "HEAD") res.end();
  else res.end(buf);
}

export function handleStaticAndNoVnc(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
) {
  if (method !== "GET" && method !== "HEAD") {
    return sendJson(res, 405, { error: "method not allowed" });
  }

  if (ctx.runtimeState.deployEnv === "cloud" && pathname === "/") {
    const okBuf = Buffer.from("ok", "utf-8");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": okBuf.length,
      "Cache-Control": "no-store",
    });
    return method === "HEAD" ? res.end() : res.end(okBuf);
  }

  const activePublicDir = (() => {
    try {
      const resolved = ctx.getEffectivePublicDir?.();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {}
    return ctx.publicDir;
  })();

  // Root index.html fallback (local / desktop mode only)
  if (
    ctx.runtimeState.deployEnv !== "cloud" &&
    (pathname === "/" || pathname === "/index.html")
  ) {
    const indexPath = path.join(activePublicDir, "index.html");
    if (fs.existsSync(indexPath)) {
      const stat = fs.statSync(indexPath);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
      });
      if (method === "HEAD") {
        return res.end();
      }
      return fs.createReadStream(indexPath).pipe(res);
    }

    const buf = Buffer.from(FALLBACK_HTML, "utf-8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": buf.length,
    });
    if (method === "HEAD") {
      return res.end();
    }
    return res.end(buf);
  }

  // Shared, browser-safe modules: check activePublicDir (OTA) first, then built dist-server/src/shared/
  if (ctx.runtimeState.deployEnv !== "cloud" && pathname === "/skills-catalog.js") {
    const otaCopy = path.join(activePublicDir, "skills-catalog.js");
    serveJsBuffer(
      res,
      method,
      fs.existsSync(otaCopy)
        ? otaCopy
        : path.join(ctx.projectRoot, "dist-server", "src", "shared", "skills-catalog.js")
    );
    return;
  }

  if (ctx.runtimeState.deployEnv !== "cloud" && pathname === "/accounts-store.js") {
    const otaCopy = path.join(activePublicDir, "accounts-store.js");
    serveJsBuffer(
      res,
      method,
      fs.existsSync(otaCopy)
        ? otaCopy
        : path.join(ctx.projectRoot, "dist-server", "src", "shared", "accounts-store.js")
    );
    return;
  }

  if (
    ctx.runtimeState.deployEnv !== "cloud" &&
    pathname.startsWith("/shared/") &&
    pathname.endsWith(".js")
  ) {
    const rel = pathname.slice("/shared/".length);
    if (!rel.includes("..") && !rel.includes("/")) {
      const otaSharedPath = path.join(activePublicDir, "shared", rel);
      const sharedPath = fs.existsSync(otaSharedPath)
        ? otaSharedPath
        : path.join(ctx.projectRoot, "dist-server", "src", "shared", rel);
      if (fs.existsSync(sharedPath)) {
        serveJsBuffer(res, method, sharedPath);
        return;
      }
    }
  }

  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/novnc" || pathname.startsWith("/novnc/")) &&
    ctx.effectiveNovncProxyTarget
  ) {
    if (pathname === "/novnc") {
      res.writeHead(302, { Location: `/novnc/vnc.html${url.search || ""}` });
      return res.end();
    }
    try {
      const targetUrl = new URL(ctx.effectiveNovncProxyTarget);
      const upstreamPath =
        (pathname.slice("/novnc".length) || "/") + (url.search || "");
      const proxyReq = http.request(
        {
          hostname: targetUrl.hostname,
          port: Number(targetUrl.port || 80),
          path: upstreamPath,
          method,
          headers: {
            host: targetUrl.host,
          },
        },
        (proxyRes) => {
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders["content-security-policy"];
          delete outHeaders["x-frame-options"];
          const isVncHtml =
            method === "GET" &&
            (pathname === "/novnc/vnc.html" ||
              pathname === "/novnc/vnc_auto.html" ||
              pathname === "/novnc/vnc_lite.html") &&
            (proxyRes.statusCode || 500) === 200;
          if (!isVncHtml) {
            res.writeHead(proxyRes.statusCode || 502, outHeaders);
            if (method === "HEAD") {
              proxyRes.resume();
              return res.end();
            }
            return proxyRes.pipe(res);
          }
          const chunks: Buffer[] = [];
          proxyRes.on("data", (c) => chunks.push(c));
          proxyRes.on("end", () => {
            let htmlText = Buffer.concat(chunks).toString("utf8");
            const hideCss =
              "<style>#noVNC_control_bar_anchor,#noVNC_control_bar,#noVNC_control_bar_handle,#noVNC_control_bar_hint,#noVNC_status,#noVNC_mobile_buttons,#top_bar{display:none!important;visibility:hidden!important;pointer-events:none!important;}</style>" +
              `<script>(function(){window.addEventListener("message",function(e){if(e.origin!==window.location.origin)return;var d=e.data;if(d&&d.type==="twinklebot:focus_keyboard"){var el=document.getElementById("noVNC_keyboardinput");if(el){try{el.focus({preventScroll:true});}catch(_){try{el.focus();}catch(__){}}}}});})();</script>`;
            htmlText = htmlText.includes("</head>")
              ? htmlText.replace("</head>", `${hideCss}</head>`)
              : `${hideCss}${htmlText}`;
            const outBuf = Buffer.from(htmlText, "utf8");
            delete outHeaders["content-encoding"];
            delete outHeaders["transfer-encoding"];
            delete outHeaders["connection"];
            outHeaders["content-length"] = String(outBuf.length);
            outHeaders["cache-control"] = "no-store";
            res.writeHead(200, outHeaders);
            res.end(outBuf);
          });
        }
      );
      proxyReq.on("error", () => {
        if (!res.headersSent) {
          sendJson(res, 502, { error: "cloud desktop noVNC unavailable" });
        }
      });
      return proxyReq.end();
    } catch {
      return sendJson(res, 502, { error: "invalid noVNC proxy target" });
    }
  }

  // Cloud / server deployment exposes API + /ws + /novnc only (no web UI)
  if (ctx.runtimeState.deployEnv === "cloud") {
    return sendJson(res, 404, { error: "not found" });
  }

  // Other static files (e.g. /public/foo or /foo)
  let subpath = pathname;
  if (subpath.startsWith("/public/")) {
    subpath = subpath.slice("/public".length);
  }
  const targetPath = path.resolve(activePublicDir, "." + subpath);
  const rel = path.relative(activePublicDir, targetPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return sendJson(res, 404, { error: "not found" });
  }

  if (!fs.existsSync(targetPath)) {
    return sendJson(res, 404, { error: "not found" });
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isFile()) {
    return sendJson(res, 404, { error: "not found" });
  }

  const ext = path.extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });
  if (method === "HEAD") {
    return res.end();
  }
  return fs.createReadStream(targetPath).pipe(res);
}

function resolveNovncTargetBot(
  store: any,
  { sessionId, botId }: { sessionId?: string; botId?: string }
): { botId: string; isAdmin: boolean } | null {
  const directBotId = String(botId || "").trim();
  if (directBotId) {
    const bot = store?.getSession?.(directBotId);
    return { botId: directBotId, isAdmin: Boolean(bot?.isAdmin) };
  }
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  const sess = store?.getSession?.(sid);
  if (!sess) return { botId: sid, isAdmin: false };
  if (sess.type === "group") {
    const memberIds: string[] = Array.isArray(sess.memberBotIds)
      ? sess.memberBotIds
      : Array.isArray(sess.memberIds)
        ? sess.memberIds
        : [];
    const firstMemberId = memberIds[0];
    if (firstMemberId) {
      const m = store?.getSession?.(firstMemberId);
      return { botId: firstMemberId, isAdmin: Boolean(m?.isAdmin) };
    }
    return null;
  }
  return { botId: sess.id || sid, isAdmin: Boolean(sess.isAdmin) };
}

export function createNovncUpgradeHandler(ctx: ServerContext) {
  return (req: http.IncomingMessage, socket: any, head: Buffer, parsedUrl: URL) => {
    if (
      (parsedUrl.pathname === "/novnc/websockify" ||
        parsedUrl.pathname === "/novnc/websockify/") &&
      ctx.effectiveNovncProxyTarget
    ) {
      if (ctx.runtimeState.deployEnv === "local" && !ctx.deviceAuth.isAuthorized(req, parsedUrl)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (ctx.runtimeState.deployEnv === "cloud" && ctx.finalConfig.cloudAuthToken) {
        const authHeader = String(req.headers.authorization || "").trim();
        const bearerTok = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        const queryTok = (parsedUrl.searchParams.get("token") || "").trim();
        if ((bearerTok || queryTok) !== ctx.finalConfig.cloudAuthToken) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      const sessionId = (parsedUrl.searchParams.get("sessionId") || "").trim();
      const botIdParam = (parsedUrl.searchParams.get("botId") || "").trim();
      const targetBot = resolveNovncTargetBot(ctx.store, { sessionId, botId: botIdParam });

      void (async () => {
        let clientClosedEarly = false;
        const onEarlyClose = () => {
          clientClosedEarly = true;
        };
        const onEarlyError = () => {
          clientClosedEarly = true;
          if (!socket.destroyed) socket.destroy();
        };
        socket.once("close", onEarlyClose);
        socket.once("error", onEarlyError);
        try {
          const targetUrl = new URL(ctx.effectiveNovncProxyTarget);
          let upPort = Number(targetUrl.port || 80);
          const upHost = targetUrl.hostname;

          if (targetBot && ctx.executor?.call) {
            try {
              const ensured: any = await ctx.executor.call(
                "/displays/ensure",
                {
                  bot_id: targetBot.botId,
                  is_admin: targetBot.isAdmin,
                  start_browser: false,
                },
                { timeoutMs: 8000 }
              );
              const dynPort = Number(ensured?.novnc_port || 0);
              if (Number.isInteger(dynPort) && dynPort >= 6080 && dynPort <= 65535) {
                upPort = dynPort;
              }
            } catch {
              // Fall back cleanly to legacy :1 / 6080 if remote executor lacks multi-display
            }
          }

          socket.removeListener("close", onEarlyClose);
          if (clientClosedEarly || socket.destroyed) {
            socket.removeListener("error", onEarlyError);
            return;
          }

          const upstreamSearchParams = new URLSearchParams(parsedUrl.searchParams);
          upstreamSearchParams.delete("sessionId");
          upstreamSearchParams.delete("botId");
          const upstreamQs = upstreamSearchParams.toString();
          const upstreamQueryStr = upstreamQs ? `?${upstreamQs}` : "";

          const upSocket = net.connect(upPort, upHost, () => {
            const headerLines: string[] = [];
            for (const [k, v] of Object.entries(req.headers || {})) {
              if (v === undefined) continue;
              if (k.toLowerCase() === "host") {
                headerLines.push(`Host: ${upHost}:${upPort}`);
              } else if (Array.isArray(v)) {
                for (const item of v) headerLines.push(`${k}: ${item}`);
              } else {
                headerLines.push(`${k}: ${v}`);
              }
            }
            const upReq =
              `GET /websockify${upstreamQueryStr} HTTP/1.1\r\n` +
              `${headerLines.join("\r\n")}\r\n\r\n`;
            upSocket.write(upReq);
            if (head && head.length > 0) upSocket.write(head);
            socket.pipe(upSocket);
            upSocket.pipe(socket);
          });
          const cleanup = () => {
            if (!socket.destroyed) socket.destroy();
            if (!upSocket.destroyed) upSocket.destroy();
          };
          socket.removeListener("error", onEarlyError);
          upSocket.on("error", cleanup);
          socket.on("error", cleanup);
          upSocket.on("close", () => {
            if (!socket.destroyed) socket.destroy();
          });
          socket.on("close", () => {
            if (!upSocket.destroyed) upSocket.destroy();
          });
        } catch {
          socket.removeListener("close", onEarlyClose);
          socket.removeListener("error", onEarlyError);
          if (!socket.destroyed) {
            socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
            socket.destroy();
          }
        }
      })();
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  };
}
