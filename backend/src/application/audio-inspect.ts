import type { InspectedAudio } from "../domain/voice.js";

/** 只按文件头识别参考音频格式，解码与时长校验由语音服务负责。 */
export function inspectAudio(data: Buffer): InspectedAudio | null {
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE") {
    return { mediaType: "audio/wav", extension: ".wav" };
  }
  if (data.length >= 4 && data.subarray(0, 4).toString("ascii") === "fLaC") {
    return { mediaType: "audio/flac", extension: ".flac" };
  }
  if (data.length >= 4 && data.subarray(0, 4).toString("ascii") === "OggS") {
    return { mediaType: "audio/ogg", extension: ".ogg" };
  }
  if (isMp3(data)) {
    return { mediaType: "audio/mpeg", extension: ".mp3" };
  }
  return null;
}

function isMp3(data: Buffer): boolean {
  if (data.length >= 3 && data.subarray(0, 3).toString("ascii") === "ID3") {
    return true;
  }
  return data.length >= 2 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0;
}

const PCM_FORMAT = 1;
const PCM_BITS = new Set([8, 16, 24, 32]);

/** 校验 PCM WAV 的容器边界、格式字段和完整音频帧。 */
export function isPcmWav(data: Buffer): boolean {
  if (
    data.length < 44 ||
    data.subarray(0, 4).toString("ascii") !== "RIFF" ||
    data.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    return false;
  }
  const riffSize = data.readUInt32LE(4);
  const riffEnd = riffSize + 8;
  if (riffSize < 36 || riffEnd !== data.length) {
    return false;
  }
  let offset = 12;
  let frameBytes = 0;
  let hasData = false;
  while (offset + 8 <= riffEnd) {
    const chunkId = data.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = data.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (payloadEnd > riffEnd) {
      return false;
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16 || frameBytes !== 0) {
        return false;
      }
      const format = data.readUInt16LE(payloadStart);
      const channels = data.readUInt16LE(payloadStart + 2);
      const sampleRate = data.readUInt32LE(payloadStart + 4);
      const byteRate = data.readUInt32LE(payloadStart + 8);
      const blockAlign = data.readUInt16LE(payloadStart + 12);
      const bits = data.readUInt16LE(payloadStart + 14);
      if (
        format !== PCM_FORMAT ||
        channels < 1 ||
        sampleRate < 1 ||
        !PCM_BITS.has(bits) ||
        blockAlign !== channels * (bits / 8) ||
        byteRate !== sampleRate * blockAlign
      ) {
        return false;
      }
      frameBytes = blockAlign;
    } else if (chunkId === "data") {
      if (frameBytes === 0 || chunkSize === 0 || chunkSize % frameBytes !== 0) {
        return false;
      }
      hasData = true;
    }
    offset = payloadEnd + (chunkSize % 2);
  }
  return offset === riffEnd && hasData;
}
