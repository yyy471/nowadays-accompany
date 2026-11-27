export const errorDescriptions: ReadonlyMap<string, string> = new Map([
  ['ROLE_STOPPED', '角色已停止活动'],
  ['ROLE_ACTIVITY_STOPPED', '角色已停止活动'],
  ['ROLE_EXCHANGE_NO_REPLY', '角色结束了本次活动，未发送下一轮发言'],
  ['EXECUTION_FAILED', '执行没有完成'],
  ['MODEL_TIMEOUT', '模型响应超时'],
  ['MODEL_REQUEST_FAILED', '模型请求失败'],
  ['MEMORY_MODEL_FAILED', '整理用的模型没有返回结果'],
  ['MEMORY_CAPACITY_EXCEEDED', '这一批太长，只整理了一部分'],
  ['AUTONOMY_BUDGET_EXHAUSTED', '今日额度用完'],
  ['TASK_CIRCUIT_BREAKER', '连续失败，任务已暂停'],
]);
