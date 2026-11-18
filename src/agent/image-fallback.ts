import {
  convertImageBuffer,
  imageFormatFromMimeType,
  normalizeImageOutputFormat,
  type SupportedImageOutputFormat,
} from "../lib/image-convert.js";
import { inferImageMimeType } from "./model.js";
import { isProviderUsable, normalizeProvidersConfig } from "./providers/registry.js";
import { resolveTierModels } from "./router.js";

const ASPECT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "4:3": { width: 1200, height: 900 },
  "3:4": { width: 900, height: 1200 },
  "3:2": { width: 1200, height: 800 },
  "2:3": { width: 800, height: 1200 },
  "4:5": { width: 960, height: 1200 },
  "5:4": { width: 1200, height: 960 },
  "21:9": { width: 1470, height: 630 },
};

export function getDimensionsForAspectRatio(aspectRatio = "1:1"): {
  width: number;
  height: number;
} {
  return ASPECT_DIMENSIONS[aspectRatio] || ASPECT_DIMENSIONS["1:1"];
}

export function classifyImageDegradeReason(
  err: unknown,
  { unconfigured = false }: { unconfigured?: boolean } = {}
): string {
  if (unconfigured) {
    return "当前未配置图像生成模型（可在「设置 → 模型接入与路由 → 生图模型」中配置）";
  }
  const msg = String((err as any)?.message || err || "").trim();
  const lower = msg.toLowerCase();
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.code;

  if (
    msg.includes("未配置可用的生图模型") ||
    msg.includes("未配置生图模型") ||
    lower.includes("not configured")
  ) {
    return "当前未配置可用的图像生成模型（可在「设置 → 模型接入与路由 → 生图模型」中配置）";
  }
  if (msg.includes("Provider not found or disabled")) {
    return `配置的图像生成模型所属供应商未启用或不可用（${msg}）`;
  }
  if (status === 429 || lower.includes("resource exhausted") || lower.includes("rate limit") || lower.includes("quota")) {
    return "图像生成模型触发限流或配额不足（429）";
  }
  if (status === 401 || status === 403 || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("permission")) {
    return `图像生成模型鉴权失败或无访问权限（${msg || status}）`;
  }
  if (lower.includes("not supported by the interactions api")) {
    return "当前 Vertex AI 接口暂不支持所选图像生成模型";
  }
  if (status === 404 || lower.includes("not found") || lower.includes("unsupported model") || lower.includes("invalid model")) {
    return `图像生成模型不存在或当前接口不支持（${msg || status}）`;
  }
  if (status === 503 || status === 504 || lower.includes("timeout") || lower.includes("timed out") || lower.includes("overloaded") || lower.includes("fetch failed") || lower.includes("econn")) {
    return `图像生成模型服务暂时不可用或请求超时（${msg || status}）`;
  }
  if (lower.includes("no image returned") || lower.includes("returned no image")) {
    return "图像生成模型未能返回有效图像数据（可能受内容策略拦截或模型异常）";
  }
  return msg
    ? `图像生成模型调用失败：${msg}`
    : "图像生成模型当前不可用";
}

export function resolveSvgFallbackModels({
  config = {},
  activeLlmModel = "",
  fallbackLlmModel = "",
  preferFast = false,
}: {
  config?: Record<string, any>;
  activeLlmModel?: string;
  fallbackLlmModel?: string;
  preferFast?: boolean;
} = {}): string[] {
  const candidates: string[] = [];
  const pushUnique = (ref: unknown) => {
    const s = String(ref || "").trim();
    if (s && !candidates.includes(s)) {
      candidates.push(s);
    }
  };

  pushUnique(activeLlmModel);
  pushUnique(fallbackLlmModel);

  const routing = config?.routing && typeof config.routing === "object" ? config.routing : {};
  const tiers = resolveTierModels(config, Date.now(), routing);
  if (preferFast && !activeLlmModel) {
    pushUnique(tiers.fast);
    pushUnique(tiers.standard);
    pushUnique(tiers.deep);
  } else {
    pushUnique(tiers.standard);
    pushUnique(tiers.deep);
    pushUnique(tiers.fast);
  }

  if (Array.isArray(config?.providers)) {
    for (const rawP of config.providers) {
      if (!rawP || rawP.enabled === false) continue;
      const p = normalizeProvidersConfig([rawP])[0];
      const usable = Boolean(rawP.hasApiKey) || (p ? isProviderUsable(p) : false);
      if (!usable || !p) continue;
      for (const m of p.models || []) {
        if (m) pushUnique(`${p.id}::${m}`);
      }
    }
  }

  return candidates;
}

export function extractAndSanitizeSvg(
  rawText: string,
  width = 1024,
  height = 1024
): string {
  const text = String(rawText || "").trim();
  if (!text) return "";

  let candidate = "";
  const fenceRegex = /```(?:svg|xml|html)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const inner = match[1]?.trim() || "";
    const svgMatch = inner.match(/<svg\b[\s\S]*?<\/svg>/i);
    if (svgMatch) {
      candidate = svgMatch[0];
      break;
    }
  }

  if (!candidate) {
    const directMatch = text.match(/<svg\b[\s\S]*?<\/svg>/i);
    if (directMatch) {
      candidate = directMatch[0];
    }
  }

  if (!candidate) return "";

  // Strip executable script blocks, inline event handlers, and unescaped '&' that break XML/Canvas
  let sanitized = candidate
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "")
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);)/g, "&amp;");

  const openTagMatch = sanitized.match(/^<svg\b([^>]*)>/i);
  if (!openTagMatch) return "";

  let attrs = openTagMatch[1] || "";
  if (!/\bxmlns\s*=/i.test(attrs)) {
    attrs += ' xmlns="http://www.w3.org/2000/svg"';
  }
  if (!/\bviewBox\s*=/i.test(attrs)) {
    attrs += ` viewBox="0 0 ${width} ${height}"`;
  }
  // Ensure explicit pixel dimensions on root <svg> (percentage width="100%" breaks HTMLImageElement->Canvas sizing)
  if (!/\bwidth\s*=/i.test(attrs)) {
    attrs += ` width="${width}"`;
  } else {
    attrs = attrs.replace(/\bwidth\s*=\s*(["'])\s*\d+(?:\.\d+)?%\s*\1/i, `width="${width}"`);
  }
  if (!/\bheight\s*=/i.test(attrs)) {
    attrs += ` height="${height}"`;
  } else {
    attrs = attrs.replace(/\bheight\s*=\s*(["'])\s*\d+(?:\.\d+)?%\s*\1/i, `height="${height}"`);
  }

  sanitized = sanitized.replace(/^<svg\b[^>]*>/i, `<svg${attrs}>`);
  return sanitized.trim();
}

export async function generateSvgWithLlm({
  model,
  prompt,
  title = "",
  aspectRatio = "1:1",
  referenceImages = [],
  candidates = [],
  timeoutMs = 90_000,
  signal,
}: {
  model: any;
  prompt: string;
  title?: string;
  aspectRatio?: string;
  referenceImages?: Array<{ data: string; mimeType?: string }>;
  candidates?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  svg: string;
  usedModel: string;
  usedProviderId?: string;
  usage: Record<string, any> | null;
}> {
  if (!model || typeof model.nextTurn !== "function") {
    throw new Error("当前没有可用的大语言模型用于生成 SVG");
  }

  const { width, height } = getDimensionsForAspectRatio(aspectRatio);
  const isCompactAvatarOrIcon =
    aspectRatio === "1:1" &&
    /^(?:头像|avatar|icon)/i.test(String(title || "").trim() || String(prompt || "").trim()) ||
    /\bavatar\b|头像/i.test(`${title} ${prompt}`);
  const svgW = isCompactAvatarOrIcon ? 128 : width;
  const svgH = isCompactAvatarOrIcon ? 128 : height;

  const systemInstruction = [
    "You are an expert vector illustrator and SVG artist.",
    "Your ONLY task is to write clean, self-contained <svg> code depicting the user's request.",
    `Canvas requirements: root <svg> MUST include xmlns="http://www.w3.org/2000/svg", viewBox="0 0 ${svgW} ${svgH}", width="${svgW}", and height="${svgH}".`,
    "Design craft:",
    isCompactAvatarOrIcon
      ? "- Keep it super crisp and compact: 8-18 clean geometric shapes/paths with 1-2 gradients or solid flat colors, centered focal character/emblem, no XML comments, minimal whitespace."
      : "- Use harmonious color palettes, <defs> linearGradient/radialGradient, layered shapes, balanced composition, and crisp geometric or Bezier paths (20-60 well-structured SVG elements).",
    "- Include a clean background fill (or subtle backdrop) unless transparency is explicitly requested.",
    "- For any text labels, use standard cross-platform font stacks like 'system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif' and properly escape XML special characters.",
    "- NEVER reference external URLs (<image href=\"http...\">), NEVER include <script> or event handlers, and NEVER output markdown explanations.",
    "Output ONLY the raw <svg>...</svg> markup.",
  ].join("\n");

  const promptLines = [
    `Create a complete, visually polished SVG illustration for:`,
    `Description: ${prompt}`,
    title ? `Title: ${title}` : "",
    `Aspect ratio: ${aspectRatio} (${svgW}x${svgH})`,
  ]
    .filter(Boolean)
    .join("\n");

  const hasRefImages = Array.isArray(referenceImages) && referenceImages.length > 0;
  const buildUserStep = (includeImages: boolean) => ({
    type: "user_input",
    content: [
      { type: "text", text: promptLines },
      ...(includeImages
        ? referenceImages.map((img) => ({
            type: "image",
            data: img.data,
            mime_type: inferImageMimeType(img.data, img.mimeType),
          }))
        : []),
    ],
  });

  const modelQueue = candidates.length > 0 ? candidates : ["gemini-4-argon"];
  let lastError: unknown = null;

  for (const candidateModel of modelQueue) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const runAttempt = async (includeImages: boolean) => {
      const turn = await model.nextTurn({
        model: candidateModel,
        thinkingLevel: "none",
        timeoutMs,
        systemInstruction,
        tools: undefined,
        input: [buildUserStep(includeImages)],
        signal,
      });
      const svg = extractAndSanitizeSvg(turn?.text || "", svgW, svgH);
      if (!svg) {
        throw new Error(`模型 ${turn?.usedModel || candidateModel} 未输出有效的 SVG 代码`);
      }
      return {
        svg,
        usedModel: String(turn?.usedModel || candidateModel),
        usedProviderId: turn?.usedProviderId,
        usage: turn?.usage || null,
      };
    };

    try {
      return await runAttempt(hasRefImages);
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        throw err;
      }
      // If a text-only LLM rejected image attachments, retry once with text-only prompt
      if (hasRefImages) {
        try {
          return await runAttempt(false);
        } catch (retryErr: any) {
          if (signal?.aborted || retryErr?.name === "AbortError") {
            throw retryErr;
          }
          lastError = retryErr;
          continue;
        }
      }
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("大语言模型降级生成 SVG 失败");
}

function inspectConfiguredImageModel(config: Record<string, any> = {}): {
  configured: boolean;
  targetModel?: string;
  fallbackModel?: string;
  unconfiguredReason?: string;
} {
  const configuredImage = config?.routing?.tiers?.image;
  const hasProvidersOrRouting = Boolean(
    config?.routing || (Array.isArray(config?.providers) && config.providers.length > 0)
  );

  if (configuredImage?.providerId && configuredImage?.model) {
    if (Array.isArray(config?.providers) && config.providers.length > 0) {
      const normalized = normalizeProvidersConfig(config.providers);
      const matched = normalized.find((p) => p.id === configuredImage.providerId);
      if (!matched || matched.enabled === false || !isProviderUsable(matched)) {
        return {
          configured: false,
          unconfiguredReason: `配置的图像生成模型（${configuredImage.model}）所属供应商未启用或缺少有效凭证`,
        };
      }
    }
    return {
      configured: true,
      targetModel: `${configuredImage.providerId}::${configuredImage.model}`,
      fallbackModel: undefined,
    };
  }

  if (hasProvidersOrRouting) {
    return {
      configured: false,
      unconfiguredReason:
        "当前未配置图像生成模型（可在「设置 → 模型接入与路由 → 生图模型」中配置）",
    };
  }

  if (config.imageModel || config.proImageModel) {
    return { configured: true };
  }

  return {
    configured: false,
    unconfiguredReason:
      "当前未配置图像生成模型（可在「设置 → 模型接入与路由 → 生图模型」中配置）",
  };
}

export interface ExecuteImageWithFallbackOptions {
  model: any;
  prompt: string;
  title?: string;
  aspectRatio?: string;
  quality?: "standard" | "pro";
  imageSize?: string;
  outputFormat?: string;
  referenceImages?: Array<{ data: string; mimeType?: string }>;
  config?: Record<string, any>;
  activeLlmModel?: string;
  fallbackLlmModel?: string;
  executor?: any;
  signal?: AbortSignal;
  customConverter?: any;
}

export interface ExecuteImageWithFallbackResult {
  base64Data: string;
  mimeType: string;
  usedModel: string;
  usedProviderId?: string;
  usage: Record<string, any> | null;
  degraded: boolean;
  degradedReason?: string;
  fallbackNotice?: string;
  fallbackMode?: "llm_svg";
  outputFormat: SupportedImageOutputFormat;
  convertedFromSvg?: boolean;
  converter?: string;
  conversionWarning?: string;
}

export async function executeImageGenerationWithFallback(
  opts: ExecuteImageWithFallbackOptions
): Promise<ExecuteImageWithFallbackResult> {
  const {
    model,
    prompt,
    title = "",
    aspectRatio = "1:1",
    quality = "standard",
    imageSize,
    outputFormat = "",
    referenceImages = [],
    config = {},
    activeLlmModel = "",
    fallbackLlmModel = "",
    executor = null,
    signal,
    customConverter,
  } = opts;

  const requestedFormat = normalizeImageOutputFormat(outputFormat);
  if (String(outputFormat || "").trim() && !requestedFormat) {
    throw new Error(
      `不支持的目标图片格式「${String(outputFormat)}」，支持：svg, png, jpg, webp, gif, bmp, ico, pdf`
    );
  }

  const { width, height } = getDimensionsForAspectRatio(aspectRatio);
  const inspected = inspectConfiguredImageModel(config);

  let degraded = false;
  let degradedReason = "";

  if (!model) {
    degraded = true;
    degradedReason = "当前环境未初始化模型适配器";
  } else if (!inspected.configured) {
    degraded = true;
    degradedReason =
      inspected.unconfiguredReason ||
      classifyImageDegradeReason(null, { unconfigured: true });
  } else if (typeof model.generateImage !== "function") {
    degraded = true;
    degradedReason = "当前模型适配器未提供图像生成接口";
  } else {
    const targetModel =
      inspected.targetModel ||
      (quality === "pro"
        ? config.proImageModel || "gemini-3-pro-image"
        : config.imageModel || "gemini-3.1-flash-image");
    const fallbackModel =
      inspected.targetModel
        ? undefined
        : quality === "pro"
          ? config.imageModel || "gemini-3.1-flash-image"
          : config.fallbackImageModel || "gemini-2.5-flash-image";

    try {
      const genRes = await model.generateImage({
        prompt,
        model: targetModel,
        fallbackModel,
        aspectRatio,
        imageSize,
        referenceImages,
        signal,
      });

      const firstImage = genRes?.images?.[0];
      if (!firstImage?.data) {
        throw new Error("No image returned by image model");
      }

      const nativeMime = inferImageMimeType(firstImage.data, firstImage.mimeType);
      const nativeFormat = imageFormatFromMimeType(nativeMime) || "png";

      if (requestedFormat && requestedFormat !== nativeFormat) {
        const converted = await convertImageBuffer({
          inputBuffer: Buffer.from(firstImage.data, "base64"),
          inputMimeType: nativeMime,
          targetFormat: requestedFormat,
          width,
          height,
          signal,
          executor,
          customConverter,
        });
        return {
          base64Data: converted.buffer.toString("base64"),
          mimeType: converted.mimeType,
          usedModel: genRes.usedModel || targetModel,
          usedProviderId: genRes.usedProviderId,
          usage: genRes.usage || null,
          degraded: false,
          outputFormat: converted.format,
          converter: converted.converter,
        };
      }

      return {
        base64Data: firstImage.data,
        mimeType: nativeMime,
        usedModel: genRes.usedModel || targetModel,
        usedProviderId: genRes.usedProviderId,
        usage: genRes.usage || null,
        degraded: false,
        outputFormat: nativeFormat,
      };
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        throw err;
      }
      degraded = true;
      degradedReason = classifyImageDegradeReason(err);
    }
  }

  // Fallback: generate SVG code using an available LLM
  const candidates = resolveSvgFallbackModels({
    config,
    activeLlmModel,
    fallbackLlmModel,
    preferFast: !activeLlmModel && quality !== "pro",
  });

  const svgRes = await generateSvgWithLlm({
    model,
    prompt,
    title,
    aspectRatio,
    referenceImages,
    candidates,
    signal,
  });

  const svgBuffer = Buffer.from(svgRes.svg, "utf-8");
  const targetFallbackFormat: SupportedImageOutputFormat = requestedFormat || "svg";

  if (targetFallbackFormat !== "svg") {
    try {
      const converted = await convertImageBuffer({
        inputBuffer: svgBuffer,
        inputMimeType: "image/svg+xml",
        targetFormat: targetFallbackFormat,
        width,
        height,
        signal,
        executor,
        customConverter,
      });
      const fallbackNotice = `已自动降级为大语言模型（${svgRes.usedModel}）编写 SVG 并按要求转换为 ${converted.format.toUpperCase()} 格式（降级原因：${degradedReason}）`;
      return {
        base64Data: converted.buffer.toString("base64"),
        mimeType: converted.mimeType,
        usedModel: svgRes.usedModel,
        usedProviderId: svgRes.usedProviderId,
        usage: svgRes.usage,
        degraded: true,
        degradedReason,
        fallbackNotice,
        fallbackMode: "llm_svg",
        outputFormat: converted.format,
        convertedFromSvg: true,
        converter: converted.converter,
      };
    } catch (convErr: any) {
      if (signal?.aborted || convErr?.name === "AbortError") {
        throw convErr;
      }
      const conversionWarning = `目标格式 ${targetFallbackFormat.toUpperCase()} 转换失败（${convErr?.message || String(convErr)}），已回退返回 SVG 原文件。`;
      const fallbackNotice = `已自动降级为大语言模型（${svgRes.usedModel}）用代码生成 SVG（降级原因：${degradedReason}；另注：${conversionWarning}）`;
      return {
        base64Data: svgBuffer.toString("base64"),
        mimeType: "image/svg+xml",
        usedModel: svgRes.usedModel,
        usedProviderId: svgRes.usedProviderId,
        usage: svgRes.usage,
        degraded: true,
        degradedReason,
        fallbackNotice,
        fallbackMode: "llm_svg",
        outputFormat: "svg",
        convertedFromSvg: false,
        conversionWarning,
      };
    }
  }

  const fallbackNotice = `已自动降级为大语言模型（${svgRes.usedModel}）用代码生成 SVG（降级原因：${degradedReason}）`;
  return {
    base64Data: svgBuffer.toString("base64"),
    mimeType: "image/svg+xml",
    usedModel: svgRes.usedModel,
    usedProviderId: svgRes.usedProviderId,
    usage: svgRes.usage,
    degraded: true,
    degradedReason,
    fallbackNotice,
    fallbackMode: "llm_svg",
    outputFormat: "svg",
    convertedFromSvg: false,
  };
}
