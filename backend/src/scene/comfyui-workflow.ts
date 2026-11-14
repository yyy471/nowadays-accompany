import { ImageWorkflowInvalidError } from "../domain/errors.js";

/**
 * ComfyUI 工作流（API 格式）与参数打补丁。
 *
 * ComfyUI 本身不规定模型：换模型换的是工作流里的加载节点和采样参数。
 * 因此这里不按节点 id 写死，而是按 class_type 定位——用户从 ComfyUI
 * 「Save (API Format)」导出的官方工作流节点 id 各不相同，也能直接用。
 */

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export type ComfyWorkflow = Record<string, ComfyNode>;

/** 加载节点的候选与对应的模型参数键，按优先级排列。 */
const LOADER_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ["MOSSImageHFLoader", "model_path"],
  ["MOSSImageUNETLoader", "unet_name"],
  ["CheckpointLoaderSimple", "ckpt_name"],
  ["UNETLoader", "unet_name"],
];

/**
 * ComfyUI 0.45+ 原生 MOSS-Image + Spectrum 文生图工作流：
 * UNET(INT8/FP8/BF16) + Qwen3.5 9B CLIP(type=moss_image) + Flux2 VAE，
 * 配 SpectrumMOSSImageManual 加速、SLG 负分支跳层 22 与 ER-SDE 25 步采样（1024×1024）。
 */
const MOSS_IMAGE_WORKFLOW: ComfyWorkflow = {
  "1": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "moss_image_sft_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "MOSS-Image UNET Loader" },
  },
  "2": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3.5_9b_w4a8_gptq.safetensors",
      type: "moss_image",
      device: "default",
    },
    _meta: { title: "MOSS-Image CLIP Loader" },
  },
  "3": {
    class_type: "VAELoader",
    inputs: {
      vae_name: "flux2-vae_small.safetensors",
    },
    _meta: { title: "MOSS-Image VAE Loader" },
  },
  "4": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["2", 0] },
    _meta: { title: "正向提示词" },
  },
  "5": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["2", 0] },
    _meta: { title: "负向提示词" },
  },
  "6": {
    class_type: "EmptyFlux2LatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "7": {
    class_type: "SpectrumMOSSImageManual",
    inputs: {
      model: ["1", 0],
      warmup_steps: 8,
      tail_actual_steps: 1,
      window_size: 2,
      flex_window: 0.75,
      max_consecutive_forecasts: 2,
      history_points: 8,
      chebyshev_degree: 4,
      ridge_lambda: 0.1,
      blend_weight: 0.5,
      cache_device: "main_device",
      force_actual_on_control: true,
      debug: false,
      warn_unverified_sampler: true,
    },
  },
  "8": {
    class_type: "SkipLayerGuidanceDiTSimple",
    inputs: {
      model: ["7", 0],
      double_layers: "",
      single_layers: "22",
      start_percent: 0,
      end_percent: 1,
    },
  },
  "9": {
    class_type: "KSampler",
    inputs: {
      model: ["8", 0],
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["6", 0],
      seed: 42,
      steps: 25,
      cfg: 2.5,
      sampler_name: "er_sde",
      scheduler: "simple",
      denoise: 1,
    },
  },
  "10": {
    class_type: "VAEDecode",
    inputs: { samples: ["9", 0], vae: ["3", 0] },
  },
  "11": {
    class_type: "SaveImage",
    inputs: { images: ["10", 0], filename_prefix: "nowadays" },
  },
};

export function defaultComfyWorkflow(): ComfyWorkflow {
  return cloneWorkflow(MOSS_IMAGE_WORKFLOW);
}

/** 校验工作流形状：至少一个节点，每个节点有 class_type 与 inputs。 */
export function parseComfyWorkflow(value: unknown): ComfyWorkflow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("工作流必须是节点 id 到节点定义的映射");
  }
  const workflow: ComfyWorkflow = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`节点 ${id} 的定义不是对象`);
    }
    const node = raw as { class_type?: unknown; inputs?: unknown };
    if (typeof node.class_type !== "string" || node.class_type.length === 0) {
      throw new Error(`节点 ${id} 缺少 class_type`);
    }
    if (
      node.inputs === null ||
      typeof node.inputs !== "object" ||
      Array.isArray(node.inputs)
    ) {
      throw new Error(`节点 ${id} 缺少 inputs`);
    }
    const meta = (raw as { _meta?: Record<string, unknown> })._meta;
    workflow[id] = {
      class_type: node.class_type,
      inputs: { ...(node.inputs as Record<string, unknown>) },
      ...(meta === undefined ? {} : { _meta: meta }),
    };
  }
  if (Object.keys(workflow).length === 0) {
    throw new Error("工作流没有任何节点");
  }
  return workflow;
}

/** 校验自定义工作流并在指定输出节点时确认节点存在。 */
export function validateComfyWorkflow(
  value: Record<string, unknown>,
  outputNodeId: string | null = null,
): ComfyWorkflow {
  let workflow: ComfyWorkflow;
  try {
    workflow = parseComfyWorkflow(value);
  } catch (error) {
    throw new ImageWorkflowInvalidError(
      error instanceof Error ? error.message : "工作流结构不正确",
    );
  }
  if (outputNodeId !== null && workflow[outputNodeId] === undefined) {
    throw new ImageWorkflowInvalidError("输出节点不在工作流里", {
      outputNodeId,
    });
  }
  return workflow;
}

export function requiredNodeTypes(workflow: ComfyWorkflow): string[] {
  return [...new Set(Object.values(workflow).map((node) => node.class_type))].sort();
}

export interface SceneImageWorkflowParams {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  /** MOSS-Image 的本地模型目录，写入加载节点的模型参数。 */
  modelPath: string;
}

export interface PatchedWorkflow {
  workflow: ComfyWorkflow;
  /** 输出节点 id；找不到 SaveImage 时为 null。 */
  outputNodeId: string | null;
}

/**
 * 把本次生成的参数写进工作流。只改存在的键，不新增未知键，
 * 避免把模型不需要的参数塞给 ComfyUI 导致校验失败。
 */
export function applyWorkflowParams(
  source: ComfyWorkflow,
  params: SceneImageWorkflowParams,
  outputNodeId: string | null = null,
): PatchedWorkflow {
  const workflow = cloneWorkflow(source);
  const nodes = Object.entries(workflow);

  const loader = LOADER_INPUTS.map(([type, key]) => ({
    node: nodes.find(([, node]) => node.class_type === type),
    key,
  })).find((candidate) => candidate.node !== undefined);
  if (loader?.node !== undefined) {
    setInput(loader.node[1], loader.key, params.modelPath);
  }

  const sampler = nodes.find(
    ([, node]) =>
      node.class_type === "KSampler" || node.class_type === "KSamplerAdvanced",
  );
  if (sampler !== undefined) {
    const [, node] = sampler;
    // KSamplerAdvanced 用 noise_seed；两个键都试，只改存在的那个。
    setInput(node, "seed", params.seed);
    setInput(node, "noise_seed", params.seed);
    setInput(node, "steps", params.steps);
    setInput(node, "cfg", params.cfg);
    setInput(node, "sampler_name", params.sampler);
    setInput(node, "scheduler", params.scheduler);
    setTextOfLink(workflow, node.inputs.positive, params.prompt);
    setTextOfLink(workflow, node.inputs.negative, params.negativePrompt);
  }

  const latent = nodes.find(
    ([, node]) =>
      node.class_type.startsWith("Empty") &&
      "width" in node.inputs &&
      "height" in node.inputs,
  );
  if (latent !== undefined) {
    setInput(latent[1], "width", params.width);
    setInput(latent[1], "height", params.height);
    setInput(latent[1], "batch_size", 1);
  }

  const output =
    outputNodeId ??
    nodes.find(([, node]) => node.class_type === "SaveImage")?.[0] ??
    null;
  return { workflow, outputNodeId: output };
}

/** 沿 [节点 id, 输出序号] 找到文本编码节点并写入提示词。 */
function setTextOfLink(
  workflow: ComfyWorkflow,
  link: unknown,
  text: string,
): void {
  if (!Array.isArray(link) || link.length === 0) {
    return;
  }
  const target = workflow[String(link[0])];
  if (target === undefined) {
    return;
  }
  setInput(target, "text", text);
}

function setInput(node: ComfyNode, key: string, value: unknown): void {
  if (key in node.inputs) {
    node.inputs[key] = value;
  }
}

function cloneWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
}
