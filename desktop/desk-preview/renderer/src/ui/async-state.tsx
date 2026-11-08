import type { ReactNode } from 'react';
import { ErrorNote } from './foundation';

export function LoadingNote({ label = '正在读取…' }: { label?: string }) {
  return <p className="muted" role="status">{label}</p>;
}

/**
 * 查询结果的状态边界：只有“成功且确认没有数据”才显示空态；
 * 已有旧数据时，错误作为提示显示在内容上方，不替换整块内容。
 */
export function AsyncBoundary({
  loading,
  error,
  hasData,
  empty,
  onRetry,
  loadingText = '正在读取…',
  errorPrefix = '读取失败',
  children
}: {
  loading: boolean;
  error?: string;
  hasData: boolean;
  empty?: ReactNode;
  onRetry?: () => void;
  loadingText?: string;
  errorPrefix?: string;
  children: ReactNode;
}) {
  if (!hasData && loading) return <LoadingNote label={loadingText} />;
  if (!hasData && error) return <ErrorNote message={`${errorPrefix}：${error}`} {...(onRetry ? { onRetry } : {})} />;
  if (!hasData && empty !== undefined) return <>{empty}</>;
  return <>
    {error ? <ErrorNote message={`${errorPrefix}：${error}，当前显示上次读取的数据。`} {...(onRetry ? { onRetry } : {})} /> : null}
    {children}
  </>;
}
