import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import {
  buildTokenUsageQuery,
  categoryLabel,
  formatCacheHitRate,
  formatExactTokenCount,
  formatTokenCount,
  parseTokenBigInt,
  sharePercent,
  TOKEN_CATEGORY_LABELS,
  TOKEN_USAGE_RANGES,
  type TokenUsageCategory,
  type TokenUsageRange,
  type TokenUsageSummaryView,
  type TokenUsageTotalsView,
} from '../../token-usage';
import { AsyncBoundary, Button, Field, Select } from '../../ui';
import { announceLive } from '../../ui/live-announcer';

function maxTotalOf(rows: ReadonlyArray<{ totalTokens: string }>): string {
  let best = 0n;
  for (const row of rows) {
    const value = parseTokenBigInt(row.totalTokens);
    if (value > best) best = value;
  }
  return best.toString();
}

function formatCallSummary(totals: TokenUsageTotalsView): string {
  const parts = [`已回报 ${formatTokenCount(totals.reportedCallCount)} 次`];
  if (totals.missingUsageCount !== '0') {
    parts.push(`未回报用量 ${formatTokenCount(totals.missingUsageCount)} 次`);
  }
  if (totals.failedCallCount !== '0') {
    parts.push(`失败 ${formatTokenCount(totals.failedCallCount)} 次`);
  }
  return parts.join(' · ');
}

function formatBreakdownMeta(totals: TokenUsageTotalsView): string {
  const parts = [
    `输入 ${formatTokenCount(totals.inputTokens)}（缓存 ${formatCacheHitRate(totals.cachedTokens, totals.inputTokens)}）`,
    `输出 ${formatTokenCount(totals.outputTokens)}`,
    `${formatTokenCount(totals.callCount)} 次`,
  ];
  if (totals.missingUsageCount !== '0') {
    parts.push(`未回报 ${formatTokenCount(totals.missingUsageCount)}`);
  }
  return parts.join(' · ');
}

/** 全局设置「用量」分区：展示本机持久累计的 7 类 Token 消耗（只读，DL-183）。 */
export function TokenUsageSection({ active }: { active: boolean }) {
  const [range, setRange] = useState<TokenUsageRange>('7d');
  const [roleKey, setRoleKey] = useState('');
  const [category, setCategory] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [summary, setSummary] = useState<TokenUsageSummaryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const seqRef = useRef(0);
  const summaryRef = useRef<TokenUsageSummaryView | null>(null);
  const announceNextRef = useRef(false);
  summaryRef.current = summary;

  useEffect(() => {
    if (!active) return;
    const seq = ++seqRef.current;
    const controller = new AbortController();
    if (summaryRef.current === null) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError('');
    const url = buildTokenUsageQuery({
      range,
      roleKey: roleKey || null,
      category: (category || null) as TokenUsageCategory | null,
      modelKey: modelKey || null,
    });
    void api<TokenUsageSummaryView>(url, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setSummary(data);
        setLoading(false);
        setRefreshing(false);
        if (announceNextRef.current) {
          announceNextRef.current = false;
          announceLive('用量统计已刷新');
        }
      })
      .catch((reason) => {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setLoading(false);
        setRefreshing(false);
        announceNextRef.current = false;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      controller.abort();
    };
  }, [active, range, roleKey, category, modelKey, refreshTick]);

  const triggerRefresh = useCallback(() => {
    announceNextRef.current = true;
    setRefreshTick((v) => v + 1);
  }, []);

  const hasFilters = Boolean(roleKey || category || modelKey);
  const clearFilters = () => {
    setRoleKey('');
    setCategory('');
    setModelKey('');
  };

  const roleOptions = useMemo(() => {
    const list = summary?.availableFilters.roles ?? [];
    if (!roleKey || list.some((item) => item.roleKey === roleKey)) return list;
    return [
      ...list,
      { roleKey, roleId: roleKey === '__global__' ? null : roleKey, roleName: '当前筛选角色', deleted: false },
    ];
  }, [summary, roleKey]);

  const modelOptions = useMemo(() => {
    const list = summary?.availableFilters.models ?? [];
    if (!modelKey || list.some((item) => item.modelKey === modelKey)) return list;
    return [
      ...list,
      { modelKey, resourceId: null, resourceName: '当前筛选', modelName: modelKey, deleted: false },
    ];
  }, [summary, modelKey]);

  const maxDaily = useMemo(
    () => (summary ? maxTotalOf(summary.daily) : '0'),
    [summary],
  );
  const maxCategory = useMemo(
    () => (summary ? maxTotalOf(summary.byCategory) : '0'),
    [summary],
  );
  const maxRole = useMemo(
    () => (summary ? maxTotalOf(summary.byRole) : '0'),
    [summary],
  );
  const maxModel = useMemo(
    () => (summary ? maxTotalOf(summary.byModel) : '0'),
    [summary],
  );

  const rangeDescription = summary
    ? summary.startDate === null
      ? `截至 ${summary.endDate}（全部本机记录）`
      : summary.startDate === summary.endDate
        ? `${summary.endDate}（今日）`
        : `${summary.startDate} 至 ${summary.endDate}`
    : '';

  return (
    <div className="config-prose nd-usage-page">
      <header className="config-sec-head nd-usage-head">
        <h2 tabIndex={-1}>用量</h2>
        <div className="nd-usage-head-tools">
          <div className="nd-usage-ranges" role="group" aria-label="统计时间范围">
            {TOKEN_USAGE_RANGES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="nd-usage-range-btn"
                aria-pressed={range === item.id}
                onClick={() => setRange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            busy={refreshing}
            disabled={loading}
            onClick={triggerRefresh}
          >
            刷新
          </Button>
        </div>
      </header>

      <div className="nd-usage-filters">
        <Field label="角色">
          <Select
            aria-label="按角色筛选"
            value={roleKey}
            onChange={(event) => setRoleKey(event.target.value)}
          >
            <option value="">全部角色</option>
            {roleOptions.map((item) => (
              <option key={item.roleKey} value={item.roleKey}>
                {item.roleName}
                {item.deleted ? '（已删除）' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="用途">
          <Select
            aria-label="按用途筛选"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">全部用途</option>
            {Object.entries(TOKEN_CATEGORY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="模型">
          <Select
            aria-label="按模型筛选"
            value={modelKey}
            onChange={(event) => setModelKey(event.target.value)}
          >
            <option value="">全部模型</option>
            {modelOptions.map((item) => (
              <option key={item.modelKey} value={item.modelKey}>
                {item.resourceName} · {item.modelName}
                {item.deleted ? '（已删除）' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            清除筛选
          </Button>
        )}
      </div>

      <AsyncBoundary
        loading={loading}
        error={error}
        hasData={summary !== null}
        onRetry={triggerRefresh}
        loadingText="正在汇总 Token 消耗…"
      >
        {summary && (
          <>
            <p className="nd-usage-caption">
              {rangeDescription} · 按本机自然日统计 · 删除角色或模型服务后仍保留历史消耗
            </p>

            <section className="nd-usage-kpis" aria-label="Token 消耗总览">
              <article className="nd-usage-kpi">
                <span className="nd-usage-kpi-label">总消耗</span>
                <strong
                  className="nd-usage-kpi-value"
                  data-testid="usage-total-tokens"
                  title={formatExactTokenCount(summary.totals.totalTokens)}
                >
                  {formatTokenCount(summary.totals.totalTokens)}
                </strong>
                <small>
                  输入 {formatTokenCount(summary.totals.inputTokens)} · 输出{' '}
                  {formatTokenCount(summary.totals.outputTokens)}
                </small>
              </article>

              <article className="nd-usage-kpi">
                <span className="nd-usage-kpi-label">输入与缓存</span>
                <strong
                  className="nd-usage-kpi-value"
                  data-testid="usage-input-tokens"
                  title={formatExactTokenCount(summary.totals.inputTokens)}
                >
                  {formatTokenCount(summary.totals.inputTokens)}
                </strong>
                <small>
                  缓存命中 {formatTokenCount(summary.totals.cachedTokens)}（命中率{' '}
                  {formatCacheHitRate(summary.totals.cachedTokens, summary.totals.inputTokens)}）
                  {summary.totals.cacheCreationTokens !== '0'
                    ? ` · 写入 ${formatTokenCount(summary.totals.cacheCreationTokens)}`
                    : ''}
                </small>
              </article>

              <article className="nd-usage-kpi">
                <span className="nd-usage-kpi-label">输出</span>
                <strong
                  className="nd-usage-kpi-value"
                  data-testid="usage-output-tokens"
                  title={formatExactTokenCount(summary.totals.outputTokens)}
                >
                  {formatTokenCount(summary.totals.outputTokens)}
                </strong>
                <small>累计生成输出 Token</small>
              </article>

              <article className="nd-usage-kpi">
                <span className="nd-usage-kpi-label">模型调用</span>
                <strong
                  className="nd-usage-kpi-value"
                  data-testid="usage-call-count"
                  title={formatExactTokenCount(summary.totals.callCount)}
                >
                  {formatTokenCount(summary.totals.callCount)} 次
                </strong>
                <small>{formatCallSummary(summary.totals)}</small>
              </article>
            </section>

            {summary.totals.callCount === '0' ? (
              <p className="nd-usage-empty">当前时间范围或筛选条件下暂无模型调用记录。</p>
            ) : (
              <>
                <section className="nd-usage-section" aria-label="每日趋势">
                  <h3>每日趋势</h3>
                  {summary.daily.length === 0 ? (
                    <p className="nd-usage-empty">暂无按日数据。</p>
                  ) : (
                    <ul className="nd-usage-daily-list">
                      {summary.daily.map((day) => {
                        const width = sharePercent(day.totalTokens, maxDaily);
                        return (
                          <li key={day.date} className="nd-usage-daily-row">
                            <span className="nd-usage-daily-date">{day.date}</span>
                            <span className="nd-usage-bar-track" aria-hidden="true">
                              <span
                                className="nd-usage-bar-fill"
                                style={{ width: `${width}%` }}
                              />
                            </span>
                            <span
                              className="nd-usage-daily-val"
                              title={formatExactTokenCount(day.totalTokens)}
                            >
                              {formatTokenCount(day.totalTokens)}
                            </span>
                            <small className="nd-usage-daily-sub">
                              输入 {formatTokenCount(day.inputTokens)} / 输出{' '}
                              {formatTokenCount(day.outputTokens)} · {formatTokenCount(day.callCount)} 次
                            </small>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <div className="nd-usage-breakdowns">
                  <section className="nd-usage-section" aria-label="按用途统计">
                    <h3>按用途</h3>
                    <div className="nd-usage-rows">
                      {summary.byCategory.map((row) => {
                        const selected = category === row.category;
                        const width = sharePercent(row.totalTokens, maxCategory);
                        return (
                          <button
                            key={row.category}
                            type="button"
                            className="nd-usage-row-btn"
                            aria-pressed={selected}
                            onClick={() =>
                              setCategory((prev) => (prev === row.category ? '' : row.category))
                            }
                          >
                            <div className="nd-usage-row-top">
                              <span className="nd-usage-row-name">
                                {categoryLabel(row.category)}
                              </span>
                              <strong
                                className="nd-usage-row-total"
                                title={formatExactTokenCount(row.totalTokens)}
                              >
                                {formatTokenCount(row.totalTokens)}
                              </strong>
                            </div>
                            <span className="nd-usage-bar-track" aria-hidden="true">
                              <span
                                className="nd-usage-bar-fill"
                                style={{ width: `${width}%` }}
                              />
                            </span>
                            <small className="nd-usage-row-meta">{formatBreakdownMeta(row)}</small>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="nd-usage-section" aria-label="按角色统计">
                    <h3>按角色</h3>
                    <div className="nd-usage-rows">
                      {summary.byRole.map((row) => {
                        const selected = roleKey === row.roleKey;
                        const width = sharePercent(row.totalTokens, maxRole);
                        return (
                          <button
                            key={row.roleKey}
                            type="button"
                            className="nd-usage-row-btn"
                            aria-pressed={selected}
                            onClick={() =>
                              setRoleKey((prev) => (prev === row.roleKey ? '' : row.roleKey))
                            }
                          >
                            <div className="nd-usage-row-top">
                              <span className="nd-usage-row-name">
                                <span>{row.roleName}</span>
                                {row.deleted && <span className="nd-usage-tag">已删除</span>}
                                {row.roleId === null && <span className="nd-usage-tag">全局</span>}
                              </span>
                              <strong
                                className="nd-usage-row-total"
                                title={formatExactTokenCount(row.totalTokens)}
                              >
                                {formatTokenCount(row.totalTokens)}
                              </strong>
                            </div>
                            <span className="nd-usage-bar-track" aria-hidden="true">
                              <span
                                className="nd-usage-bar-fill"
                                style={{ width: `${width}%` }}
                              />
                            </span>
                            <small className="nd-usage-row-meta">{formatBreakdownMeta(row)}</small>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="nd-usage-section" aria-label="按模型与服务商统计">
                    <h3>按模型与服务商</h3>
                    <div className="nd-usage-rows">
                      {summary.byModel.map((row) => {
                        const selected = modelKey === row.modelKey;
                        const width = sharePercent(row.totalTokens, maxModel);
                        return (
                          <button
                            key={row.modelKey}
                            type="button"
                            className="nd-usage-row-btn"
                            aria-pressed={selected}
                            onClick={() =>
                              setModelKey((prev) => (prev === row.modelKey ? '' : row.modelKey))
                            }
                          >
                            <div className="nd-usage-row-top">
                              <span className="nd-usage-row-name">
                                <span>{row.modelName}</span>
                                {row.deleted && <span className="nd-usage-tag">已删除</span>}
                              </span>
                              <strong
                                className="nd-usage-row-total"
                                title={formatExactTokenCount(row.totalTokens)}
                              >
                                {formatTokenCount(row.totalTokens)}
                              </strong>
                            </div>
                            <small className="nd-usage-row-sub">
                              {row.resourceName}
                              {row.provider ? ` · ${row.provider}` : ''} · {row.protocol}
                            </small>
                            <span className="nd-usage-bar-track" aria-hidden="true">
                              <span
                                className="nd-usage-bar-fill"
                                style={{ width: `${width}%` }}
                              />
                            </span>
                            <small className="nd-usage-row-meta">{formatBreakdownMeta(row)}</small>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </div>
              </>
            )}
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}
