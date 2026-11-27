import '../styles/paper-skeleton.css';

/** 读取提示由调用方的请求状态控制；纸纹保持静止。 */
export function PaperSkeleton({ label }: { label: string }) {
  return <div className="paper-skeleton" role="status">
    <span>{label}</span>
    <div className="paper-skeleton-lines" aria-hidden="true"><i/><i/><i/></div>
  </div>;
}
