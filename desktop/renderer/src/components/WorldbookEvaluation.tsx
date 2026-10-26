import type { WorldbookEvaluation } from '../../../../src/contracts/worldbook.js';

/** Shared markup; called inline so both editors render the same status fields. */
export function worldbookEvaluationView(evaluation: WorldbookEvaluation, sourceLabel: string) {
  return (
    <div role="status" className="worldbook-evaluation">
      <p className="field-hint"><strong>{sourceLabel}</strong>：只使用当前输入的测试文本，不读取真实历史、不调用模型、不发送消息、不写入记忆。</p>
      {evaluation.scanLimited ? <p className="notice notice-warn">扫描受限：扫描优先当前文本与最近历史；本次测试仍只检查当前文本。已达到扫描上限，仅完成部分检查，不能将剩余条目理解为完整检查后未命中。</p> : null}
      {evaluation.unscannedIds?.length ? <p>未完成检查的条目：{evaluation.unscannedIds.join('、')}</p> : null}
      <p>已选用：{evaluation.selectedIds.join('、') || '无'}；预算不足跳过：{evaluation.skippedIds.join('、') || '无'}；使用 {evaluation.usedChars} 字符。</p>
      <p className="field-hint">字符预算统计的是注入文本长度，不是模型 token 计数。</p>
      <h3>角色前注入</h3><pre className="snippet">{evaluation.beforeRole || '无'}</pre>
      <h3>角色后注入</h3><pre className="snippet">{evaluation.afterRole || '无'}</pre>
    </div>
  );
}
