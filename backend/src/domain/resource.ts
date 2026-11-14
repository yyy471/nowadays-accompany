import { z } from "zod";
import { InvalidResourceConfigError } from "./errors.js";

export const resourceKindSchema = z.enum(["model", "mcp", "skill"]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

export const modelProtocolSchema = z.enum([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-gemini",
]);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;

export const credentialRefSchema = z
  .string()
  .regex(
    /^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/,
    "credentialRef 必须为 env:<NAME> 或 file:<PATH>",
  );

/**
 * 模型服务地址只允许 http/https，且不能把账号、查询串或片段混进基础路径。
 * 统一去掉末尾斜杠，避免同一服务因写法不同被当成两套配置。
 */
export const modelBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .transform((value) => value.replace(/\/+$/, ""))
  .refine(isModelBaseUrl, {
    message: "baseUrl 必须是 http/https 地址，且不能包含账号、查询串或片段",
  });

export function isModelBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  if (url.search !== "" || url.hash !== "") {
    return false;
  }
  return url.hostname.length > 0;
}

export const modelBaseConfigSchema = z
  .object({
    protocol: modelProtocolSchema,
    baseUrl: modelBaseUrlSchema,
    /** 默认模型名称（选填，供设置界面回显与角色默认预填）。 */
    modelName: z.string().trim().min(1).max(200).optional(),
    credentialRef: credentialRefSchema.optional(),
    /** 可核实的模型容量声明（字符口径），供记忆整理按容量分批。 */
    maxInputChars: z.number().int().positive().max(10_000_000).optional(),
    maxOutputChars: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

export const modelConfigSchema = modelBaseConfigSchema;

export const mcpConfigSchema = z
  .object({
    command: z.string().min(1).max(2000),
    args: z.array(z.string().max(2000)).max(200),
    env: z.record(z.string(), z.string()),
  })
  .strict();

export const skillConfigSchema = z
  .object({
    sourcePath: z.string().min(1).max(2000),
  })
  .strict();

const configSchemas = {
  model: modelConfigSchema,
  mcp: mcpConfigSchema,
  skill: skillConfigSchema,
} satisfies Record<ResourceKind, z.ZodType>;

export type ResourceConfig = Record<string, unknown>;

export function parseResourceConfig(
  kind: ResourceKind,
  config: unknown,
): ResourceConfig {
  const result = configSchemas[kind].safeParse(config);
  if (!result.success) {
    throw new InvalidResourceConfigError(
      kind,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }
  return result.data as ResourceConfig;
}
