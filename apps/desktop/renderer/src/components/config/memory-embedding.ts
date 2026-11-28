/** 可选记忆语义检索：设置快照、草稿转换与提交前校验（DL-51 方案 A）。 */

export type MemoryEmbeddingSettings = {
  enabled: boolean;
  resourceId: string | null;
  modelName: string | null;
  ready: boolean;
};

export type MemoryEmbeddingDraft = {
  enabled: boolean;
  resourceId: string;
  modelName: string;
};

export type MemoryEmbeddingPayload = {
  enabled: boolean;
  resourceId: string | null;
  modelName: string | null;
};

export type EmbeddingValidation =
  | { ok: true; payload: MemoryEmbeddingPayload }
  | { ok: false; message: string };

/** 后端快照 → 可编辑草稿；null 统一转为空串，便于受控输入。 */
export function toEmbeddingDraft(settings: MemoryEmbeddingSettings): MemoryEmbeddingDraft {
  return {
    enabled: settings.enabled,
    resourceId: settings.resourceId ?? '',
    modelName: settings.modelName ?? '',
  };
}

/**
 * 校验草稿并构造 PUT 载荷。
 * 关闭时始终放行，并保留已选服务与型号；开启时要求服务可用且型号非空。
 */
export function validateEmbeddingDraft(
  draft: MemoryEmbeddingDraft,
  enabledModelIds: readonly string[],
): EmbeddingValidation {
  const resourceId = draft.resourceId.trim();
  const modelName = draft.modelName.trim();
  if (!draft.enabled) {
    return {
      ok: true,
      payload: {
        enabled: false,
        resourceId: resourceId || null,
        modelName: modelName || null,
      },
    };
  }
  if (!resourceId) return { ok: false, message: '请选择用于语义召回的向量模型服务' };
  if (!enabledModelIds.includes(resourceId)) {
    return { ok: false, message: '所选模型服务已停用或不可用，请重新选择' };
  }
  if (!modelName) return { ok: false, message: '请填写 Embedding 型号，例如 text-embedding-3-small' };
  return { ok: true, payload: { enabled: true, resourceId, modelName } };
}

/** 状态点三态：关闭只用 FTS5；开启且就绪走混合召回；开启未就绪自动退回 FTS5。 */
export function embeddingStatusLabel(settings: MemoryEmbeddingSettings | null): {
  tone: 'ok' | 'dirty' | 'off';
  label: string;
} {
  if (!settings || !settings.enabled) {
    return { tone: 'off', label: '仅使用 FTS5 全文检索' };
  }
  if (settings.ready) {
    return { tone: 'ok', label: '已启用混合语义召回' };
  }
  return { tone: 'dirty', label: '已启用（模型未就绪，自动退回 FTS5）' };
}
