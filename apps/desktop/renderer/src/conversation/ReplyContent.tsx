import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PerfRow } from './history';

/** 模型返回的标签、链接和图片只在对话中阅读，外部内容不自动加载。 */
export function ReplyContent({ row }: { row: PerfRow }) {
  if (row.format === 'literal') return <pre className="dialogue-document">{row.text}</pre>;
  if (row.format !== 'markdown') return <>{row.text}</>;
  return <div className="dialogue-document"><Markdown remarkPlugins={[remarkGfm]} components={{
    img: ({ alt }) => <span>{alt}</span>,
    a: ({ children, href }) => <span>{children}{href && <>（{href}）</>}</span>,
  }}>{row.text}</Markdown></div>;
}
