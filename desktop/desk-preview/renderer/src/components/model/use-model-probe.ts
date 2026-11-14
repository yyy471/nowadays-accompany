import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from '../../api';
import { modelTestNote, type ProbeNotice } from './model-picker.js';
import {
  getModelCacheEpoch,
  getModelCacheVersion,
  readModelCache,
  subscribeModelCache,
  writeModelCache,
} from './model-cache.js';

/** 候选配置探测目标：草稿直接用表单值，已保存服务走按资源接口。 */
export type ModelProbeTarget =
  | {
      kind: 'draft';
      config: {
        protocol: string;
        baseUrl: string;
        secret?: string;
        /** 复用已保存服务的密钥；仅同协议、同 origin 时后端才放行。 */
        resourceId?: string;
      };
    }
  | {
      kind: 'saved';
      resourceId: string;
      /** 成功后写入按服务共享的候选缓存。 */
      cacheKey?: string;
    };

export interface ModelProbeOptions {
  /** 读取按服务共享的候选（角色页与设置页共用）。 */
  shared?: boolean;
  /** 已保存服务的列表 / 测试成功后刷新资源摘要。 */
  onSavedList?: () => void;
  onSavedTest?: () => void;
}

interface ModelListResult {
  models?: string[];
}

interface ModelTestResult {
  ok?: boolean;
  elapsedMs?: number;
  error?: { message?: string };
}

function messageOf(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}

/** 换密钥会推进供应商缓存代次；晚到的旧结果（成功或失败）都应丢弃。 */
function staleAfterRotation(
  target: ModelProbeTarget,
  epoch: number | null,
): boolean {
  return (
    epoch !== null &&
    target.kind === 'saved' &&
    target.cacheKey !== undefined &&
    epoch !== getModelCacheEpoch(target.cacheKey)
  );
}

/**
 * 模型列表与连接测试。
 *
 * 列表与测试各自持有代际，互不干扰忙碌状态；配置键变化时两类在途请求都
 * 失效。已保存服务的成功候选写入按服务共享的缓存，角色页可直接读取。
 */
export function useModelProbe(key: string, options: ModelProbeOptions = {}) {
  const [models, setModels] = useState<string[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState('');
  const [listLoaded, setListLoaded] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testNote, setTestNote] = useState('');
  const [testModel, setTestModel] = useState('');
  const [notice, setNotice] = useState<ProbeNotice | null>(null);
  const listGeneration = useRef(0);
  const testGeneration = useRef(0);
  // 共享一条日志序号：后一次点击（读取列表或测试连接）或离开页面会覆盖前一次日志。
  const clickLogSeq = useRef(0);
  // 共享页记住当前供应商的缓存代次；代次变化说明凭据已更换。
  const epochRef = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const savedHooks = useRef(options);
  savedHooks.current = options;
  const cacheVersion = useSyncExternalStore(subscribeModelCache, getModelCacheVersion);

  // 配置键变化：丢弃两类在途请求，并读取共享候选。
  useEffect(() => {
    listGeneration.current += 1;
    testGeneration.current += 1;
    clickLogSeq.current += 1;
    setListBusy(false);
    setTestBusy(false);
    setListError('');
    setTestNote('');
    setTestModel('');
    setNotice(null);
    epochRef.current = getModelCacheEpoch(key);
    if (options.shared === true) {
      const cached = readModelCache(key);
      setModels(cached ?? []);
      setListLoaded(cached !== null);
    } else {
      setModels([]);
      setListLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, options.shared]);

  // 其他页面写入共享候选后同步（仅共享实例）。
  useEffect(() => {
    if (options.shared !== true) return;
    // 凭据代次变化（例如换密钥）时，已显示的旧错误与旧测试结果一并清除。
    const epoch = getModelCacheEpoch(key);
    if (epoch !== epochRef.current) {
      epochRef.current = epoch;
      clickLogSeq.current += 1;
      setListError('');
      setTestNote('');
      setTestModel('');
      setNotice(null);
    }
    const cached = readModelCache(key);
    if (cached !== null) {
      setModels(cached);
      setListLoaded(true);
    } else {
      // 缓存被清理（例如换密钥）时，共享页也不继续显示旧候选。
      setModels([]);
      setListLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion, options.shared, key]);

  const clearLog = useCallback(() => {
    clickLogSeq.current += 1;
    setListError('');
    setTestNote('');
    setTestModel('');
    setNotice(null);
  }, []);

  const reset = useCallback(() => {
    listGeneration.current += 1;
    testGeneration.current += 1;
    clickLogSeq.current += 1;
    setModels([]);
    setListError('');
    setListLoaded(false);
    setTestNote('');
    setTestModel('');
    setNotice(null);
    setListBusy(false);
    setTestBusy(false);
  }, []);

  const refresh = useCallback(async (target: ModelProbeTarget) => {
    const version = ++listGeneration.current;
    const logSeq = ++clickLogSeq.current;
    const capturedKey = keyRef.current;
    // 换密钥会推进该供应商的缓存代次；晚到的旧候选不能写回或覆盖列表。
    const epoch =
      target.kind === 'saved' && target.cacheKey !== undefined
        ? getModelCacheEpoch(target.cacheKey)
        : null;
    setListBusy(true);
    setListError('');
    setTestNote('');
    setTestModel('');
    setNotice(null);
    try {
      const result =
        target.kind === 'draft'
          ? await api<ModelListResult>('/v1/model-services/models', {
              method: 'POST',
              body: target.config,
            })
          : await api<ModelListResult>(
              `/v1/resources/${encodeURIComponent(target.resourceId)}/models`,
              { method: 'POST' },
            );
      if (version !== listGeneration.current || capturedKey !== keyRef.current) return;
      if (
        epoch !== null &&
        target.kind === 'saved' &&
        target.cacheKey !== undefined &&
        epoch !== getModelCacheEpoch(target.cacheKey)
      ) {
        return;
      }
      const next = result.models ?? [];
      setModels(next);
      setListLoaded(true);
      if (logSeq === clickLogSeq.current) {
        setNotice({
          source: 'list',
          role: 'status',
          text:
            next.length === 0
              ? '服务没有返回模型，可继续手填。'
              : `已读取 ${next.length} 个模型，可展开选择或输入。`,
        });
      }
      if (target.kind === 'saved') {
        if (target.cacheKey !== undefined) writeModelCache(target.cacheKey, next);
        savedHooks.current.onSavedList?.();
      }
    } catch (error) {
      if (version !== listGeneration.current || capturedKey !== keyRef.current) return;
      if (staleAfterRotation(target, epoch)) return;
      const msg = messageOf(error);
      if (logSeq === clickLogSeq.current) {
        setListError(msg);
        setNotice({
          source: 'list',
          role: 'alert',
          text: `读取失败：${msg}。可继续手填模型名称。`,
        });
      }
    } finally {
      if (version === listGeneration.current) setListBusy(false);
    }
  }, []);

  const test = useCallback(async (target: ModelProbeTarget, model: string) => {
    const version = ++testGeneration.current;
    const logSeq = ++clickLogSeq.current;
    const capturedKey = keyRef.current;
    const epoch =
      target.kind === 'saved' && target.cacheKey !== undefined
        ? getModelCacheEpoch(target.cacheKey)
        : null;
    setTestBusy(true);
    setListError('');
    setTestNote('');
    setTestModel(model);
    setNotice(null);
    try {
      const result =
        target.kind === 'draft'
          ? await api<ModelTestResult>('/v1/model-services/test', {
              method: 'POST',
              body: { ...target.config, model },
            })
          : await api<ModelTestResult>(
              `/v1/resources/${encodeURIComponent(target.resourceId)}/model-test`,
              { method: 'POST', body: { model } },
            );
      if (version !== testGeneration.current || capturedKey !== keyRef.current) return;
      if (staleAfterRotation(target, epoch)) return;
      const note = modelTestNote(result);
      if (logSeq === clickLogSeq.current) {
        setTestNote(note);
        setNotice({
          source: 'test',
          role: result.ok === true ? 'status' : 'alert',
          text: note,
          model,
        });
      }
      if (target.kind === 'saved') savedHooks.current.onSavedTest?.();
    } catch (error) {
      if (version !== testGeneration.current || capturedKey !== keyRef.current) return;
      if (staleAfterRotation(target, epoch)) return;
      const note = `测试失败：${messageOf(error)}`;
      if (logSeq === clickLogSeq.current) {
        setTestNote(note);
        setNotice({
          source: 'test',
          role: 'alert',
          text: note,
          model,
        });
      }
    } finally {
      if (version === testGeneration.current) setTestBusy(false);
    }
  }, []);

  return {
    models,
    listBusy,
    listError,
    listLoaded,
    testBusy,
    testNote,
    testModel,
    notice,
    refresh,
    test,
    clearLog,
    reset,
  };
}
