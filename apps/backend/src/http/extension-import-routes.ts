import type { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ResourceService } from "../application/resources/resource-service.js";
import { mcpConfigSchema } from "../domain/resource.js";
import { McpToolClient } from "../mcp/client.js";
import { readJsonBody } from "./body.js";
import { HttpError } from "./errors.js";
import type { Router } from "./router.js";
import { parseBody } from "./validation.js";

const folder = z.object({ sourcePath: z.string().trim().min(1).max(2000) });

// Windows 的 stdio 进程启动失败时，SDK 有时只返回“连接已关闭”。
function commandExists(command: string, env: Record<string, string>, cwd: string) {
  const win = process.platform === "win32";
  const searchPath = env.PATH ?? (win ? env.Path : undefined) ?? process.env.PATH ?? "";
  const directories = path.isAbsolute(command) || /[/\\]/.test(command) ? [cwd] : searchPath.split(path.delimiter);
  const suffixes = win ? ["", ...(env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  return directories.some(dir => suffixes.some(suffix => existsSync(path.resolve(cwd, dir, command + suffix))));
}

// 草稿探测会启动本机进程。只接收桌面代理或本机同源请求。
function localRequest(request: IncomingMessage) {
  const { host, origin } = request.headers;
  if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)
    || (origin && origin !== "desk://bundle" && origin !== `http://${host}`)) {
    throw new HttpError(403, "LOCAL_IMPORT_ONLY", "请从本机设置页操作");
  }
  return readJsonBody(request);
}

export function registerExtensionImportRoutes(router: Router, resources: ResourceService) {
  router.add("POST", "/v1/resources/skills/discover", async ({ request }) => {
    const { sourcePath } = parseBody(folder, await localRequest(request));
    return { status: 200, body: { items: resources.discoverSkills(sourcePath) } };
  });
  router.add("POST", "/v1/resources/skills/import", async ({ request }) => {
    const body = parseBody(folder.extend({ directories: z.array(z.string().min(1)).min(1).max(500) }), await localRequest(request));
    return { status: 201, body: { items: resources.importSkills(body.sourcePath, body.directories) } };
  });
  router.add("POST", "/v1/resources/mcp/probe", async ({ request }) => {
    const input = parseBody(z.union([mcpConfigSchema, z.object({ resourceId: z.string().min(1) }).strict()]), await localRequest(request));
    let draft;
    if ("resourceId" in input) {
      const saved = resources.get(input.resourceId);
      if (saved.kind !== "mcp" || !saved.enabled) throw new HttpError(409, "MCP_UNAVAILABLE", "请选择已启用的 MCP 工具服务");
      draft = parseBody(mcpConfigSchema, saved.config);
    } else {
      draft = input;
    }
    const workspace = await mkdtemp(path.join(os.tmpdir(), "nowadays-mcp-probe-"));
    let client: McpToolClient | undefined;
    try {
      client = await McpToolClient.connect({ ...draft, env: { NOWADAYS_WORKSPACE: workspace, ...draft.env } }, { cwd: workspace, timeoutMs: 60_000 });
      const tools = await client.listTools();
      return { status: 200, body: { tools: tools.map(({ name, description }) => ({ name, description })) } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const missing = code === "ENOENT" || !commandExists(draft.command, draft.env, workspace);
      const program = path.basename(draft.command).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
      const runtime = ["npx", "node", "npm"].includes(program) ? "Node.js（含 npm）" : program === "uvx" ? "uv" : "对应运行环境";
      throw new HttpError(422, "MCP_PROBE_FAILED", missing
        ? `找不到启动程序 ${draft.command}，请安装${runtime}或填写程序完整路径。`
        : "工具服务未能启动或未返回工具列表，请检查运行环境、参数和密钥。");
    } finally {
      await client?.close().catch(() => {});
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
