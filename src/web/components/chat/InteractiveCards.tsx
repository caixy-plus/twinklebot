import { useRef, useState } from "react";
import { extractSuggestedCommandPattern } from "/shared/policy-utils.js";
import {
  refreshSettingsFromServer,
  refreshVault,
  showToast,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { useI18n } from "../../services/i18n.js";
import {
  isImeConfirmEnter,
  translateToolHumanSummary,
} from "../../state/helpers.js";
import {
  resolveApprovalItemSummary,
  setState,
  type StreamItem,
} from "../../state/store.js";
import { AvatarNode } from "../common/AvatarView.js";
import { stripLeadingStatusGlyph, UiIcon } from "../common/Icon.js";

function ReceiptStatusText({
  text,
  forceTone,
}: {
  text: string;
  forceTone?: "ok" | "error";
}) {
  const parsed = stripLeadingStatusGlyph(String(text || ""));
  if (!parsed.icon) return <span>{parsed.text}</span>;
  const tone =
    forceTone ||
    (parsed.icon === "check-circle" || parsed.icon === "shield-check" || parsed.icon === "lock"
      ? "ok"
      : parsed.icon === "x-circle"
        ? "error"
        : undefined);
  const cls = `inline-ui-icon inline-status-svg${tone === "ok" ? " is-ok" : tone === "error" ? " is-error" : ""}`;
  return (
    <span>
      <UiIcon name={parsed.icon} className={cls} size={14} />
      {parsed.text}
    </span>
  );
}

export function ChoiceCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "choice" }>;
}) {
  const { t } = useI18n();
  const questions =
    Array.isArray(item.questions) && item.questions.length > 0
      ? item.questions
      : [
          {
            id: "q1",
            question: t("card.choiceDefaultQuestion"),
            options: [],
            multiSelect: false,
            placeholder: t("card.choiceCustomPlaceholder"),
          },
        ];

  const [stepIdx, setStepIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [selectedMulti, setSelectedMulti] = useState<string[]>([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const customCompEndRef = useRef<number | null>(null);
  const customInputRef = useRef<HTMLInputElement | null>(null);

  const curQ = questions[stepIdx] || questions[0];
  const letters = ["A", "B", "C", "D", "E", "F"];

  const submitFinalPayload = async (payload: any, badgeLabel = "✓") => {
    setSubmitting(true);
    try {
      await apiJson(`/api/choices/${item.callId}`, {
        method: "POST",
        body: JSON.stringify({ selected: payload }),
      });
      setState((prev) => ({
        streamItems: prev.streamItems.map((it) =>
          it.kind === "choice" && it.callId === item.callId
            ? {
                ...it,
                status: "resolved",
                selectedSummary: payload,
                chosenBadge: badgeLabel,
              }
            : it
        ),
      }));
    } catch (err: any) {
      setSubmitting(false);
      showToast(t("card.choiceSubmitFailed", { error: err.message }));
    }
  };

  const advanceOrSubmit = (answerVal: any, badgeLabel = "✓") => {
    const qKey = curQ.id || `q${stepIdx + 1}`;
    const nextAnswers = { ...answers, [qKey]: answerVal };
    setAnswers(nextAnswers);
    if (stepIdx + 1 < questions.length) {
      setStepIdx(stepIdx + 1);
      setSelectedMulti([]);
      setCustomOpen(false);
      setCustomValue("");
    } else if (questions.length === 1) {
      submitFinalPayload(answerVal, badgeLabel);
    } else {
      submitFinalPayload(nextAnswers, "✓");
    }
  };

  if (item.status === "resolved") {
    const chosenBadge = item.chosenBadge || "✓";
    const summary = item.selectedSummary;
    const multiJoiner = t("card.choiceMultiJoiner");
    const summaryText =
      typeof summary === "object" && summary !== null && !Array.isArray(summary)
        ? Object.values(summary)
            .map((v) => (Array.isArray(v) ? v.join(multiJoiner) : String(v ?? "")))
            .join(" · ")
        : Array.isArray(summary)
          ? summary.join(multiJoiner)
          : String(summary ?? "");

    return (
      <div className="choice-card is-resolved">
        <div className="choice-card-header">
          <div className="choice-card-question">{curQ.question || t("card.choiceFallbackQuestion")}</div>
        </div>
        <div className="choice-options-stack">
          <div className="choice-option-btn" style={{ cursor: "default" }}>
            <span className="choice-letter-badge">
              {chosenBadge === "✓" ? (
                <UiIcon name="check" size={13} />
              ) : chosenBadge === "✎" ? (
                <UiIcon name="pencil" size={12} />
              ) : (
                chosenBadge
              )}
            </span>
            <span>{summaryText}</span>
          </div>
        </div>
      </div>
    );
  }

  if (item.status === "superseded") {
    return (
      <div className="choice-card is-superseded">
        <div className="choice-card-header">
          <div className="choice-card-question">{curQ.question || t("card.choiceFallbackQuestion")}</div>
        </div>
        <div className="choice-options-stack">
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {t("card.choiceSuperseded")}
          </div>
        </div>
      </div>
    );
  }

  const opts = Array.isArray(curQ.options) ? curQ.options : [];

  return (
    <div className="choice-card">
      <div className="choice-card-header">
        <div className="choice-card-question">{curQ.question || t("card.choiceFallbackQuestion")}</div>
        {questions.length > 1 && (
          <span className="choice-stepper-pill">
            {stepIdx + 1} / {questions.length}
          </span>
        )}
      </div>
      <div className="choice-options-stack">
        {opts.map((optText, idx) => {
          const letter = letters[idx] || String(idx + 1);
          const isChecked = selectedMulti.includes(optText);
          return (
            <button
              key={`${idx}-${optText}`}
              type="button"
              className={`choice-option-btn${isChecked ? " is-checked" : ""}`}
              data-choice-index={String(idx)}
              disabled={submitting}
              onClick={() => {
                if (curQ.multiSelect) {
                  setSelectedMulti((prev) =>
                    prev.includes(optText)
                      ? prev.filter((x) => x !== optText)
                      : [...prev, optText]
                  );
                  return;
                }
                advanceOrSubmit(optText, letter);
              }}
            >
              <span className="choice-letter-badge">{letter}</span>
              <span>{optText}</span>
            </button>
          );
        })}

        {curQ.multiSelect && (
          <div className="choice-multi-footer">
            <button
              type="button"
              className="settings-blue-pill"
              disabled={submitting}
              onClick={() => {
                if (selectedMulti.length === 0) {
                  showToast(t("card.choiceSelectOneToast"));
                  return;
                }
                advanceOrSubmit(selectedMulti, "✓");
              }}
            >
              {stepIdx + 1 < questions.length ? t("card.choiceNextStep") : t("card.choiceConfirm")}
            </button>
          </div>
        )}

        {item.allowCustom && (
          <div className="choice-custom-wrap">
            <button
              type="button"
              className="choice-option-btn choice-custom-trigger"
              hidden={customOpen}
              disabled={submitting}
              onClick={() => {
                setCustomOpen(true);
                requestAnimationFrame(() => customInputRef.current?.focus());
              }}
            >
              <span className="choice-letter-badge" style={{ opacity: 0.75 }}>
                <UiIcon name="pencil" size={12} />
              </span>
              <span>{curQ.placeholder || t("card.choiceCustomPlaceholder")}</span>
            </button>

            <div className="choice-custom-form" hidden={!customOpen}>
              <input
                ref={customInputRef}
                type="text"
                className="choice-custom-input"
                placeholder={curQ.placeholder || t("card.choiceCustomInputPlaceholder")}
                value={customValue}
                disabled={submitting}
                onChange={(e) => setCustomValue(e.target.value)}
                onCompositionEnd={(e) => {
                  customCompEndRef.current = e.timeStamp;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (isImeConfirmEnter(e, customCompEndRef.current)) return;
                    const val = customValue.trim();
                    if (val) advanceOrSubmit(val, "✎");
                  } else if (e.key === "Escape") {
                    setCustomOpen(false);
                  }
                }}
              />
              <button
                type="button"
                className="choice-custom-submit"
                aria-label={t("card.choiceSubmitCustomAria")}
                title={t("card.choiceSubmitCustomAria")}
                disabled={submitting}
                onClick={() => {
                  const val = customValue.trim();
                  if (val) advanceOrSubmit(val, "✎");
                }}
              >
                <UiIcon name="arrow-up" size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ApprovalCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "approval" }>;
}) {
  const { locale, t } = useI18n();
  const rawPath = typeof item.args?.path === "string" ? item.args.path.trim() : "";
  const suggestedPathPattern = (() => {
    if (!rawPath) return "";
    const normalized = rawPath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash > 0) {
      return rawPath.slice(0, lastSlash + 1);
    }
    return rawPath;
  })();
  const defaultPattern =
    extractSuggestedCommandPattern(item.args?.command) ||
    suggestedPathPattern ||
    item.args?.url ||
    item.args?.app ||
    item.args?.target ||
    "";
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleMode, setRuleMode] = useState<"allow" | "ask">("allow");
  const [pattern, setPattern] = useState(defaultPattern);
  const [submitting, setSubmitting] = useState(false);
  const patternInputRef = useRef<HTMLInputElement | null>(null);

  if (item.resolved) {
    return (
      <div className="confirm-card is-collapsed">
        <ReceiptStatusText text={item.receiptText || t("card.approvalHandledFallback")} />
      </div>
    );
  }

  const decide = async (allow: boolean, saveAlways = false, customRule: any = null) => {
    setSubmitting(true);
    try {
      await apiJson(`/api/approvals/${item.callId}`, {
        method: "POST",
        body: JSON.stringify({
          allow,
          ...(customRule
            ? { customRule }
            : saveAlways
              ? {
                  alwaysRule: {
                    tool: item.name || "*",
                    pattern: defaultPattern,
                    label: `${item.name} ${defaultPattern}`.trim(),
                  },
                }
              : {}),
        }),
      });
      const receipt = resolveApprovalItemSummary(
        item.name,
        item.args,
        customRule ? "custom" : saveAlways ? "always" : allow ? "allow" : "deny",
        locale
      );
      setState((prev) => ({
        streamItems: prev.streamItems.map((it) =>
          it.kind === "approval" && it.callId === item.callId
            ? { ...it, resolved: true, receiptText: receipt }
            : it
        ),
      }));
      if (saveAlways || customRule) {
        showToast(t("card.approvalRuleUpdatedToast"));
        refreshSettingsFromServer();
      }
    } catch (err: any) {
      setSubmitting(false);
      showToast(t("card.approvalSubmitFailed", { error: err.message }));
    }
  };

  return (
    <div className="confirm-card">
      <div className="confirm-header">
        {translateToolHumanSummary(item.name, item.args, locale)}
      </div>
      <div style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
        {item.reason || t("card.approvalDefaultReason")}
      </div>
      <details className="confirm-cmd-details">
        <summary>{t("card.approvalViewDetails", { name: item.name || "tool" })}</summary>
        <pre className="trace-pre">{JSON.stringify(item.args || {}, null, 2)}</pre>
      </details>

      <div className="confirm-rule-editor" hidden={!ruleOpen}>
        <div className="confirm-rule-row">
          <select
            className="inline-text-input"
            style={{ width: "auto" }}
            value={ruleMode}
            onChange={(e) => setRuleMode(e.target.value as "allow" | "ask")}
          >
            <option value="allow">{t("card.approvalRuleAllow")}</option>
            <option value="ask">{t("card.approvalRuleAsk")}</option>
          </select>
          <input
            ref={patternInputRef}
            type="text"
            className="inline-text-input"
            style={{ flex: 1 }}
            value={pattern}
            placeholder={t("card.approvalRulePatternPlaceholder")}
            onChange={(e) => setPattern(e.target.value)}
          />
          <button
            type="button"
            className="settings-blue-pill"
            disabled={submitting}
            onClick={() => {
              const pat = pattern.trim();
              decide(true, false, {
                mode: ruleMode,
                tool: item.name || "*",
                pattern: pat,
                label: `${item.name || "*"} ${pat}`.trim(),
              });
            }}
          >
            {t("card.approvalSaveRuleAndContinue")}
          </button>
        </div>
      </div>

      <div className="confirm-actions">
        <button
          type="button"
          className="btn-approve"
          disabled={submitting}
          onClick={() => decide(true, false)}
        >
          {t("card.approvalAllow")}
        </button>
        <button
          type="button"
          className="btn-deny"
          disabled={submitting}
          onClick={() => decide(false, false)}
        >
          {t("card.approvalDeny")}
        </button>
        <button
          type="button"
          className="btn-always-allow"
          disabled={submitting}
          onClick={() => decide(true, true)}
        >
          {t("card.approvalAlwaysAllow")}
        </button>
        <button
          type="button"
          className="btn-edit-rule"
          disabled={submitting}
          onClick={() => {
            const next = !ruleOpen;
            setRuleOpen(next);
            if (next) {
              requestAnimationFrame(() => patternInputRef.current?.focus());
            }
          }}
        >
          {t("card.approvalEditRule")}
        </button>
      </div>
    </div>
  );
}

export function DraftCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "draft" }>;
}) {
  const { t } = useI18n();
  const [recipient, setRecipient] = useState(item.recipient || "");
  const [title, setTitle] = useState(item.title || "");
  const [content, setContent] = useState(item.content || "");
  const [submitting, setSubmitting] = useState(false);

  if (item.resolved) {
    const approved = item.approved !== false;
    const raw =
      item.overrideText ||
      (approved
        ? t("card.draftApprovedReceipt", { title: item.finalTitle || item.title || t("card.draftContentFallback") })
        : t("card.draftCancelledReceipt", { title: item.finalTitle || item.title || t("card.draftContentFallback") }));
    return (
      <div className="draft-card is-collapsed">
        <ReceiptStatusText text={raw} forceTone={approved ? "ok" : "error"} />
      </div>
    );
  }

  const submitDraft = async (approved: boolean) => {
    setSubmitting(true);
    const payload = {
      approved,
      title: title.trim(),
      recipient: item.recipient ? recipient.trim() : "",
      content,
    };
    try {
      await apiJson(`/api/choices/${item.callId}`, {
        method: "POST",
        body: JSON.stringify({ selected: payload }),
      });
      setState((prev) => ({
        streamItems: prev.streamItems.map((it) =>
          it.kind === "draft" && it.callId === item.callId
            ? { ...it, resolved: true, approved, finalTitle: payload.title }
            : it
        ),
      }));
    } catch (err: any) {
      setSubmitting(false);
      showToast(t("card.draftSubmitFailed", { error: err.message }));
    }
  };

  return (
    <div className="draft-card">
      <div className="draft-header-row">
        <span className="draft-badge">
          <UiIcon name="pencil" className="inline-ui-icon" size={13} />
          {t("card.draftBadge", { kind: item.draftKind || t("card.draftKindFallback") })}
        </span>
      </div>
      {Boolean(item.recipient) && (
        <input
          type="text"
          className="draft-field-input"
          value={recipient}
          placeholder={t("card.draftRecipientPlaceholder")}
          onChange={(e) => setRecipient(e.target.value)}
        />
      )}
      <input
        type="text"
        className="draft-field-input"
        value={title}
        placeholder={t("card.draftTitlePlaceholder")}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="draft-body-textarea"
        value={content}
        placeholder={t("card.draftBodyPlaceholder")}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="confirm-actions">
        <button
          type="button"
          className="btn-approve"
          disabled={submitting}
          onClick={() => submitDraft(true)}
        >
          {t("card.draftSend")}
        </button>
        <button
          type="button"
          className="btn-deny"
          disabled={submitting}
          onClick={() => submitDraft(false)}
        >
          {t("card.draftCancel")}
        </button>
      </div>
    </div>
  );
}

export function CredentialCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "credential" }>;
}) {
  const { t } = useI18n();
  const [secret, setSecret] = useState("");
  const [saveToVault, setSaveToVault] = useState(
    !item.hideVaultCheckbox && item.fieldType !== "otp"
  );
  const [submitting, setSubmitting] = useState(false);

  if (item.resolved) {
    const raw = item.resolvedText
      ? item.resolvedText
      : item.submitted
        ? t("card.credentialSubmittedReceipt", { service: item.service || "" })
        : t("card.credentialSkippedReceipt", { service: item.service || "" });
    return (
      <div className="credential-card is-collapsed">
        <ReceiptStatusText text={raw} />
      </div>
    );
  }

  const sendCred = async (withValue: boolean) => {
    setSubmitting(true);
    const val = withValue ? secret.trim() : "";
    const shouldVault = Boolean(val && saveToVault && !item.hideVaultCheckbox);
    try {
      await apiJson(`/api/choices/${item.callId}`, {
        method: "POST",
        body: JSON.stringify({
          selected: {
            value: val,
            saveToVault: shouldVault,
            account: item.service || "",
          },
        }),
      });
      setSecret("");
      setState((prev) => ({
        streamItems: prev.streamItems.map((it) =>
          it.kind === "credential" && it.callId === item.callId
            ? { ...it, resolved: true, submitted: Boolean(val) }
            : it
        ),
      }));
      if (shouldVault) refreshVault();
    } catch (err: any) {
      setSubmitting(false);
      showToast(t("card.credentialSubmitFailed", { error: err.message }));
    }
  };

  return (
    <div className="credential-card">
      <div className="draft-header-row">
        <span className="draft-badge">
          <UiIcon name="lock" className="inline-ui-icon" size={13} />
          {t("card.credentialBadge", { service: item.service || t("card.credentialServiceFallback") })}
        </span>
      </div>
      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
        {item.label || t("card.credentialDefaultLabel")}
      </div>
      <input
        type={item.fieldType === "text" ? "text" : "password"}
        autoComplete={item.fieldType === "otp" ? "one-time-code" : "off"}
        className="credential-secret-input"
        placeholder={
          item.fieldType === "otp"
            ? t("card.credentialOtpPlaceholder")
            : t("card.credentialPasswordPlaceholder")
        }
        value={secret}
        disabled={submitting}
        onChange={(e) => setSecret(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            sendCred(true);
          }
        }}
      />
      <label className="credential-vault-check" hidden={Boolean(item.hideVaultCheckbox)}>
        <input
          type="checkbox"
          checked={saveToVault}
          onChange={(e) => setSaveToVault(e.target.checked)}
        />
        <span>{t("card.credentialSaveToVault")}</span>
      </label>
      <div className="confirm-actions">
        <button
          type="button"
          className="btn-approve"
          disabled={submitting}
          onClick={() => sendCred(true)}
        >
          {t("card.credentialSubmit")}
        </button>
        <button
          type="button"
          className="btn-deny"
          disabled={submitting}
          onClick={() => sendCred(false)}
        >
          {t("card.credentialSkip")}
        </button>
      </div>
    </div>
  );
}

export function BotExchangePill({
  item,
}: {
  item: Extract<StreamItem, { kind: "bot_exchange" }>;
}) {
  const { t } = useI18n();
  const count = Number(item.messageCount) || 1;
  const labelText =
    count === 1
      ? item.direction === "inbound"
        ? t("card.exchangeInbound")
        : t("card.exchangeOutbound")
      : t("card.exchangeCount", { count });

  const handleOpen = async () => {
    if (!item.exchangeId) return;
    try {
      const ex = await apiJson(`/api/exchanges/${item.exchangeId}`);
      setState({
        botExchangeSheet: {
          open: true,
          participants: Array.isArray(ex.participants) ? ex.participants : [],
          messages: Array.isArray(ex.messages) ? ex.messages : [],
        },
      });
    } catch (err: any) {
      showToast(t("card.exchangeLoadFailed", { error: err.message }));
    }
  };

  return (
    <button type="button" className="bot-exchange-pill" onClick={handleOpen}>
      <span>{labelText}</span>
      {item.peer && (
        <span className="exchange-peer-chip">
          <AvatarNode avatar={item.peer.avatar || { shape: "blob", color: "black" }} />
          <span>{item.peer.title || "Bot"}</span>
        </span>
      )}
    </button>
  );
}
