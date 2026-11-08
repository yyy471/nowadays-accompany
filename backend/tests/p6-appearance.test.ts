import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectImage } from "../src/application/image-inspect.js";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { rolePaths } from "../src/bootstrap/config.js";
import type { OutfitRecord } from "../src/domain/appearance.js";
import { AppError } from "../src/domain/errors.js";
import { createFixtureWithModel, ScriptedChatModel } from "./p2-05-fixture.js";

// 以下样本由 Pillow 12.3.0 实际编码，均可完整解码：48×64 像素。
const PNG_SAMPLE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADAAAABACAYAAABcIPRGAAAA4UlEQVR4nO2ZQQoDIRAEKzj77s3+PAQSCIvgwcN0oA6e+tIzatnqA3gejPNgMBlXulbUOGEwGRfka0X1m2BDmxUQZZCFdi8gziAL7beASIMstG8BsQZZaO8C2k2woYlRmmelxCi9+6HEKGIUMUroIYUYJbfziFEyZqVMo/Tuh/JSTy+Jyks9XuoRo4TFA8QoGd1FjJLbeW5RItYgC800ihgdW0vKt1GaN3P5NooYZWdJ+cVE88lcfjEhRjGNEhyXEaNkdh4xSsaslGkU0yhilAAcIkbJ6y5ilNzO8xl//zb6Ag0c3fBDUUZoAAAAAElFTkSuQmCC",
  "base64",
);
const JPEG_SAMPLE = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAQDAwMDAgQDAwMEBAQFBgoGBgUFBgwICQcKDgwPDg4MDQ0PERYTDxAVEQ0NExoTFRcYGRkZDxIbHRsYHRYYGRj/2wBDAQQEBAYFBgsGBgsYEA0QGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBj/wAARCABAADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4ftNP6fLW7aaf0+Wr1pp/T5a3bTT+ny12UYmuVZjtqUbTT+ny1vWmn9Plq9aaf0+Wt200/p8terRifpGVZjtqUbTT+ny1vWmn9Plq7aaf0+Wt600/p8tetRifpGVZltqeL2mn9PlrdtNP6fLV600/p8tbtpp/T5a+aoxP4yyrMdtSlaaf0+Wt200/p8tXrTT+ny1u2mn9Plr1aMT9IyrMttSjaaf0+Wt600/p8tXbTT+ny1vWmn9Plr1aMT9IyrMttTxe00/p8tbtpp/T5avWmn9PlrdtNP6fLXzdGJ/GOVZjtqUrTT+ny1u2mn9Plq9aaf0+Wt200/p8terRifpGVZltqUbTT+ny1u2tgqpubAUDJJ4Aq9bWCqm5sBQMkngCq1zI14/kwgiAH8X9z7e3+R4/FPFuE4awntq3vVJfBDrJ/pFdX+baR+oZHipVpJJ6Hn1pp/T5a3bTT+ny1etNP6fLW7aaf0+WuijE/irKsx21KVpp/T5a3LawVV3NhVAySeAKvWtgqrubCqBkk9qrXMjXjeTCCIAfxf3Pt7f5Hj8U8W4ThrCe2re9Ul8EOsn+iXV/m2kfp+R4qVaSSehRuZGvH8mEEQA/Qv7n29v8i3aaf0+Wrtpp/T5a3rTT+ny1/K2aZxi85xcsbjZc05fcl0SXRL/gu7bZ+0ZNjY04qMT/2Q==",
  "base64",
);
const JPEG_PROGRESSIVE_SAMPLE = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wgARCABAADADASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAwQGBQf/xAAZAQADAQEBAAAAAAAAAAAAAAAEBQcCBgP/2gAMAwEAAhADEAAAAfJbFs9dFW1ZD0rFsJeZWxqwJaVi2EPRsasl7lrFsAlo2NWS9KtjFf8AFsavcqKtjG6AkWyd9T//xAAWEAEBAQAAAAAAAAAAAAAAAAACACL/2gAIAQEAAQUCIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiImIiIiIiZaiIiIiZaiIiIiZaiIi//EABkRAAMBAQEAAAAAAAAAAAAAAAADBAECEf/aAAgBAwEBPwGd5O8neTvJ3k7yd5O8kZvWk7yRm9aStzM8w//EAB0RAAICAgMBAAAAAAAAAAAAAAACAwQBBRIxQSH/2gAIAQIBAT8BUUUUUUUU2GyjoR8m78wKbDZR0I+Td+YLFmS1JmWXP0//xAAZEAACAwEAAAAAAAAAAAAAAAABERAgMVD/2gAIAQEABj8C4aGVQyqGT//EABoQAAIDAQEAAAAAAAAAAAAAAAERACDxEED/2gAIAQEAAT8h9tVVVVVVVVVLDNapIZhNppUkMwm00qWGYTae1//aAAwDAQACAAMAAAAQoWt1L0K0X3UL/8QAFxEAAwEAAAAAAAAAAAAAAAAAAAExIf/aAAgBAwEBPxCGkNIaQJECBLRSSZLRSSYlB//EAB0RAQEAAgMAAwAAAAAAAAAAAAEAQcERMXEhkfD/2gAIAQIBAT8QMYxjGMbu+/RdBl3wRu779F0GXfBcvBfQYAwH75v/xAAdEAADAQEAAwEBAAAAAAAAAAAAASExEUGB8HHh/9oACAEBAAE/EMoZQyhlDKGUMoZQyhlDKGUMoZQyhlDKGUMoZQyhlDKGUMoZQyhlDKCYCSXW34MoZQyhlBcBJLrbxD+W0j9/wZQyhlBcBJLrb8D+W0nz0ZQyhlBMBJLrb8D+W0j+fhlDKH//2Q==",
  "base64",
);
const WEBP_LOSSY_SAMPLE = Buffer.from(
  "UklGRjABAABXRUJQVlA4ICQBAACwCgCdASowAEAAPm0ylEakIyIjKBqscIANiWoAqo+TRoaAOe2J/6Ub+qvWABdfNH2AQCMFEQzhKBzNWhBvX9rkNCEhcXl5dr3Bivut5h91dXU2Sz9W4TL5HZtwIfmgAP7/oNo5QHcfbFJtyTo8bz4TXbcoDzBRmKNC8EiDW4mfSSiMevVGY+2Z6URnsBMQERtQOsguVvmp4IZnNKHx7hVNca51wsZRZowAha2ronwGMqeXorf8OwCQXCoTwWotFDDPlIj3aiYsmJIIiqnSsj/Ov3+XBU614CtUN3Zp5sc6aq9yn3rNxFcfM5BPOKZTr1cdw+eb8e/f5cFTrXjoI8ymVI/UCJ1zGz2SOIr4AEcfZ9nKl1dyZ5S91zycuvKe+a8ZIwAA",
  "base64",
);
const WEBP_LOSSLESS_SAMPLE = Buffer.from(
  "UklGRjgAAABXRUJQVlA4TCsAAAAvL8APALkKRPQ/dhHR/4CCtA2Y7vgXPgFDQdoGLGx3FAIIgIImEuCvy3ceAA==",
  "base64",
);

// 保留合法签名、IHDR 与 IEND，移除全部 IDAT；文件结构完整但没有像素数据。
const PNG_WITHOUT_PIXELS = Buffer.concat([
  PNG_SAMPLE.subarray(0, 33),
  PNG_SAMPLE.subarray(PNG_SAMPLE.length - 12),
]);

// 复核反例：PNG 行过滤类型为 5，WebP 只有合法 VP8L 头而码流不可解码。
const BAD_FILTER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNlYGAAAAAYAAY32LKtAAAAAElFTkSuQmCC",
  "base64",
);
const BAD_STREAM_WEBP = Buffer.from(
  "UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAA=",
  "base64",
);
// 复核追加反例：两帧动画 WebP，损坏版仅第二帧码流无效。
const ANIMATED_WEBP = Buffer.from(
  "UklGRogAAABXRUJQVlA4WAoAAAACAAAALwAAPwAAQU5JTQYAAAAAAAAAAABBTk1GKgAAAAAAAAAAAC8AAD8AAH0AAAJWUDhMEQAAAC8vwA8AB1C94lS5/4GI6H8AAEFOTUYqAAAAAAAAAAAALwAAPwAAfQAAAFZQOEwRAAAALy/ADwAHUL12d6b/gYjofwAA",
  "base64",
);
const BAD_LATER_FRAME_WEBP = Buffer.from(
  "UklGRogAAABXRUJQVlA4WAoAAAACAAAALwAAPwAAQU5JTQYAAAAAAAAAAABBTk1GKgAAAAAAAAAAAC8AAD8AAH0AAAJWUDhMEQAAAC8vwA8AB1C94lS5/4GI6H8AAEFOTUYqAAAAAAAAAAAALwAAPwAAfQAAAFZQOEwRAAAALy/ADwAAAAAAAAAAAAAAAAAA",
  "base64",
);

const JPEG_HEADER_ONLY = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10,
  0x4a, 0x46, 0x49, 0x46, 0x00,
  0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11,
  0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);

function corruptPng(): Buffer {
  const data = Buffer.from(PNG_SAMPLE);
  data[60] = (data[60] ?? 0) ^ 0xff;
  return data;
}

interface FilePart {
  fileName: string;
  data: Buffer;
  mediaType: string;
}

async function uploadOutfit(
  baseUrl: string,
  roleId: string,
  input: {
    name: string;
    description?: string;
    home?: FilePart | null;
    sprites?: FilePart[];
  },
): Promise<Response> {
  const form = new FormData();
  form.append("name", input.name);
  if (input.description !== undefined) {
    form.append("description", input.description);
  }
  if (input.home) {
    form.append(
      "home",
      new Blob([input.home.data], { type: input.home.mediaType }),
      input.home.fileName,
    );
  }
  for (const sprite of input.sprites ?? []) {
    form.append(
      "sprites",
      new Blob([sprite.data], { type: sprite.mediaType }),
      sprite.fileName,
    );
  }
  return fetch(`${baseUrl}/v1/roles/${roleId}/appearance/outfits`, {
    method: "POST",
    body: form,
  });
}

async function uploadSprite(
  baseUrl: string,
  roleId: string,
  outfitId: string,
  file: FilePart,
): Promise<Response> {
  const form = new FormData();
  form.append(
    "sprite",
    new Blob([file.data], { type: file.mediaType }),
    file.fileName,
  );
  return fetch(
    `${baseUrl}/v1/roles/${roleId}/appearance/outfits/${outfitId}/sprites`,
    { method: "POST", body: form },
  );
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

test("image inspector decodes real samples and rejects undecodable pixel data", async () => {
  const expected = { width: 48, height: 64 };
  assert.deepEqual(await inspectImage(PNG_SAMPLE, "sample.png"), {
    mediaType: "image/png",
    extension: ".png",
    ...expected,
  });
  assert.deepEqual(await inspectImage(JPEG_SAMPLE, "sample.jpg"), {
    mediaType: "image/jpeg",
    extension: ".jpg",
    ...expected,
  });
  assert.deepEqual(await inspectImage(JPEG_PROGRESSIVE_SAMPLE, "sample-progressive.jpg"), {
    mediaType: "image/jpeg",
    extension: ".jpg",
    ...expected,
  });
  assert.deepEqual(await inspectImage(WEBP_LOSSY_SAMPLE, "sample.webp"), {
    mediaType: "image/webp",
    extension: ".webp",
    ...expected,
  });
  assert.deepEqual(await inspectImage(WEBP_LOSSLESS_SAMPLE, "sample-lossless.webp"), {
    mediaType: "image/webp",
    extension: ".webp",
    ...expected,
  });
  assert.deepEqual(await inspectImage(ANIMATED_WEBP, "animated.webp"), {
    mediaType: "image/webp",
    extension: ".webp",
    ...expected,
  });
  for (const [fileName, data] of [
    ["stripped.png", PNG_WITHOUT_PIXELS],
    ["damaged.png", corruptPng()],
    ["header-only.jpg", JPEG_HEADER_ONLY],
    ["bad-filter.png", BAD_FILTER_PNG],
    ["bad-stream.webp", BAD_STREAM_WEBP],
    ["bad-later-frame.webp", BAD_LATER_FRAME_WEBP],
  ] as const) {
    await assert.rejects(
      () => inspectImage(data, fileName),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "IMAGE_DECODE_FAILED" &&
        (error.details as { fileName?: string }).fileName === fileName,
      fileName,
    );
  }
});

test("appearance import stores outfits and reads images back", { timeout: 60_000 }, async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;

    const first = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "黑白长裙",
      description: "日常外出",
      home: {
        fileName: "home.png",
        data: PNG_SAMPLE,
        mediaType: "image/png",
      },
      sprites: [
        { fileName: "微笑.png", data: PNG_SAMPLE, mediaType: "image/png" },
        { fileName: "握手.webp", data: WEBP_LOSSY_SAMPLE, mediaType: "image/webp" },
        { fileName: "a.png", data: PNG_SAMPLE, mediaType: "image/png" },
        { fileName: "倾听.jpg", data: JPEG_SAMPLE, mediaType: "image/jpeg" },
        { fileName: "静默.webp", data: WEBP_LOSSLESS_SAMPLE, mediaType: "image/webp" },
      ],
    });
    assert.equal(first.status, 201);
    const dress = (await first.json()) as OutfitRecord;
    assert.equal(dress.name, "黑白长裙");
    assert.equal(dress.description, "日常外出");
    assert.equal(dress.home?.displayName, "home");
    assert.equal(dress.home?.mediaType, "image/png");
    assert.deepEqual(
      dress.sprites.map((sprite) => sprite.displayName),
      ["微笑", "握手", "a", "倾听", "静默"],
    );
    assert.deepEqual(
      dress.sprites.map((sprite) => sprite.mediaType),
      ["image/png", "image/webp", "image/png", "image/jpeg", "image/webp"],
    );

    const second = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "白色针织裙",
      home: {
        fileName: "home.webp",
        data: WEBP_LOSSY_SAMPLE,
        mediaType: "image/webp",
      },
      sprites: [
        { fileName: "微笑.png", data: PNG_SAMPLE, mediaType: "image/png" },
      ],
    });
    assert.equal(second.status, 201);
    const knit = (await second.json()) as OutfitRecord;

    const list = await fetch(
      `${baseUrl}/v1/roles/${fixture.roleId}/appearance/outfits`,
    );
    assert.equal(list.status, 200);
    const listed = (await list.json()) as { items: OutfitRecord[] };
    assert.deepEqual(
      listed.items.map((item) => item.name),
      ["黑白长裙", "白色针织裙"],
    );

    const asset = await fetch(
      `${baseUrl}/v1/roles/${fixture.roleId}/appearance/assets/${dress.home!.assetId}`,
    );
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), PNG_SAMPLE);

    const jpegSprite = await fetch(
      `${baseUrl}/v1/roles/${fixture.roleId}/appearance/assets/${dress.sprites[3]!.assetId}`,
    );
    assert.equal(jpegSprite.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await jpegSprite.arrayBuffer()), JPEG_SAMPLE);
    const losslessSprite = await fetch(
      `${baseUrl}/v1/roles/${fixture.roleId}/appearance/assets/${dress.sprites[4]!.assetId}`,
    );
    assert.equal(losslessSprite.headers.get("content-type"), "image/webp");
    assert.deepEqual(
      Buffer.from(await losslessSprite.arrayBuffer()),
      WEBP_LOSSLESS_SAMPLE,
    );

    const outfitFiles = fs.readdirSync(
      rolePaths(fixture.app.config.dataRoot, fixture.roleId).appearanceDir,
    );
    assert.equal(outfitFiles.length, 8);

    // 同一服饰可以登记同名差分，内部 ID 分开。
    const sameName = await uploadSprite(baseUrl, fixture.roleId, dress.outfitId, {
      fileName: "微笑.webp",
      data: WEBP_LOSSY_SAMPLE,
      mediaType: "image/webp",
    });
    assert.equal(sameName.status, 201);
    const extra = (await sameName.json()) as {
      assetId: string;
      displayName: string;
    };
    assert.equal(extra.displayName, "微笑");
    assert.notEqual(extra.assetId, dress.sprites[0]!.assetId);
    const jpegOnly = await uploadSprite(
      baseUrl,
      fixture.roleId,
      dress.outfitId,
      { fileName: "侧身.jpg", data: JPEG_SAMPLE, mediaType: "image/jpeg" },
    );
    assert.equal(jpegOnly.status, 201);
    const jpegOnlyBody = (await jpegOnly.json()) as {
      mediaType: string;
      displayName: string;
    };
    assert.equal(jpegOnlyBody.mediaType, "image/jpeg");
    assert.equal(jpegOnlyBody.displayName, "侧身");

    // 单张补图入口同样拒绝实际无法解码的坏图。
    for (const [fileName, data, mediaType] of [
      ["bad-filter.png", BAD_FILTER_PNG, "image/png"],
      ["bad-stream.webp", BAD_STREAM_WEBP, "image/webp"],
    ] as const) {
      const rejected = await uploadSprite(
        baseUrl,
        fixture.roleId,
        dress.outfitId,
        { fileName, data, mediaType },
      );
      assert.equal(rejected.status, 400);
      const body = (await rejected.json()) as {
        error?: { code?: string; details?: { fileName?: string } };
      };
      assert.equal(body.error?.code, "IMAGE_DECODE_FAILED");
      assert.equal(body.error?.details?.fileName, fileName);
    }

    // 另一角色不能读取本角色的素材 ID。
    const other = fixture.app.services.roles.createRole({
      displayName: "另一个角色",
      definition: { text: "测试角色" },
      state: {},
    });
    const foreign = await fetch(
      `${baseUrl}/v1/roles/${other.roleId}/appearance/assets/${dress.home!.assetId}`,
    );
    assert.equal(foreign.status, 404);
    assert.equal(await errorCode(foreign), "ASSET_NOT_FOUND");

    // 不同角色可以使用相同服饰名。
    const otherImport = await uploadOutfit(baseUrl, other.roleId, {
      name: "黑白长裙",
      home: {
        fileName: "home.png",
        data: PNG_SAMPLE,
        mediaType: "image/png",
      },
    });
    assert.equal(otherImport.status, 201);

    // 同一角色重名服饰被拒绝，含首尾空白比较。
    const duplicate = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "  黑白长裙 ",
    });
    assert.equal(duplicate.status, 409);
    assert.equal(await errorCode(duplicate), "OUTFIT_ALREADY_EXISTS");

    // 单张补图到不存在的服饰。
    const missingOutfit = await uploadSprite(
      baseUrl,
      fixture.roleId,
      "00000000-0000-4000-8000-000000000000",
      { fileName: "微笑.png", data: PNG_SAMPLE, mediaType: "image/png" },
    );
    assert.equal(missingOutfit.status, 404);
    assert.equal(await errorCode(missingOutfit), "OUTFIT_NOT_FOUND");

    assert.equal(knit.sprites[0]?.displayName, "微笑");
  } finally {
    await fixture.close();
  }
});

test("animated WebP validates every frame in both import entries", { timeout: 60_000 }, async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;

    const created = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "动画裙",
      home: {
        fileName: "animated.webp",
        data: ANIMATED_WEBP,
        mediaType: "image/webp",
      },
      sprites: [
        {
          fileName: "动画差分.webp",
          data: ANIMATED_WEBP,
          mediaType: "image/webp",
        },
      ],
    });
    assert.equal(created.status, 201);
    const outfit = (await created.json()) as OutfitRecord;

    const brokenHome = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "坏动画裙",
      home: {
        fileName: "bad-later-frame.webp",
        data: BAD_LATER_FRAME_WEBP,
        mediaType: "image/webp",
      },
    });
    assert.equal(brokenHome.status, 400);
    const brokenHomeBody = (await brokenHome.json()) as {
      error?: { code?: string; details?: { fileName?: string } };
    };
    assert.equal(brokenHomeBody.error?.code, "IMAGE_DECODE_FAILED");
    assert.equal(
      brokenHomeBody.error?.details?.fileName,
      "bad-later-frame.webp",
    );

    const brokenSprite = await uploadSprite(
      baseUrl,
      fixture.roleId,
      outfit.outfitId,
      {
        fileName: "bad-later-frame.webp",
        data: BAD_LATER_FRAME_WEBP,
        mediaType: "image/webp",
      },
    );
    assert.equal(brokenSprite.status, 400);
    const brokenSpriteBody = (await brokenSprite.json()) as {
      error?: { code?: string; details?: { fileName?: string } };
    };
    assert.equal(brokenSpriteBody.error?.code, "IMAGE_DECODE_FAILED");
    assert.equal(
      brokenSpriteBody.error?.details?.fileName,
      "bad-later-frame.webp",
    );

    const list = await fetch(
      `${baseUrl}/v1/roles/${fixture.roleId}/appearance/outfits`,
    );
    const listed = (await list.json()) as { items: OutfitRecord[] };
    assert.deepEqual(listed.items.map((item) => item.name), ["动画裙"]);
    const files = fs.readdirSync(
      rolePaths(fixture.app.config.dataRoot, fixture.roleId).appearanceDir,
    );
    assert.equal(files.length, 2);
  } finally {
    await fixture.close();
  }
});

test("appearance import rejects unsupported or undecodable images and multiple homes", { timeout: 60_000 }, async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;

    const unsupported = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "文本裙子",
      home: {
        fileName: "note.png",
        data: Buffer.from("not an image", "utf8"),
        mediaType: "image/png",
      },
    });
    assert.equal(unsupported.status, 400);
    const unsupportedBody = (await unsupported.json()) as {
      error?: { code?: string; details?: { fileName?: string } };
    };
    assert.equal(unsupportedBody.error?.code, "IMAGE_FORMAT_UNSUPPORTED");
    assert.equal(unsupportedBody.error?.details?.fileName, "note.png");

    const corrupt = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "坏图裙子",
      home: {
        fileName: "broken.png",
        data: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(60),
        ]),
        mediaType: "image/png",
      },
    });
    assert.equal(corrupt.status, 400);
    const corruptBody = (await corrupt.json()) as {
      error?: { code?: string; details?: { fileName?: string } };
    };
    assert.equal(corruptBody.error?.code, "IMAGE_DECODE_FAILED");
    assert.equal(corruptBody.error?.details?.fileName, "broken.png");

    const stripped = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "缺像素裙子",
      home: {
        fileName: "stripped.png",
        data: PNG_WITHOUT_PIXELS,
        mediaType: "image/png",
      },
    });
    assert.equal(stripped.status, 400);
    const strippedBody = (await stripped.json()) as {
      error?: { code?: string; details?: { fileName?: string } };
    };
    assert.equal(strippedBody.error?.code, "IMAGE_DECODE_FAILED");
    assert.equal(strippedBody.error?.details?.fileName, "stripped.png");

    const damaged = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "损坏裙子",
      home: {
        fileName: "damaged.png",
        data: corruptPng(),
        mediaType: "image/png",
      },
    });
    assert.equal(damaged.status, 400);
    const damagedBody = (await damaged.json()) as {
      error?: { code?: string; details?: { fileName?: string } };
    };
    assert.equal(damagedBody.error?.code, "IMAGE_DECODE_FAILED");
    assert.equal(damagedBody.error?.details?.fileName, "damaged.png");

    // 只有段头、没有 SOS 扫描数据的 JPEG 不能解码。
    const headerOnly = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "空扫描裙子",
      home: {
        fileName: "header-only.jpg",
        data: JPEG_HEADER_ONLY,
        mediaType: "image/jpeg",
      },
    });
    assert.equal(headerOnly.status, 400);
    const headerOnlyBody = (await headerOnly.json()) as {
      error?: { code?: string; details?: { fileName?: string } };
    };
    assert.equal(headerOnlyBody.error?.code, "IMAGE_DECODE_FAILED");
    assert.equal(headerOnlyBody.error?.details?.fileName, "header-only.jpg");

    for (const [fileName, data, mediaType] of [
      ["bad-filter.png", BAD_FILTER_PNG, "image/png"],
      ["bad-stream.webp", BAD_STREAM_WEBP, "image/webp"],
    ] as const) {
      const rejected = await uploadOutfit(baseUrl, fixture.roleId, {
        name: fileName,
        home: { fileName, data, mediaType },
      });
      assert.equal(rejected.status, 400);
      const body = (await rejected.json()) as {
        error?: { code?: string; details?: { fileName?: string } };
      };
      assert.equal(body.error?.code, "IMAGE_DECODE_FAILED");
      assert.equal(body.error?.details?.fileName, fileName);
    }

    // 失败导入不得留下无引用文件或服饰记录。
    const appearanceDir = rolePaths(
      fixture.app.config.dataRoot,
      fixture.roleId,
    ).appearanceDir;
    assert.deepEqual(fs.readdirSync(appearanceDir), []);
    const list = await fetch(
      `${baseUrl}/v1/roles/${fixture.roleId}/appearance/outfits`,
    );
    assert.deepEqual(((await list.json()) as { items: unknown[] }).items, []);

    const form = new FormData();
    form.append("name", "双主页");
    form.append(
      "home",
      new Blob([PNG_SAMPLE], { type: "image/png" }),
      "home.png",
    );
    form.append(
      "home",
      new Blob([PNG_SAMPLE], { type: "image/png" }),
      "home2.png",
    );
    const multiple = await fetch(
      `${baseUrl}/v1/roles/${fixture.roleId}/appearance/outfits`,
      { method: "POST", body: form },
    );
    assert.equal(multiple.status, 400);
    assert.equal(await errorCode(multiple), "MULTIPLE_HOME_IMAGES");

    const emptyName = await uploadOutfit(baseUrl, fixture.roleId, {
      name: "   ",
    });
    assert.equal(emptyName.status, 400);
    assert.equal(await errorCode(emptyName), "OUTFIT_NAME_REQUIRED");
  } finally {
    await fixture.close();
  }
});

test("appearance survives restart and reads from the managed copy", { timeout: 60_000 }, async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  let reopened: ReturnType<typeof createBackendApp> | undefined;
  try {
    const outfit = await fixture.app.services.appearance.importOutfit(
      fixture.roleId,
      {
        name: "重启裙",
        home: { fileName: "home.png", data: PNG_SAMPLE },
      },
    );
    const paths = rolePaths(fixture.app.config.dataRoot, fixture.roleId);
    await fixture.app.close();
    fs.rmSync(paths.workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(paths.workspaceDir, { recursive: true });

    reopened = createBackendApp(fixture.app.config, {
      disableMemoryRuntime: true,
      modelPortFactory: () => new ScriptedChatModel([]),
    });
    const listed = reopened.services.appearance.list(fixture.roleId);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.outfitId, outfit.outfitId);
    const asset = reopened.services.appearance.readAsset(
      fixture.roleId,
      outfit.home!.assetId,
    );
    assert.deepEqual(asset.data, PNG_SAMPLE);
    assert.equal(asset.mediaType, "image/png");
    assert.ok(
      fs.existsSync(path.join(paths.roleDir, outfit.home!.relativePath)),
    );
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});
