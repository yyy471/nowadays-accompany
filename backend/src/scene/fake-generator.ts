import { createHash } from "node:crypto";
import sharp from "sharp";
import { SceneImageCanceledError } from "../domain/errors.js";
import type {
  GeneratedSceneImage,
  SceneImageGenerationInput,
  SceneImageGeneratorPort,
  SceneImageLayerMode,
} from "../domain/scene-image.js";

interface SceneImageSize {
  width: number;
  height: number;
}

/** 纯背景图按舞台比例，整幅图按竖幅人物构图，便于桌面区分两种图层。 */
const DEFAULT_SIZES: Record<SceneImageLayerMode, SceneImageSize> = {
  background: { width: 1024, height: 576 },
  full_scene: { width: 832, height: 1216 },
};

/**
 * 本地假生成器：按提示词确定性生成可解码的渐变 PNG。
 * 整幅图模式会把服饰参考图合成进画面，用于验证参考素材确实到达生成端。
 * 不访问网络、不产生费用，用于在真实生图服务确定前验证任务与读取链路。
 */
export class FakeSceneImageGenerator implements SceneImageGeneratorPort {
  private readonly sizes: Record<SceneImageLayerMode, SceneImageSize>;

  constructor(sizes?: Partial<Record<SceneImageLayerMode, SceneImageSize>>) {
    this.sizes = {
      background: sizes?.background ?? DEFAULT_SIZES.background,
      full_scene: sizes?.full_scene ?? DEFAULT_SIZES.full_scene,
    };
  }

  async generate(input: SceneImageGenerationInput): Promise<GeneratedSceneImage> {
    if (isAborted(input.signal)) {
      throw new SceneImageCanceledError();
    }
    const { width, height } = this.sizes[input.layerMode];
    const base = await sharp(renderGradient(input, width, height), {
      raw: { width, height, channels: 3 },
    })
      // 假图只用于链路验证，低压缩等级换取更快的离线测试。
      .png({ compressionLevel: 1 })
      .toBuffer();
    const reference =
      input.layerMode === "full_scene" ? input.references?.[0] : undefined;
    const data =
      reference === undefined
        ? base
        : await compositeReference(base, reference.data, width, height);
    if (isAborted(input.signal)) {
      throw new SceneImageCanceledError();
    }
    return { data, mediaType: "image/png", width, height };
  }
}

/** 把参考图缩放到画面下部，模拟“人物加背景”的构图差异。 */
async function compositeReference(
  base: Buffer,
  reference: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const resized = await sharp(reference)
    .rotate()
    .resize({
      width: Math.max(1, Math.round(width * 0.6)),
      height: Math.max(1, Math.round(height * 0.78)),
      fit: "inside",
    })
    .png()
    .toBuffer();
  return sharp(base)
    .composite([{ input: resized, gravity: "south" }])
    .png({ compressionLevel: 1 })
    .toBuffer();
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function renderGradient(
  input: SceneImageGenerationInput,
  width: number,
  height: number,
): Buffer {
  const digest = createHash("sha256")
    .update(`${input.layerMode}\n${input.prompt}`)
    .digest();
  const top = [digest[0] ?? 40, digest[1] ?? 60, digest[2] ?? 90] as const;
  const bottom = [digest[3] ?? 160, digest[4] ?? 120, digest[5] ?? 90] as const;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const vertical = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      // 斜向渐变加一条柔和亮带，让假图有可辨认的空间层次。
      const diagonal = (x / Math.max(1, width - 1)) * 0.25;
      const factor = Math.min(1, vertical + diagonal);
      const band = Math.max(0, 1 - Math.abs(vertical - 0.45) * 6) * 18;
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const from = top[channel] ?? 0;
        const to = bottom[channel] ?? 0;
        raw[offset + channel] = Math.max(
          0,
          Math.min(255, Math.round(from + (to - from) * factor + band)),
        );
      }
    }
  }
  return raw;
}
