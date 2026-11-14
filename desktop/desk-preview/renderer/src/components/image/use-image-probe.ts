import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from '../../api';
import {
  describeImageFailure,
  evaluateImageConnectionTest,
  toImageServiceProbePayload,
  type ImageProbeResult,
} from '../../image-config.js';
import type { ProbeNotice } from '../model/model-picker.js';
import {
  getImageModelCacheEpoch,
  getImageModelCacheVersion,
  readImageModelCache,
  subscribeImageModelCache,
  writeImageModelCache,
} from './image-cache.js';

export type ImageProbeTarget =
  | {
      kind: 'draft';
      config: {
        serviceId?: string;
        baseUrl: string;
        modelName?: string;
        credentialRef?: string;
        secret?: string;
        timeoutMs?: number;
        workflow?: Record<string, unknown> | null;
      };
    }
  | {
      kind: 'savedService';
      serviceId: string;
      cacheKey?: string;
    }
  | {
      kind: 'role';
      roleId: string;
      serviceId: string;
      cacheKey?: string;
      workflow?: Record<string, unknown> | null;
    };

export interface ImageProbeOptions {
  /** 读取按生图服务共享的候选模型（角色页与设置页同步）。 */
  shared?: boolean;
  onBeforeProbe?: () => void;
  onSavedProbe?: (result: ImageProbeResult) => void;
}

function imageErrorText(error: unknown): string {
  if (error instanceof ApiError) return describeImageFailure(error.code, error.message);
  return error instanceof Error ? error.message : String(error);
}

function cacheKeyOf(target: ImageProbeTarget): string | undefined {
  return target.kind === 'draft' ? undefined : target.cacheKey;
}

function staleAfterEpoch(target: ImageProbeTarget, epoch: number | null): boolean {
  const targetCacheKey = cacheKeyOf(target);
  return (
    epoch !== null &&
    targetCacheKey !== undefined &&
    epoch !== getImageModelCacheEpoch(targetCacheKey)
  );
}

async function fetchImageProbe(target: ImageProbeTarget): Promise<ImageProbeResult> {
  if (target.kind === 'draft') {
    return api<ImageProbeResult>('/v1/image-services/probe', {
      method: 'POST',
      body: toImageServiceProbePayload(target.config),
    });
  }
  if (target.kind === 'savedService') {
    return api<ImageProbeResult>(
      `/v1/image-services/${encodeURIComponent(target.serviceId)}/probe`,
      { method: 'POST' },
    );
  }
  return api<ImageProbeResult>(
    `/v1/roles/${encodeURIComponent(target.roleId)}/scene-image/probe`,
    {
      method: 'POST',
      body: {
        serviceId: target.serviceId,
        ...(target.workflow ? { workflow: target.workflow } : {}),
      },
    },
  );
}

/**
 * 生图模型列表读取与连接测试（逻辑与文本模型的 useModelProbe 对齐）。
 *
 * 读取与测试各自持有代际，互不干扰忙碌状态；共享一条点击日志序号，后一次点击
 * 会覆盖前一次点击日志，切换服务/角色/页面后清零。
 */
export function useImageProbe(key: string, options: ImageProbeOptions = {}) {
  const [models, setModels] = useState<string[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [notice, setNotice] = useState<ProbeNotice | null>(null);
  const listGeneration = useRef(0);
  const testGeneration = useRef(0);
  const clickLogSeq = useRef(0);
  const epochRef = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const hooksRef = useRef(options);
  hooksRef.current = options;
  const cacheVersion = useSyncExternalStore(
    subscribeImageModelCache,
    getImageModelCacheVersion,
  );

  useEffect(() => {
    listGeneration.current += 1;
    testGeneration.current += 1;
    clickLogSeq.current += 1;
    setListBusy(false);
    setTestBusy(false);
    setNotice(null);
    epochRef.current = getImageModelCacheEpoch(key);
    if (options.shared === true) {
      const cached = readImageModelCache(key);
      setModels(cached ?? []);
      setListLoaded(cached !== null);
    } else {
      setModels([]);
      setListLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, options.shared]);

  useEffect(() => {
    if (options.shared !== true) return;
    const epoch = getImageModelCacheEpoch(key);
    if (epoch !== epochRef.current) {
      epochRef.current = epoch;
      clickLogSeq.current += 1;
      setNotice(null);
    }
    const cached = readImageModelCache(key);
    if (cached !== null) {
      setModels(cached);
      setListLoaded(true);
    } else {
      setModels([]);
      setListLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion, options.shared, key]);

  const clearLog = useCallback(() => {
    clickLogSeq.current += 1;
    setNotice(null);
  }, []);

  const reset = useCallback(() => {
    listGeneration.current += 1;
    testGeneration.current += 1;
    clickLogSeq.current += 1;
    setModels([]);
    setListLoaded(false);
    setNotice(null);
    setListBusy(false);
    setTestBusy(false);
  }, []);

  const refresh = useCallback(async (target: ImageProbeTarget) => {
    const version = ++listGeneration.current;
    const logSeq = ++clickLogSeq.current;
    const capturedKey = keyRef.current;
    const targetCacheKey = cacheKeyOf(target);
    const epoch = targetCacheKey !== undefined ? getImageModelCacheEpoch(targetCacheKey) : null;
    hooksRef.current.onBeforeProbe?.();
    setListBusy(true);
    setNotice(null);
    try {
      const result = await fetchImageProbe(target);
      if (version !== listGeneration.current || capturedKey !== keyRef.current) return;
      if (staleAfterEpoch(target, epoch)) return;
      const next = result.probe.models ?? [];
      setModels(next);
      setListLoaded(true);
      if (logSeq === clickLogSeq.current) {
        if (!result.probe.reachable) {
          setNotice({ source: 'list', role: 'alert', text: '读取失败：连不上服务。' });
        } else if (!result.probe.workflowReady) {
          const missing = (result.probe.missingNodes ?? []).join('、');
          setNotice({
            source: 'list',
            role: 'alert',
            text: `已读取 ${next.length} 个模型，但工作流缺节点：${missing}`,
          });
        } else {
          setNotice({
            source: 'list',
            role: 'status',
            text:
              next.length === 0
                ? '服务已连通但未发现可用模型，可继续手填或配置自定义工作流。'
                : `已读取 ${next.length} 个模型，可展开选择或输入。`,
          });
        }
      }
      if (targetCacheKey !== undefined) {
        writeImageModelCache(targetCacheKey, next);
      }
      hooksRef.current.onSavedProbe?.(result);
    } catch (error) {
      if (version !== listGeneration.current || capturedKey !== keyRef.current) return;
      if (staleAfterEpoch(target, epoch)) return;
      if (logSeq === clickLogSeq.current) {
        setNotice({
          source: 'list',
          role: 'alert',
          text: `读取失败：${imageErrorText(error)}。可继续手填模型名称。`,
        });
      }
    } finally {
      if (version === listGeneration.current) setListBusy(false);
    }
  }, []);

  const test = useCallback(async (target: ImageProbeTarget, model: string) => {
    const version = ++testGeneration.current;
    const logSeq = ++clickLogSeq.current;
    const capturedKey = keyRef.current;
    const targetCacheKey = cacheKeyOf(target);
    const epoch = targetCacheKey !== undefined ? getImageModelCacheEpoch(targetCacheKey) : null;
    const trimmedModel = model.trim();
    const hasCustomWorkflow =
      target.kind === 'role'
        ? Boolean(target.workflow)
        : target.kind === 'draft'
          ? Boolean(target.config.workflow)
          : false;
    hooksRef.current.onBeforeProbe?.();
    setTestBusy(true);
    setNotice(null);
    try {
      const result = await fetchImageProbe(target);
      if (version !== testGeneration.current || capturedKey !== keyRef.current) return;
      if (staleAfterEpoch(target, epoch)) return;
      const next = result.probe.models ?? [];
      setModels(next);
      setListLoaded(true);
      if (targetCacheKey !== undefined) {
        writeImageModelCache(targetCacheKey, next);
      }
      const checked = evaluateImageConnectionTest(
        result.probe,
        trimmedModel,
        result.elapsedMs,
        hasCustomWorkflow,
      );
      if (logSeq === clickLogSeq.current) {
        setNotice({
          source: 'test',
          role: checked.role,
          text: checked.text,
          ...(trimmedModel ? { model: trimmedModel } : {}),
        });
      }
      hooksRef.current.onSavedProbe?.(result);
    } catch (error) {
      if (version !== testGeneration.current || capturedKey !== keyRef.current) return;
      if (staleAfterEpoch(target, epoch)) return;
      if (logSeq === clickLogSeq.current) {
        setNotice({
          source: 'test',
          role: 'alert',
          text: `测试失败：${imageErrorText(error)}`,
          ...(trimmedModel ? { model: trimmedModel } : {}),
        });
      }
    } finally {
      if (version === testGeneration.current) setTestBusy(false);
    }
  }, []);

  return {
    models,
    listBusy,
    listLoaded,
    testBusy,
    notice,
    refresh,
    test,
    clearLog,
    reset,
  };
}
