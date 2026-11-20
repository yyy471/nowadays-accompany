// 可作为独立 stdio MCP 绑定给角色。书目 URL 仅由启动配置给出，测试凭据不参与读取。
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const books = z.array(z.object({ title: z.string().min(1), url: z.url({ protocol: /^https$/ }) }))
  .min(1).parse(JSON.parse(process.env.NOWADAYS_READING_SHELF ?? "[]"));
const server = new McpServer({ name: "reading-shelf", version: "1.0" });
async function fetchArticle(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { redirect: "error", signal: AbortSignal.timeout(25_000) });
    } catch (error) {
      if (attempt >= 2 || !["UND_ERR_CONNECT_TIMEOUT","ECONNRESET","EAI_AGAIN"].includes(error.cause?.code)) throw error;
      await delay((attempt + 1) * 500);
    }
  }
}
server.registerTool("reading_list", { description: "查看书架上的在线原文，可自行选择感兴趣的篇目。", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify(books) }] }));
server.registerTool("read_article", {
  description: "从原站读书架上的 UTF-8 文本文档，返回带来源和原文位置的连续段落。后续可按段号继续。",
  inputSchema: { title: z.string(), paragraph: z.number().int().min(1).default(1), count: z.number().int().min(1).max(6).default(3) },
}, async ({ title, paragraph, count }) => {
  const book = books.find(item => item.title === title);
  if (!book) throw Error("ARTICLE_NOT_ON_SHELF");
  const response = await fetchArticle(book.url);
  if (!response.ok || !/^text\/(plain|markdown)\b/i.test(response.headers.get("content-type") ?? "")) throw Error("ARTICLE_FETCH_FAILED");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw Error("ARTICLE_TOO_LARGE");
    chunks.push(chunk);
  }
  const article = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const sections = [...article.matchAll(/[^\s][\s\S]*?(?=(?:\r?\n[ \t]*){2,}|$)/g)];
  const fragments = sections.slice(paragraph - 1, paragraph - 1 + count).map(match => ({
    startOffset: match.index, text: match[0],
  }));
  if (!fragments.length) throw Error("ARTICLE_END");
  const pageVersion = createHash("sha256").update(article).digest("hex");
  return { content: [{ type: "text", text: JSON.stringify({ title, paragraph, nextParagraph:
    paragraph - 1 + fragments.length < sections.length ? paragraph + fragments.length : null }) }],
    structuredContent: { webReading: { url: book.url, pageVersion, fragments } } };
});
await server.connect(new StdioServerTransport());
