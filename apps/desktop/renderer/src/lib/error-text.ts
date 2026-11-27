import { ApiError } from '../api';

/** 将请求失败转为可直接显示的短句；主动取消保持安静。 */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '';
  if (error instanceof ApiError && (error.code === 'BACKEND_OFFLINE' || error.code === 'BACKEND_UNREACHABLE')) {
    return '本地服务暂时连不上';
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/\p{Script=Han}/u.test(message)) return message;
  if (/failed to fetch|networkerror|load failed/i.test(message)) return '本地服务暂时连不上';
  return '操作暂时未完成，请稍后重试';
}
