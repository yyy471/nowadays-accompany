import { z } from "zod";
import {
  diaryCreateSchema,
  eventCorrectionSchema,
  memorySearchRequestSchema,
  summaryCorrectionSchema,
} from "../domain/memory.js";
import {
  modelServiceConfigSchema,
  modelServiceTestSchema,
} from "../domain/model.js";
import { resourceKindSchema } from "../domain/resource.js";

const recordSchema = z.record(z.string(), z.unknown());

const definitionSchema = z
  .object({
    text: z.string().min(1).max(200_000),
    payload: recordSchema.optional(),
  })
  .strict();

export const createRoleSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    definition: definitionSchema,
    state: recordSchema.optional(),
  })
  .strict();

export const updateDefinitionSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    definition: definitionSchema.optional(),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.displayName !== undefined || value.definition !== undefined,
    { message: "displayName 或 definition 至少提供一项" },
  );

export const putStateSchema = z
  .object({
    state: recordSchema,
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

export const createWindowSchema = z
  .object({
    kind: z.literal("custom").optional(),
    source: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const submitMessageSchema = z
  .object({
    content: z.string().min(1).max(200_000),
    submissionId: z.string().min(1).max(128),
    source: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const createResourceSchema = z
  .object({
    kind: resourceKindSchema,
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean().optional(),
    config: recordSchema,
  })
  .strict();

export const updateResourceSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    config: recordSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.enabled !== undefined ||
      value.config !== undefined,
    { message: "name、enabled 或 config 至少提供一项" },
  );

const bindingSchema = z
  .object({
    capability: z.enum(["chat_model", "memory_model", "mcp", "skill"]),
    resourceId: z.uuid(),
    modelName: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const putBindingsSchema = z
  .object({
    bindings: z.array(bindingSchema).max(1000),
  })
  .strict();

export const inputStateBodySchema = z
  .object({
    clientId: z.string().trim().min(1).max(128).optional(),
    typing: z.boolean(),
  })
  .strict();

export const sceneImageRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(128),
    layerMode: z.enum(["background", "full_scene"]).optional(),
  })
  .strict();

export const taskFinishBodySchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    endReason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const autonomyBudgetBodySchema = z
  .object({
    dailyLimit: z.number().int().min(1).max(1_000_000).optional(),
    unlimited: z.boolean(),
  })
  .strict();

export const autonomyWakeBodySchema = z
  .object({
    wakeAt: z.string().trim().min(1).max(64),
    intent: z.string().trim().min(1).max(2000),
  })
  .strict();

export const memorySearchBodySchema = memorySearchRequestSchema;
export const eventCorrectionBodySchema = eventCorrectionSchema;
export const summaryCorrectionBodySchema = summaryCorrectionSchema;
export const diaryCreateBodySchema = diaryCreateSchema;
export const modelServiceConfigBodySchema = modelServiceConfigSchema;
export const modelServiceTestBodySchema = modelServiceTestSchema;

export type CreateRoleBody = z.infer<typeof createRoleSchema>;
export type UpdateDefinitionBody = z.infer<typeof updateDefinitionSchema>;
export type PutStateBody = z.infer<typeof putStateSchema>;
export type CreateWindowBody = z.infer<typeof createWindowSchema>;
export type SubmitMessageBody = z.infer<typeof submitMessageSchema>;
export type CreateResourceBody = z.infer<typeof createResourceSchema>;
export type UpdateResourceBody = z.infer<typeof updateResourceSchema>;
export type PutBindingsBody = z.infer<typeof putBindingsSchema>;
export type MemorySearchBody = z.infer<typeof memorySearchBodySchema>;
export type EventCorrectionBody = z.infer<typeof eventCorrectionBodySchema>;
export type SummaryCorrectionBody = z.infer<typeof summaryCorrectionBodySchema>;
export type DiaryCreateBody = z.infer<typeof diaryCreateBodySchema>;
export type ModelServiceConfigBody = z.infer<typeof modelServiceConfigBodySchema>;
export type ModelServiceTestBody = z.infer<typeof modelServiceTestBodySchema>;
export type InputStateBody = z.infer<typeof inputStateBodySchema>;
export type SceneImageRequestBody = z.infer<typeof sceneImageRequestSchema>;
export type TaskFinishBody = z.infer<typeof taskFinishBodySchema>;
export type AutonomyBudgetBody = z.infer<typeof autonomyBudgetBodySchema>;
export type AutonomyWakeBody = z.infer<typeof autonomyWakeBodySchema>;
