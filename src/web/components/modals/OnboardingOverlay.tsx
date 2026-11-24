import { useEffect, useState } from "react";
import {
  applyLanguagePreference,
  refreshSettingsFromServer,
  showToast,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { useI18n } from "../../services/i18n.js";
import { PROVIDER_PRESETS_UI } from "../../state/constants.js";
import { parseModelsCsv } from "../../state/helpers.js";
import { useStore } from "../../state/store.js";
import { StatusText } from "../common/Icon.js";

const ONBOARDING_PROVIDER_KEYS = [
  "gemini",
  "openai",
  "deepseek",
  "openai-compatible",
] as const;

export function OnboardingOverlay() {
  const required = useStore((s) => Boolean(s.settings?.onboardingRequired));
  const gcpVertexActive = useStore((s) => Boolean(s.settings?.gcpVertexActive));
  const blockedVertexReason = useStore((s) => String(s.settings?.blockedVertexReason || ""));
  const { language: currentLanguage, t } = useI18n();

  const [type, setType] = useState("gemini");
  const [name, setName] = useState("Google Gemini");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelsInput, setModelsInput] = useState(
    "gemini-4-hydrogen, gemini-4-argon, gemini-4-carbon"
  );
  const [fastModel, setFastModel] = useState("gemini-4-hydrogen");
  const [mediumModel, setMediumModel] = useState("gemini-4-argon");
  const [advancedModel, setAdvancedModel] = useState("gemini-4-carbon");
  const [testing, setTesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; kind: "info" | "ok" | "error" }>({
    text: "",
    kind: "info",
  });

  const parsedModels = parseModelsCsv(modelsInput);

  useEffect(() => {
    if (parsedModels.length === 0) {
      setFastModel("");
      setMediumModel("");
      setAdvancedModel("");
      return;
    }
    setFastModel((prev) => (parsedModels.includes(prev) ? prev : parsedModels[0]));
    setMediumModel((prev) =>
      parsedModels.includes(prev)
        ? prev
        : parsedModels[Math.min(1, parsedModels.length - 1)]
    );
    setAdvancedModel((prev) =>
      parsedModels.includes(prev) ? prev : parsedModels[parsedModels.length - 1]
    );
  }, [modelsInput]);

  const handleTypeChange = (nextType: string) => {
    const preset = PROVIDER_PRESETS_UI[nextType] || PROVIDER_PRESETS_UI.openai;
    setType(nextType);
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setModelsInput(preset.models);
    setFeedback({ text: "", kind: "info" });
  };

  const handleTest = async () => {
    setTesting(true);
    setFeedback({ text: "正在测试与模型接口的连通性…", kind: "info" });
    try {
      const res = await apiJson("/api/providers/test", {
        method: "POST",
        body: JSON.stringify({
          type,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          models: parsedModels,
          model: parsedModels[0],
        }),
      });
      if (res.ok) {
        setFeedback({
          text: `✓ 连接成功！模型 ${res.model} 延迟 ${res.latencyMs}ms`,
          kind: "ok",
        });
      } else {
        setFeedback({
          text: `❌ 连接失败：${res.error || "请检查 API Key 或 Base URL"}`,
          kind: "error",
        });
      }
    } catch (err: any) {
      setFeedback({ text: `❌ 测试失败：${err.message}`, kind: "error" });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    const pid = `${type}-primary`;
    const resolvedName = name.trim() || PROVIDER_PRESETS_UI[type]?.name || type;
    setSubmitting(true);
    try {
      await apiJson("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({
          provider: {
            id: pid,
            type,
            name: resolvedName,
            apiKey: apiKey.trim(),
            baseUrl: baseUrl.trim(),
            models: parsedModels,
          },
          tiers: {
            fast: { providerId: pid, model: fastModel || parsedModels[0] || "" },
            medium: { providerId: pid, model: mediumModel || parsedModels[0] || "" },
            advanced: { providerId: pid, model: advancedModel || parsedModels[0] || "" },
          },
        }),
      });
      await refreshSettingsFromServer();
      showToast("模型接入完成，欢迎使用 TwinkleBot");
    } catch (err: any) {
      setFeedback({ text: `❌ ${err.message}`, kind: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const activePreset = PROVIDER_PRESETS_UI[type] || PROVIDER_PRESETS_UI.gemini;

  return (
    <div
      id="onboarding-overlay"
      className="onboarding-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="首次使用配置引导"
      hidden={!required}
    >
      <div className="onboarding-card">
        <div className="onboarding-header">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              width: "100%",
            }}
          >
            <div className="onboarding-badge">TwinkleBot</div>
            <select
              id="onboarding-language-select"
              className="settings-select"
              aria-label={t("lang.label")}
              value={currentLanguage}
              onChange={(e) => applyLanguagePreference(e.target.value, true)}
              style={{ width: "auto", minWidth: "110px" }}
            >
              <option value="system">{t("lang.system")}</option>
              <option value="zh-CN">{t("lang.zhCN")}</option>
              <option value="en">{t("lang.en")}</option>
            </select>
          </div>
          <h1 className="onboarding-title">{t("onboarding.welcomeTitle")}</h1>
          <p className="onboarding-sub">{t("onboarding.welcomeSub")}</p>
        </div>

        <div className="onboarding-field">
          <span>{t("onboarding.providerType")}</span>
          <div className="provider-preset-pills" role="radiogroup" aria-label="模型供应商">
            {ONBOARDING_PROVIDER_KEYS.map((pKey) => {
              const pr = PROVIDER_PRESETS_UI[pKey];
              const active = type === pKey;
              return (
                <button
                  key={pKey}
                  type="button"
                  role="radio"
                  aria-checked={active ? "true" : "false"}
                  className={`provider-preset-pill${active ? " is-active" : ""}`}
                  data-provider-preset={pKey}
                  onClick={() => handleTypeChange(pKey)}
                >
                  {pr?.shortLabel || pr?.name || pKey}
                </button>
              );
            })}
          </div>
          <select
            id="onboarding-provider-type"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            value={type}
            onChange={(e) => handleTypeChange(e.target.value)}
          >
            {ONBOARDING_PROVIDER_KEYS.map((pKey) => (
              <option key={pKey} value={pKey}>
                {PROVIDER_PRESETS_UI[pKey]?.name || pKey}
              </option>
            ))}
          </select>
          <span className="provider-preset-hint">{activePreset.hint}</span>
        </div>

        {type === "gemini" && gcpVertexActive && (
          <div className="mail-feedback-box is-success">
            当前连接的 GCP 云服务器已通过环境变量启用 Vertex AI 服务账号认证，API Key 可留空。
          </div>
        )}
        {type === "gemini" && !gcpVertexActive && blockedVertexReason && (
          <div className="mail-feedback-box is-error">{blockedVertexReason}</div>
        )}

        <div className="onboarding-grid">
          <label className="onboarding-field">
            <span>显示名称</span>
            <input
              id="onboarding-provider-name"
              type="text"
              className="inline-text-input"
              value={name}
              placeholder="供应商名称"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="onboarding-field" id="onboarding-base-url-wrap">
            <span>Base URL（{type === "openai-compatible" ? "必填" : "可选"}）</span>
            <input
              id="onboarding-base-url"
              type="url"
              className="inline-text-input"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
        </div>

        <label className="onboarding-field">
          <span>
            API Key
            {type === "gemini" && gcpVertexActive ? "（GCP Vertex 已启用，可留空）" : ""}
          </span>
          <input
            id="onboarding-api-key"
            type="password"
            className="inline-text-input"
            placeholder="粘贴 API Key 或填环境变量名（如 GEMINI_API_KEY）"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        <label className="onboarding-field">
          <span>可用模型列表（逗号分隔）</span>
          <input
            id="onboarding-models-input"
            type="text"
            className="inline-text-input"
            value={modelsInput}
            onChange={(e) => setModelsInput(e.target.value)}
          />
        </label>

        <div className="onboarding-tiers-box">
          <div className="onboarding-tiers-title">分配 3 档智能路由模型</div>
          <div className="onboarding-tiers-grid">
            <label className="onboarding-field">
              <span>极速档（Fast）</span>
              <select
                id="onboarding-tier-fast"
                className="inline-text-input"
                value={fastModel}
                onChange={(e) => setFastModel(e.target.value)}
              >
                {parsedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="onboarding-field">
              <span>中等档（Medium）</span>
              <select
                id="onboarding-tier-medium"
                className="inline-text-input"
                value={mediumModel}
                onChange={(e) => setMediumModel(e.target.value)}
              >
                {parsedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="onboarding-field">
              <span>高级档（Advanced）</span>
              <select
                id="onboarding-tier-advanced"
                className="inline-text-input"
                value={advancedModel}
                onChange={(e) => setAdvancedModel(e.target.value)}
              >
                {parsedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div
          id="onboarding-feedback"
          className={`mail-feedback-box${feedback.kind === "ok" ? " is-ok" : feedback.kind === "error" ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
          hidden={!feedback.text}
        >
          <StatusText text={feedback.text} />
        </div>

        <div className="onboarding-actions">
          <button
            id="onboarding-test-btn"
            type="button"
            className="settings-pill-btn"
            disabled={testing || submitting}
            onClick={handleTest}
          >
            {testing ? t("common.testing") : t("onboarding.testBtn")}
          </button>
          <button
            id="onboarding-submit-btn"
            type="button"
            className="settings-blue-pill"
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitting ? t("onboarding.submitting") : t("onboarding.submitBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
