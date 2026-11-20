import { useRef, useState } from "react";
import {
  refreshSettingsFromServer,
  refreshVault,
  showToast,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
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
  const questions =
    Array.isArray(item.questions) && item.questions.length > 0
      ? item.questions
      : [
          {
            id: "q1",
            question: "接下来先帮你做哪一步？",
            options: [],
            multiSelect: false,
            placeholder: "输入你自己的回答…",
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
      showToast(`提交选择失败: ${err.message}`);
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
    const summaryText =
      typeof summary === "object" && summary !== null && !Array.isArray(summary)
        ? Object.values(summary)
            .map((v) => (Array.isArray(v) ? v.join("、") : String(v ?? "")))
            .join(" · ")
        : Array.isArray(summary)
          ? summary.join("、")
          : String(summary ?? "");

    return (
      <div className="choice-card is-resolved">
        <div className="choice-card-header">
          <div className="choice-card-question">{curQ.question || "请选择下一步操作"}</div>
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
          <div className="choice-card-question">{curQ.question || "请选择下一步操作"}</div>
        </div>
        <div className="choice-options-stack">
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            已通过后续对话直接回复
          </div>
        </div>
      </div>
    );
  }

  const opts = Array.isArray(curQ.options) ? curQ.options : [];

  return (
    <div className="choice-card">
      <div className="choice-card-header">
        <div className="choice-card-question">{curQ.question || "请选择下一步操作"}</div>
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
                  showToast("请至少选择一项，或输入你自己的回答");
                  return;
                }
                advanceOrSubmit(selectedMulti, "✓");
              }}
            >
              {stepIdx + 1 < questions.length ? "下一题" : "确认选择"}
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
              <span>{curQ.placeholder || "输入你自己的回答…"}</span>
            </button>

            <div className="choice-custom-form" hidden={!customOpen}>
              <input
                ref={customInputRef}
                type="text"
                className="choice-custom-input"
                placeholder={curQ.placeholder || "输入你自己的回答，按 Enter 提交…"}
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
                aria-label="提交自定义回答"
                title="提交自定义回答"
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
  const defaultPattern =
    item.args?.command?.split(/\s+/)[0] || item.args?.path || item.args?.url || "";
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleMode, setRuleMode] = useState<"allow" | "ask">("allow");
  const [pattern, setPattern] = useState(defaultPattern);
  const [submitting, setSubmitting] = useState(false);
  const patternInputRef = useRef<HTMLInputElement | null>(null);

  if (item.resolved) {
    return (
      <div className="confirm-card is-collapsed">
        <ReceiptStatusText text={item.receiptText || "✓ 已处理"} />
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
        customRule ? "custom" : saveAlways ? "always" : allow ? "allow" : "deny"
      );
      setState((prev) => ({
        streamItems: prev.streamItems.map((it) =>
          it.kind === "approval" && it.callId === item.callId
            ? { ...it, resolved: true, receiptText: receipt }
            : it
        ),
      }));
      if (saveAlways || customRule) {
        showToast("权限规则已更新");
        refreshSettingsFromServer();
      }
    } catch (err: any) {
      setSubmitting(false);
      showToast(`审批提交失败: ${err.message}`);
    }
  };

  return (
    <div className="confirm-card">
      <div className="confirm-header">
        {translateToolHumanSummary(item.name, item.args)}
      </div>
      <div style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
        {item.reason || "请确认是否允许执行该操作。"}
      </div>
      <details className="confirm-cmd-details">
        <summary>查看详细参数 ({item.name || "tool"})</summary>
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
            <option value="allow">今后自动允许</option>
            <option value="ask">每次先询问</option>
          </select>
          <input
            ref={patternInputRef}
            type="text"
            className="inline-text-input"
            style={{ flex: 1 }}
            value={pattern}
            placeholder="匹配命令前缀或路径关键词…"
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
            保存规则并继续
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
          允许
        </button>
        <button
          type="button"
          className="btn-deny"
          disabled={submitting}
          onClick={() => decide(false, false)}
        >
          暂不允许
        </button>
        <button
          type="button"
          className="btn-always-allow"
          disabled={submitting}
          onClick={() => decide(true, true)}
        >
          始终允许
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
          编辑规则…
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
  const [recipient, setRecipient] = useState(item.recipient || "");
  const [title, setTitle] = useState(item.title || "");
  const [content, setContent] = useState(item.content || "");
  const [submitting, setSubmitting] = useState(false);

  if (item.resolved) {
    const approved = item.approved !== false;
    const raw =
      item.overrideText ||
      (approved
        ? `✓ 已确认草稿：${item.finalTitle || item.title || "内容"}`
        : `✕ 已取消草稿：${item.finalTitle || item.title || "内容"}`);
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
      showToast(`草稿提交失败: ${err.message}`);
    }
  };

  return (
    <div className="draft-card">
      <div className="draft-header-row">
        <span className="draft-badge">
          <UiIcon name="pencil" className="inline-ui-icon" size={13} />
          草稿 · {item.draftKind || "待确认内容"}
        </span>
      </div>
      {Boolean(item.recipient) && (
        <input
          type="text"
          className="draft-field-input"
          value={recipient}
          placeholder="收件人 / 目标渠道"
          onChange={(e) => setRecipient(e.target.value)}
        />
      )}
      <input
        type="text"
        className="draft-field-input"
        value={title}
        placeholder="标题 / 主题"
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="draft-body-textarea"
        value={content}
        placeholder="可在此直接修改草稿正文…"
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="confirm-actions">
        <button
          type="button"
          className="btn-approve"
          disabled={submitting}
          onClick={() => submitDraft(true)}
        >
          确认发送
        </button>
        <button
          type="button"
          className="btn-deny"
          disabled={submitting}
          onClick={() => submitDraft(false)}
        >
          取消草稿
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
  const [secret, setSecret] = useState("");
  const [saveToVault, setSaveToVault] = useState(
    !item.hideVaultCheckbox && item.fieldType !== "otp"
  );
  const [submitting, setSubmitting] = useState(false);

  if (item.resolved) {
    const raw = item.resolvedText
      ? item.resolvedText
      : item.submitted
        ? `🔒 已安全提交 ${item.service || ""} 验证信息`
        : `✕ 已跳过 ${item.service || ""} 验证输入`;
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
      showToast(`凭据提交失败: ${err.message}`);
    }
  };

  return (
    <div className="credential-card">
      <div className="draft-header-row">
        <span className="draft-badge">
          <UiIcon name="lock" className="inline-ui-icon" size={13} />
          安全凭据 · {item.service || "验证"}
        </span>
      </div>
      <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
        {item.label || "请输入密码或一次性验证码（不会明文显示在聊天记录中）"}
      </div>
      <input
        type={item.fieldType === "text" ? "text" : "password"}
        autoComplete={item.fieldType === "otp" ? "one-time-code" : "off"}
        className="credential-secret-input"
        placeholder={item.fieldType === "otp" ? "输入动态验证码…" : "输入密码或凭据…"}
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
        <span>保存到本地保险库 (Vault) 以便下次复用</span>
      </label>
      <div className="confirm-actions">
        <button
          type="button"
          className="btn-approve"
          disabled={submitting}
          onClick={() => sendCred(true)}
        >
          安全提交
        </button>
        <button
          type="button"
          className="btn-deny"
          disabled={submitting}
          onClick={() => sendCred(false)}
        >
          跳过
        </button>
      </div>
    </div>
  );
}

export function MemorySuggestionCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "memory_suggestion" }>;
}) {
  const [submitting, setSubmitting] = useState(false);

  const scopeLabel = item.scope === "global" ? "全局记忆" : "专属记忆";

  const handleResolve = async (action: "accept" | "dismiss") => {
    setSubmitting(true);
    try {
      await apiJson(
        `/api/memories/suggestions/${encodeURIComponent(item.suggestionId)}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            sessionId: item.sessionId || "",
            scope: item.scope,
            name: item.name,
            content: item.content,
          }),
        }
      );
      setState((prev) => ({
        streamItems: prev.streamItems.map((it) =>
          it.kind === "memory_suggestion" && it.suggestionId === item.suggestionId
            ? { ...it, status: action === "accept" ? "accepted" : "dismissed" }
            : it
        ),
      }));
      if (action === "accept") {
        refreshSettingsFromServer();
        showToast(`✓ 已保存至${scopeLabel}`);
      }
    } catch (err: any) {
      setSubmitting(false);
      showToast(`处理记忆建议失败: ${err?.message || "请重试"}`);
    }
  };

  if (item.status !== "pending") {
    const label =
      item.status === "accepted"
        ? `✓ 已存入${scopeLabel}：${item.name}`
        : `已忽略记忆建议：${item.name}`;
    return (
      <div className="draft-card memory-suggestion-card is-collapsed" role="status">
        <ReceiptStatusText
          text={label}
          forceTone={item.status === "accepted" ? "ok" : undefined}
        />
      </div>
    );
  }

  return (
    <div className="draft-card memory-suggestion-card" data-suggestion-id={item.suggestionId}>
      <div className="confirm-header">
        <UiIcon name="lightbulb" className="inline-ui-icon" size={14} /> 建议记住（{scopeLabel}）
      </div>
      <div className="memory-suggestion-body">
        <strong>{item.name}</strong>
        {item.content && item.content !== item.name ? `：${item.content}` : ""}
      </div>
      <div className="confirm-actions">
        <button
          type="button"
          className="btn-approve"
          disabled={submitting}
          onClick={() => handleResolve("accept")}
        >
          保存记忆
        </button>
        <button
          type="button"
          className="btn-deny"
          disabled={submitting}
          onClick={() => handleResolve("dismiss")}
        >
          忽略
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
  const count = Number(item.messageCount) || 1;
  const labelText =
    count === 1
      ? item.direction === "inbound"
        ? "消息来自"
        : "已发消息给"
      : `${count} 条消息往来：`;

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
      showToast(`无法读取交流记录: ${err.message}`);
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
