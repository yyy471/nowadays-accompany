import { z } from "zod";

/**
 * 首版只做文生图：MOSS-Image 是文生图模型，图生图需要锚点图上传与
 * 角色服饰关联，留给下一包（236 §6.3）。
 */
export const SCENE_IMAGE_MODEL_TYPES = ["text2img"] as const;
export type SceneImageModelType = (typeof SCENE_IMAGE_MODEL_TYPES)[number];

const promptSchema = z.string().trim().max(2000);

/** 草稿预览与正式保存共用的字段定义（无默认值，便于部分覆盖合并）。 */
export const sceneImageSettingsCandidateShape = {
  serviceId: z.string().trim().min(1).max(100),
  modelType: z.enum(SCENE_IMAGE_MODEL_TYPES),
  /** MOSS-Image 的本地模型目录，写入工作流加载节点的 model_path。 */
  modelPath: z.string().trim().min(1).max(2000),
  /** 角色基础锚点提示词：脸型、发型、发色、瞳色等跨场景特征。 */
  basePrompt: promptSchema,
  negativePrompt: promptSchema,
  /** 按服饰记录的锚点提示词，键为 outfitId。 */
  outfitPrompts: z.record(
    z.string().max(200),
    z.string().trim().max(1000),
  ),
  width: z.number().int().min(256).max(2048).multipleOf(16),
  height: z.number().int().min(256).max(2048).multipleOf(16),
  steps: z.number().int().min(1).max(150),
  cfg: z.number().min(0).max(30),
  sampler: z.string().trim().min(1).max(100),
  scheduler: z.string().trim().min(1).max(100),
  /** null 表示每次随机，便于同一句台词得到不同画面。 */
  seed: z.number().int().min(0).max(2_147_483_647).nullable(),
  /** 自定义工作流（ComfyUI API 格式）；null 用内置 MOSS-Image 模板。 */
  workflow: z.record(z.string(), z.unknown()).nullable(),
  /** 输出节点 id；null 时自动找 SaveImage。 */
  outputNodeId: z.string().trim().max(100).nullable(),
} as const;

export const SCENE_IMAGE_CANDIDATE_KEYS = [
  "serviceId",
  "modelType",
  "modelPath",
  "basePrompt",
  "negativePrompt",
  "outfitPrompts",
  "width",
  "height",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "seed",
  "workflow",
  "outputNodeId",
] as const;

export const sceneImageSettingsSchema = z
  .object({
    ...sceneImageSettingsCandidateShape,
    basePrompt: promptSchema.default(""),
    negativePrompt: promptSchema.default(""),
    outfitPrompts: sceneImageSettingsCandidateShape.outfitPrompts.default({}),
    width: sceneImageSettingsCandidateShape.width.default(1024),
    height: sceneImageSettingsCandidateShape.height.default(1024),
    steps: sceneImageSettingsCandidateShape.steps.default(25),
    cfg: sceneImageSettingsCandidateShape.cfg.default(2.5),
    sampler: sceneImageSettingsCandidateShape.sampler.default("er_sde"),
    scheduler: sceneImageSettingsCandidateShape.scheduler.default("simple"),
    seed: sceneImageSettingsCandidateShape.seed.default(null),
    workflow: sceneImageSettingsCandidateShape.workflow.default(null),
    outputNodeId: sceneImageSettingsCandidateShape.outputNodeId.default(null),
  })
  .strict();

export type SceneImageSettingsInput = z.infer<typeof sceneImageSettingsSchema>;

export interface SceneImageSettingsRecord extends SceneImageSettingsInput {
  roleId: string;
  updatedAt: string;
}

/** 角色生图配置的读视图：附带所绑定服务的展示信息，便于页面判断可用性。 */
export interface SceneImageSettingsView {
  settings: SceneImageSettingsRecord | null;
  service: {
    serviceId: string;
    name: string;
    enabled: boolean;
    baseUrl: string;
  } | null;
  configured: boolean;
}

export interface SceneImagePreviewResult {
  mediaType: string;
  width: number;
  height: number;
  byteSize: number;
  /** 测试样图只在配置流程里看，不写入过场图历史。 */
  dataBase64: string;
  prompt: string;
}

export type AnchorPromptTarget = "base" | "outfit";

export interface SceneImageAnchorPromptResult {
  target: AnchorPromptTarget;
  outfitId: string | null;
  prompt: string;
  source: {
    kind: "uploaded" | "outfit_asset";
    fileName: string;
    outfitId: string | null;
    outfitName: string | null;
  };
}
