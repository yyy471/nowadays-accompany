import { z } from "zod";
import { InvalidResourceConfigError } from "./errors.js";

export const resourceKindSchema = z.enum(["model", "mcp", "skill"]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

const credentialRefSchema = z
  .string()
  .regex(
    /^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/,
    "credentialRef 必须为 env:<NAME> 或 file:<PATH>",
  );

export const modelConfigSchema = z
  .object({
    protocol: z.enum([
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
    ]),
    baseUrl: z.string().min(1).max(2000),
    credentialRef: credentialRefSchema.optional(),
  })
  .strict();

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
