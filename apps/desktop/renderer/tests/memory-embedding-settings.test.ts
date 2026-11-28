import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  embeddingStatusLabel,
  toEmbeddingDraft,
  validateEmbeddingDraft,
  type MemoryEmbeddingSettings,
} from '../src/components/config/memory-embedding.ts';

const ready: MemoryEmbeddingSettings = {
  enabled: true,
  resourceId: 'model-a',
  modelName: 'text-embedding-3-small',
  ready: true,
};

test('toEmbeddingDraft 把 null 服务与型号转为空串并保留启用状态', () => {
  assert.deepEqual(toEmbeddingDraft({ enabled: false, resourceId: null, modelName: null, ready: false }), {
    enabled: false,
    resourceId: '',
    modelName: '',
  });
  assert.deepEqual(toEmbeddingDraft(ready), {
    enabled: true,
    resourceId: 'model-a',
    modelName: 'text-embedding-3-small',
  });
});

test('关闭时始终放行，并保留已选服务与型号，空串转为 null', () => {
  assert.deepEqual(
    validateEmbeddingDraft({ enabled: false, resourceId: 'model-a', modelName: 'bge-m3' }, []),
    { ok: true, payload: { enabled: false, resourceId: 'model-a', modelName: 'bge-m3' } },
  );
  assert.deepEqual(
    validateEmbeddingDraft({ enabled: false, resourceId: '', modelName: '  ' }, []),
    { ok: true, payload: { enabled: false, resourceId: null, modelName: null } },
  );
  // 即使服务已停用或型号缺失，关闭状态也不拦截。
  assert.equal(
    validateEmbeddingDraft({ enabled: false, resourceId: 'retired', modelName: '' }, ['model-a']).ok,
    true,
  );
});

test('启用时缺服务、服务停用、缺型号均拒绝并给出中文提示', () => {
  const missingService = validateEmbeddingDraft({ enabled: true, resourceId: '', modelName: 'bge-m3' }, ['model-a']);
  assert.equal(missingService.ok, false);
  assert.match(missingService.ok ? '' : missingService.message, /请选择.*模型服务/);

  const disabledService = validateEmbeddingDraft({ enabled: true, resourceId: 'retired', modelName: 'bge-m3' }, ['model-a']);
  assert.equal(disabledService.ok, false);
  assert.match(disabledService.ok ? '' : disabledService.message, /停用或不可用/);

  const missingModel = validateEmbeddingDraft({ enabled: true, resourceId: 'model-a', modelName: '   ' }, ['model-a']);
  assert.equal(missingModel.ok, false);
  assert.match(missingModel.ok ? '' : missingModel.message, /Embedding 型号/);
});

test('启用且服务可用、型号非空时放行并裁剪型号空白', () => {
  assert.deepEqual(
    validateEmbeddingDraft({ enabled: true, resourceId: 'model-a', modelName: '  bge-m3  ' }, ['model-a', 'model-b']),
    { ok: true, payload: { enabled: true, resourceId: 'model-a', modelName: 'bge-m3' } },
  );
});

test('embeddingStatusLabel 覆盖未加载、关闭、就绪与未就绪三态', () => {
  assert.deepEqual(embeddingStatusLabel(null), { tone: 'off', label: '仅使用 FTS5 全文检索' });
  assert.deepEqual(
    embeddingStatusLabel({ enabled: false, resourceId: 'model-a', modelName: 'bge-m3', ready: true }),
    { tone: 'off', label: '仅使用 FTS5 全文检索' },
  );
  assert.deepEqual(embeddingStatusLabel(ready), { tone: 'ok', label: '已启用混合语义召回' });
  assert.deepEqual(
    embeddingStatusLabel({ ...ready, ready: false }),
    { tone: 'dirty', label: '已启用（模型未就绪，自动退回 FTS5）' },
  );
});
