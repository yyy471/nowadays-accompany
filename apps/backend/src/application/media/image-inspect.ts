import { AppError } from "../../domain/errors.js";
import type { InspectedImage } from "../../domain/appearance.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface SupportedImageFormat {
  format: "png" | "jpeg" | "webp";
  mediaType: string;
  extension: string;
}

/** 同步识别受支持图片文件头（PNG / JPEG / WebP），供预置素材目录扫描使用。 */
export function detectImageFormat(data: Buffer): SupportedImageFormat | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { format: "png", mediaType: "image/png", extension: ".png" };
  }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
    return { format: "jpeg", mediaType: "image/jpeg", extension: ".jpg" };
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { format: "webp", mediaType: "image/webp", extension: ".webp" };
  }
  return null;
}

function detectFormat(data: Buffer): SupportedImageFormat | null {
  return detectImageFormat(data);
}

/**
 * 只校验格式受支持且像素可完整解码，不检查图片内容、透明通道或分辨率是否适合角色。
 */
export async function inspectImage(
  data: Buffer,
  fileName: string,
): Promise<InspectedImage> {
  const supported = detectFormat(data);
  if (supported === null) {
    throw new AppError(400, "IMAGE_FORMAT_UNSUPPORTED", "图片格式不受支持", {
      fileName,
    });
  }
  try {
    // sharp / libvips 原生库仅在真正解码图片时按需加载，避免拖慢后端冷启动（410 R2-12）。
    const { default: sharp } = await import("sharp");
    // animated 让多帧 WebP 解码全部帧，避免只验证首帧。
    const options = { failOn: "error" as const, animated: true };
    const image = sharp(data, options);
    const metadata = await image.metadata();
    // 多帧图片的 height 是全部帧的总高度，单帧画布高度在 pageHeight。
    const height = metadata.pageHeight ?? metadata.height;
    if (
      metadata.format !== supported.format ||
      !isValidDimension(metadata.width) ||
      !isValidDimension(height)
    ) {
      throw new Error("IMAGE_METADATA_INVALID");
    }
    // metadata() 只读文件头，再由 libvips 完整解码像素以确认文件确实可读。
    await sharp(data, options).stats();
    return {
      mediaType: supported.mediaType,
      extension: supported.extension,
      width: metadata.width,
      height,
    };
  } catch {
    throw new AppError(400, "IMAGE_DECODE_FAILED", "图片无法解码", {
      fileName,
    });
  }
}

function isValidDimension(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}
