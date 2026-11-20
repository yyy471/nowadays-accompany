import { setTimeout } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const url = "https://fixture.invalid/reading/topic";
export const paragraphs = Array.from({ length: 10 }, (_, index) =>
  `原文第${index + 1}段 ${String.fromCodePoint(0x4e20 + index).repeat(2450)} END_ARTICLE_${index + 1}!`);
export const article = paragraphs.join("\n\n");

if (process.argv.includes("--serve")) {
  const server = new McpServer({ name: "local-reading-fixture", version: "1.0.0" });
  server.registerTool("read_article", { description: "读取测试文章", inputSchema: { revision: z.boolean().optional() } }, async ({ revision }) => {
    if (process.argv.includes("--slow")) await setTimeout(800);
    const text = revision ? `${article}\n\n新版补充内容` : article;
    return { content: [{ type: "resource", resource: { uri: url, mimeType: "text/plain", text } }] };
  });
  server.registerTool("plain_reference", { description: "只返回普通文本链接", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: `普通回执：见 ${url}` }],
  }));
  await server.connect(new StdioServerTransport());
}
