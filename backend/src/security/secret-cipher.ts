import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = "v1";

/** 当前密钥格式版本；写入新密文时随记录保存，便于以后轮换。 */
export const SECRET_KEY_VERSION = 1;

/**
 * 本地密钥盒：用应用目录下的主密钥文件加密模型服务密钥。
 *
 * 这是原型阶段的静态加密：主密钥与数据库同属当前用户，能防止直接翻看数据库
 * 明文，但同账户进程仍可读取主密钥。桌面打包与跨重启验证后，再决定是否改用
 * 系统密钥链或由 Electron 主进程代为解密。
 */
export class SecretCipher {
  private key: Buffer | null = null;

  constructor(private readonly appRoot: string) {}

  encrypt(plaintext: string): string {
    const key = this.loadKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      FORMAT_VERSION,
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }

  /** 解密失败返回 null，由调用方映射成「不可解密」状态。 */
  decrypt(payload: string): string | null {
    const parts = payload.split(".");
    if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
      return null;
    }
    try {
      const key = this.loadKey();
      const iv = Buffer.from(parts[1] ?? "", "base64");
      const tag = Buffer.from(parts[2] ?? "", "base64");
      const ciphertext = Buffer.from(parts[3] ?? "", "base64");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        return null;
      }
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      return plaintext.length === 0 ? null : plaintext;
    } catch {
      return null;
    }
  }

  private loadKey(): Buffer {
    if (this.key !== null) {
      return this.key;
    }
    const directory = path.join(this.appRoot, "secrets");
    const keyPath = path.join(directory, "master.key");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existing = readKeyFile(keyPath);
    if (existing !== null) {
      this.key = existing;
      return existing;
    }
    const created = randomBytes(KEY_BYTES);
    try {
      fs.writeFileSync(keyPath, `${created.toString("base64")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      this.key = created;
      return created;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // 另一进程刚创建了主密钥，读取同一份，避免两边用不同密钥写库。
      const raced = readKeyFile(keyPath);
      if (raced === null) {
        throw error;
      }
      this.key = raced;
      return raced;
    }
  }
}

function readKeyFile(keyPath: string): Buffer | null {
  let raw: string;
  try {
    raw = fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const decoded = Buffer.from(raw.trim(), "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error("SECRET_KEY_INVALID");
  }
  return decoded;
}
