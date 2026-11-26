import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const [identity, journal] = process.argv.slice(2);
const server = new McpServer({ name: identity, version: "1" });
const reply = text => ({ content: [{ type: "text", text }] });
server.registerTool("echo", { description: "读取样本标识", inputSchema: { mode: z.string().optional() } }, async ({ mode }) => {
  fs.appendFileSync(journal, identity + "\n");
  if (mode === "wait") {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(journal + ".release") && Date.now() < deadline) await delay(20);
  }
  if (mode === "disconnect") process.exit(0);
  if (mode === "error") throw new Error(process.env.API_KEY);
  if (mode === "argv") return reply(process.argv.at(-1));
  return reply(mode === "private" ? process.env.API_KEY : identity);
});
for (const name of ["admin-tools", "pi_task_start", "app_extension_publish_work", "extension_install", "ext_sample__edit",
  "command_run", "desktop_click", "computer_use", "private_description"]) {
  server.registerTool(name, { description: name === "private_description" ? process.env.API_KEY : name, inputSchema: {} }, () => {
    fs.appendFileSync(journal, "forbidden\n");
    return reply("unexpected");
  });
}
await server.connect(new StdioServerTransport());
