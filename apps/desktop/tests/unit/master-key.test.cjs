"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { resolveManagedMasterKey } = require("../../electron/master-key.cjs");
const { createBackendLog } = require("../../electron/backend-log.cjs");

const PREFIX = "dpapi:";

function createSafeStorage({ available = true, failEncrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(text) {
      if (failEncrypt) throw new Error("ENCRYPT_UNAVAILABLE");
      return Buffer.from(PREFIX + text, "utf8");
    },
    decryptString(buffer) {
      const text = buffer.toString("utf8");
      if (!text.startsWith(PREFIX)) throw new Error("DECRYPT_FAILED");
      return text.slice(PREFIX.length);
    }
  };
}

const deterministicRandom = size => Buffer.alloc(size, 7);

test("全新安装生成 DPAPI 密文且不残留明文", () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-master-key-"));
  const safeStorage = createSafeStorage();
  const result = resolveManagedMasterKey({ appRoot: temp.path, safeStorage, randomBytes: deterministicRandom });

  assert.equal(result.mode, "dpapi-created");
  assert.equal(result.masterKeyBase64, Buffer.alloc(32, 7).toString("base64"));
  const secrets = path.join(temp.path, "secrets");
  assert.ok(fs.existsSync(path.join(secrets, "master.key.dpapi")));
  assert.equal(fs.existsSync(path.join(secrets, "master.key")), false);
  assert.equal(safeStorage.decryptString(fs.readFileSync(path.join(secrets, "master.key.dpapi"))), result.masterKeyBase64);
});

test("二次启动复用同一密钥且不再重新生成", () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-master-key-"));
  const safeStorage = createSafeStorage();
  const first = resolveManagedMasterKey({ appRoot: temp.path, safeStorage, randomBytes: deterministicRandom });
  const second = resolveManagedMasterKey({ appRoot: temp.path, safeStorage, randomBytes: () => Buffer.alloc(32, 9) });

  assert.equal(second.mode, "dpapi");
  assert.equal(second.masterKeyBase64, first.masterKeyBase64);
});

test("旧明文主密钥自动迁移为 DPAPI 密文并删除明文", () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-master-key-"));
  const secrets = path.join(temp.path, "secrets");
  fs.mkdirSync(secrets, { recursive: true });
  const legacyKey = Buffer.alloc(32, 5).toString("base64");
  const legacyPath = path.join(secrets, "master.key");
  fs.writeFileSync(legacyPath, legacyKey + "\n");
  const safeStorage = createSafeStorage();

  const result = resolveManagedMasterKey({ appRoot: temp.path, safeStorage, randomBytes: deterministicRandom });

  assert.equal(result.mode, "dpapi-migrated");
  assert.equal(result.masterKeyBase64, legacyKey);
  assert.equal(fs.existsSync(legacyPath), false);
  const dpapiPath = path.join(secrets, "master.key.dpapi");
  assert.equal(safeStorage.decryptString(fs.readFileSync(dpapiPath)), legacyKey);
});

test("加密失败时保留旧明文且不写入密文", () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-master-key-"));
  const secrets = path.join(temp.path, "secrets");
  fs.mkdirSync(secrets, { recursive: true });
  const legacyKey = Buffer.alloc(32, 3).toString("base64");
  const legacyPath = path.join(secrets, "master.key");
  fs.writeFileSync(legacyPath, legacyKey);

  assert.throws(
    () => resolveManagedMasterKey({
      appRoot: temp.path,
      safeStorage: createSafeStorage({ failEncrypt: true }),
      randomBytes: deterministicRandom
    }),
    /ENCRYPT_UNAVAILABLE/
  );
  assert.ok(fs.existsSync(legacyPath));
  assert.equal(fs.existsSync(path.join(secrets, "master.key.dpapi")), false);
  assert.deepEqual(fs.readdirSync(secrets).filter(name => name.endsWith(".tmp")), []);
});

test("safeStorage 不可用时返回 file-fallback 且不落盘", () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-master-key-"));
  const result = resolveManagedMasterKey({
    appRoot: temp.path,
    safeStorage: createSafeStorage({ available: false }),
    randomBytes: deterministicRandom
  });

  assert.deepEqual(result, { masterKeyBase64: null, mode: "file-fallback" });
  assert.equal(fs.existsSync(path.join(temp.path, "secrets")), false);
});

test("backend-log 对 extraSecrets 完整脱敏", () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "desk-master-key-"));
  const masterKeyBase64 = Buffer.from("nowadays-master-key-32-bytes!!!!").toString("base64");
  const log = createBackendLog({
    logDirectory: temp.path,
    hostToken: "host-token-value",
    extraSecrets: [masterKeyBase64]
  });
  log.lifecycle("backend_master_key_value=" + masterKeyBase64);
  log.stdout(masterKeyBase64 + "\n");
  log.stderr("tail " + masterKeyBase64 + "\n");
  log.close();

  const saved = fs.readFileSync(path.join(temp.path, "backend-latest.log"), "utf8");
  assert.equal(saved.includes(masterKeyBase64), false);
  assert.equal(log.stderrTail.includes(masterKeyBase64), false);
  assert.equal((saved.match(/\[REDACTED\]/g) || []).length >= 3, true);
  assert.equal(saved.includes("host-token-value"), false);
});
