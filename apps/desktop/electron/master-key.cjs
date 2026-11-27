"use strict";

// 桌面壳托管主密钥：优先用 Electron safeStorage（Windows 上即 DPAPI）加密落盘，
// 无加密能力时退回不提供密钥（由后端自行处理），绝不明文写入新格式。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const KEY_BYTES = 32;

function decodeKeyBase64(text) {
  const key = Buffer.from(String(text).trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error("SECRET_KEY_INVALID");
  return key;
}

function validateKeyBase64(text) {
  return decodeKeyBase64(text).toString("base64");
}

function createAtomicWriter(fsImpl, randomBytes) {
  return function atomicWrite(targetPath, contents) {
    fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${randomBytes(8).toString("hex")}.tmp`
    );
    try {
      fsImpl.writeFileSync(tempPath, contents, { flag: "wx", mode: 0o600 });
      fsImpl.renameSync(tempPath, targetPath);
    } catch (error) {
      try { fsImpl.unlinkSync(tempPath); } catch { /* 临时文件可能尚未创建 */ }
      throw error;
    }
  };
}

function removeKeyFile(fsImpl, targetPath) {
  try {
    fsImpl.unlinkSync(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function resolveManagedMasterKey({
  appRoot,
  safeStorage,
  fsImpl = fs,
  randomBytes = crypto.randomBytes
}) {
  const secretsDir = path.join(appRoot, "secrets");
  const dpapiPath = path.join(secretsDir, "master.key.dpapi");
  const legacyPath = path.join(secretsDir, "master.key");
  const atomicWrite = createAtomicWriter(fsImpl, randomBytes);

  const encryptionAvailable = safeStorage?.isEncryptionAvailable?.() === true;
  if (!encryptionAvailable) {
    return { masterKeyBase64: null, mode: "file-fallback" };
  }

  // 已有密文：优先复用；若同目录仍残留一致的旧明文，则顺手清理。
  if (fsImpl.existsSync(dpapiPath)) {
    const masterKeyBase64 = validateKeyBase64(
      safeStorage.decryptString(fsImpl.readFileSync(dpapiPath))
    );
    if (fsImpl.existsSync(legacyPath)) {
      try {
        const legacyKey = validateKeyBase64(fsImpl.readFileSync(legacyPath, "utf8"));
        if (Buffer.from(legacyKey, "base64").equals(Buffer.from(masterKeyBase64, "base64"))) {
          removeKeyFile(fsImpl, legacyPath);
        }
      } catch { /* 旧文件损坏或不可读时保持原样，不阻断启动。 */ }
    }
    return { masterKeyBase64, mode: "dpapi" };
  }

  // 旧明文自动迁移：加密并回读校验通过后才删除明文。
  if (fsImpl.existsSync(legacyPath)) {
    const masterKeyBase64 = validateKeyBase64(fsImpl.readFileSync(legacyPath, "utf8"));
    atomicWrite(dpapiPath, safeStorage.encryptString(masterKeyBase64));
    const roundTrip = validateKeyBase64(safeStorage.decryptString(fsImpl.readFileSync(dpapiPath)));
    if (!Buffer.from(roundTrip, "base64").equals(Buffer.from(masterKeyBase64, "base64"))) {
      throw new Error("SECRET_KEY_MIGRATION_FAILED");
    }
    removeKeyFile(fsImpl, legacyPath);
    return { masterKeyBase64, mode: "dpapi-migrated" };
  }

  // 全新安装：生成 32 字节随机密钥并加密落盘。
  const masterKeyBase64 = randomBytes(KEY_BYTES).toString("base64");
  atomicWrite(dpapiPath, safeStorage.encryptString(masterKeyBase64));
  return { masterKeyBase64, mode: "dpapi-created" };
}

module.exports = { resolveManagedMasterKey };
