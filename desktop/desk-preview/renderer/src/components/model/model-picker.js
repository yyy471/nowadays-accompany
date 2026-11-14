/**
 * 模型名称选择控件的纯逻辑：候选过滤与测试结果文案。
 *
 * 手填始终可用；列表只用来提供候选，不限制最终提交的模型标识。
 */

const MAX_CANDIDATES = 50;

export const GOOGLE_GEMINI_DEFAULT_BASE_URL =
  "https://aiplatform.googleapis.com/v1/publishers/google";

/**
 * 按接口协议返回默认请求地址（当前 Gemini 官方路径固定，选择时自动补上）。
 * @param {string} protocol
 * @returns {string}
 */
export function defaultModelBaseUrl(protocol) {
  return protocol === "google-gemini" ? GOOGLE_GEMINI_DEFAULT_BASE_URL : "";
}

/**
 * 切换接口协议时同步调整服务地址：
 * - 切到 Gemini 且当前为空时，自动补全官方请求路径；
 * - 切离 Gemini 且仍为自动补全的默认路径时，清空以免误请求；
 * - 用户已手填或改成其他地址时保持原样，不覆盖自定义内容。
 * @param {string} currentUrl
 * @param {string} nextProtocol
 * @returns {string}
 */
export function resolveModelBaseUrlOnProtocolChange(currentUrl, nextProtocol) {
  const raw = String(currentUrl ?? "");
  const trimmed = raw.trim();
  const nextDefault = defaultModelBaseUrl(nextProtocol);
  if (nextDefault) {
    return trimmed.length === 0 ? nextDefault : raw;
  }
  return trimmed === GOOGLE_GEMINI_DEFAULT_BASE_URL ? "" : raw;
}

/**
 * @param {readonly string[] | undefined} models
 * @param {string} query
 * @returns {string[]}
 */
export function filterModelNames(models, query) {
  const keyword = String(query ?? "").trim().toLowerCase();
  const seen = new Set();
  const result = [];
  for (const name of models ?? []) {
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    if (keyword.length === 0 || name.toLowerCase().includes(keyword)) result.push(name);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

/**
 * @param {{ ok?: boolean, elapsedMs?: number, error?: { message?: string } } | null | undefined} result
 * @returns {string}
 */
export function modelTestNote(result) {
  if (result === null || result === undefined) return "";
  if (result.ok === true) {
    const ms = Math.max(0, Math.round(Number(result.elapsedMs ?? 0)));
    return `测试通过 · ${ms} ms`;
  }
  return `测试失败：${result.error?.message ?? "模型请求失败"}`;
}

/**
 * 过滤并决定模型控件下方展示的单条点击日志（读取列表与测试连接相互覆盖）。
 * @param {{ source?: string, role?: string, text?: string, model?: string } | null | undefined} notice
 * @param {string} currentModel
 * @returns {{ source: "list" | "test", role: "alert" | "status", text: string, model?: string } | null}
 */
export function visibleProbeNotice(notice, currentModel) {
  if (!notice || typeof notice.text !== "string" || notice.text.length === 0) {
    return null;
  }
  const source = notice.source === "test" ? "test" : "list";
  const role = notice.role === "alert" ? "alert" : "status";
  if (
    source === "test" &&
    typeof notice.model === "string" &&
    notice.model !== String(currentModel ?? "").trim()
  ) {
    return null;
  }
  return {
    source,
    role,
    text: notice.text,
    ...(typeof notice.model === "string" ? { model: notice.model } : {}),
  };
}

/** 已保存密钥在文本框中默认显示的占位掩码（配合 password 控件隐藏）。 */
export const SECRET_MASK_SENTINEL = "************";

/**
 * 判断资源凭据状态是否代表后端已有保存的凭据或引用。
 * @param {string | undefined} status
 * @returns {boolean}
 */
function hasSavedCredentialStatus(status) {
  return status === "stored" || status === "reference" || status === "unavailable";
}

/**
 * 创建模型密钥文本框的草稿状态。
 * @param {string | undefined} status
 * @returns {{ hasExisting: boolean, baselineSecret: string | null, dirty: boolean, value: string, revealed: boolean }}
 */
export function createSecretDraft(status) {
  const hasExisting = hasSavedCredentialStatus(status);
  return {
    hasExisting,
    baselineSecret: null,
    dirty: false,
    value: hasExisting ? SECRET_MASK_SENTINEL : "",
    revealed: false,
  };
}

/**
 * 处理密钥文本框输入变化：
 * - 尚未显式明文查看时，退格删除掩码直接清空，追加粘贴自动剥离掩码前缀/后缀；
 * - 若改回已读取的原密钥原文，恢复未改动状态，保存时继续保留原密钥。
 * @param {{ hasExisting: boolean, baselineSecret: string | null, dirty: boolean, value: string, revealed: boolean }} draft
 * @param {string} rawValue
 * @returns {{ hasExisting: boolean, baselineSecret: string | null, dirty: boolean, value: string, revealed: boolean }}
 */
export function nextSecretDraftOnInput(draft, rawValue) {
  const input = String(rawValue ?? "");
  if (draft.hasExisting && !draft.dirty && draft.baselineSecret === null) {
    if (input === SECRET_MASK_SENTINEL) {
      return draft;
    }
    let nextValue = input;
    if (
      input.length < SECRET_MASK_SENTINEL.length &&
      (SECRET_MASK_SENTINEL.startsWith(input) || SECRET_MASK_SENTINEL.endsWith(input))
    ) {
      nextValue = "";
    } else if (input.startsWith(SECRET_MASK_SENTINEL)) {
      nextValue = input.slice(SECRET_MASK_SENTINEL.length);
    } else if (input.endsWith(SECRET_MASK_SENTINEL)) {
      nextValue = input.slice(0, input.length - SECRET_MASK_SENTINEL.length);
    }
    return {
      ...draft,
      dirty: true,
      value: nextValue,
    };
  }
  if (draft.hasExisting) {
    if (draft.baselineSecret !== null && input === draft.baselineSecret) {
      return {
        ...draft,
        dirty: false,
        value: input,
      };
    }
    return {
      ...draft,
      dirty: true,
      value: input,
    };
  }
  return {
    ...draft,
    dirty: input.length > 0,
    value: input,
  };
}

/**
 * 将后端按需取回的密钥原文写入草稿（若用户已在编辑则不覆盖用户输入）。
 * @param {{ hasExisting: boolean, baselineSecret: string | null, dirty: boolean, value: string, revealed: boolean }} draft
 * @param {string} secretText
 * @returns {{ hasExisting: boolean, baselineSecret: string | null, dirty: boolean, value: string, revealed: boolean }}
 */
export function applyRevealedSecret(draft, secretText) {
  const text = String(secretText ?? "");
  if (draft.dirty) {
    return { ...draft, revealed: true };
  }
  return {
    ...draft,
    baselineSecret: text,
    value: text,
    revealed: true,
    dirty: false,
  };
}

/**
 * 隐藏未改动过的已保存密钥时，重新用占位掩码替代内存中展示的原文。
 * @param {{ hasExisting: boolean, baselineSecret: string | null, dirty: boolean, value: string, revealed: boolean }} draft
 * @returns {{ hasExisting: boolean, baselineSecret: string | null, dirty: boolean, value: string, revealed: boolean }}
 */
export function hideUneditedSecret(draft) {
  if (!draft.hasExisting || draft.dirty) {
    return { ...draft, revealed: false };
  }
  return {
    ...draft,
    baselineSecret: null,
    value: SECRET_MASK_SENTINEL,
    revealed: false,
  };
}

/**
 * 推导保存时提交给后端的密钥意图：保留、清空或替换。
 * @param {{ hasExisting: boolean, baselineSecret: string | null, dirty: boolean, value: string, revealed: boolean }} draft
 * @returns {{ action: "keep" } | { action: "clear" } | { action: "replace", secret: string }}
 */
export function secretOperationOf(draft) {
  if (!draft.dirty) {
    return { action: "keep" };
  }
  if (draft.value.length === 0) {
    return draft.hasExisting ? { action: "clear" } : { action: "keep" };
  }
  return { action: "replace", secret: draft.value };
}
