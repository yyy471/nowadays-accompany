import './status-dot.css';

/** 配置页状态点（v6 规范 §3）：7px 圆点 + 可选说明文字，两页/书脊/页脚/目录共用。 */
export type DotStatus = 'ok' | 'follow' | 'off' | 'dirty' | 'error' | 'none';

export function StatusDot({
  status,
  label,
  bare = false,
  faint = false,
}: {
  /** ok/follow/none 外观上分别是实心/空心/空心；none 按「选填未填」正常态处理，不写字。 */
  status: DotStatus;
  /** 状态说明；bare 时进 title 与 aria-label，非 bare 时作为可见文字。 */
  label: string;
  /** 只显示圆点：说明必须同时写进 title 与 aria-label（配 role="img" 读屏才读）。 */
  bare?: boolean;
  /** 正常态淡色圆点（透明度 0.8；off 空心圈不淡化）。 */
  faint?: boolean;
}) {
  const dataStatus = status === 'none' ? 'off' : status;
  if (bare) {
    return (
      <span
        className={`ui-dot dot${faint ? ' faint' : ''}`}
        data-s={dataStatus}
        role="img"
        title={label}
        aria-label={label}
      />
    );
  }
  return (
    <span className={`ui-dot dot${faint ? ' faint' : ''}`} data-s={dataStatus}>
      {label}
    </span>
  );
}
