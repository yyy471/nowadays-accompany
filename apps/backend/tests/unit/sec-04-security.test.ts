import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { installCredentialValues } from "../../src/application/transfer/role-transfer-credentials.js";
import {
  parseBackendConfig,
  type BackendConfig,
} from "../../src/bootstrap/config.js";
import { Router } from "../../src/http/router.js";
import { SecretCipher } from "../../src/security/secret-cipher.js";

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("注入主密钥后跨实例加解密，且不落盘 secrets/master.key", () => {
  const root = tempRoot("sec04-cipher-");
  try {
    const key = randomBytes(32);
    const writer = new SecretCipher(root, { masterKey: key });
    const payload = writer.encrypt("注入主密钥的明文");
    const reader = new SecretCipher(root, { masterKey: key.toString("base64") });
    assert.equal(reader.decrypt(payload), "注入主密钥的明文");
    assert.equal(fs.existsSync(path.join(root, "secrets")), false);
    assert.equal(fs.existsSync(path.join(root, "secrets", "master.key")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("主密钥非 32 字节时拒绝构造", () => {
  const root = tempRoot("sec04-cipher-invalid-");
  try {
    assert.throws(
      () => new SecretCipher(root, { masterKey: randomBytes(31) }),
      /SECRET_KEY_INVALID/,
    );
    assert.throws(
      () => new SecretCipher(root, { masterKey: randomBytes(33) }),
      /SECRET_KEY_INVALID/,
    );
    assert.throws(
      () => new SecretCipher(root, { masterKey: randomBytes(31).toString("base64") }),
      /SECRET_KEY_INVALID/,
    );
    assert.equal(fs.existsSync(path.join(root, "secrets")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installCredentialValues 在无磁盘 master.key 时用注入密钥解密", () => {
  const root = tempRoot("sec04-transfer-");
  const db = new Database(":memory:");
  try {
    const key = randomBytes(32);
    db.exec("CREATE TABLE resource_secrets (ciphertext TEXT NOT NULL)");
    const ciphertext = new SecretCipher(root, { masterKey: key }).encrypt(
      "secret-value-123",
    );
    db.prepare("INSERT INTO resource_secrets (ciphertext) VALUES (?)").run(
      ciphertext,
    );
    const config: BackendConfig = {
      ...parseBackendConfig(["--app-root", root], {}),
      masterKey: key.toString("base64"),
    };
    const values = installCredentialValues(config, db);
    assert.ok(values.has("secret-value-123"));
    assert.ok(values.has(ciphertext));
    assert.ok(values.has(key.toString("base64")));
    assert.equal(fs.existsSync(path.join(root, "secrets", "master.key")), false);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function serveRouter(
  router: Router,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    void router.handle(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  assert.notEqual(port, 0);
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function routerWithPing(allowedOrigins?: readonly string[]): Router {
  const router = new Router(undefined, allowedOrigins);
  router.add("GET", "/ping", () => ({ status: 200, body: { ok: true } }));
  return router;
}

test("Router 默认只放行桌面壳，白名单精确命中", async () => {
  const server = await serveRouter(
    routerWithPing(["http://localhost:5173"]),
  );
  try {
    const open = await fetch(`${server.base}/ping`);
    assert.equal(open.status, 200);
    assert.equal(open.headers.get("access-control-allow-origin"), null);

    for (const origin of [
      "desk://bundle",
      "app://bundle",
      "DESK://BUNDLE",
      "http://localhost:5173",
      "http://localhost:5173/",
    ]) {
      const response = await fetch(`${server.base}/ping`, {
        headers: { origin },
      });
      assert.equal(response.status, 200, origin);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        origin,
      );
    }

    for (const origin of [
      "http://localhost:9999",
      "http://127.0.0.1:1234",
      "file://",
      "https://evil.example",
    ]) {
      for (const method of ["GET", "OPTIONS"]) {
        const denied = await fetch(`${server.base}/ping`, {
          method,
          headers: { origin },
        });
        assert.equal(denied.status, 403, `${method} ${origin}`);
        assert.match(await denied.text(), /ORIGIN_DENIED/);
        assert.equal(denied.headers.get("access-control-allow-origin"), null);
      }
    }
  } finally {
    await server.close();
  }
});

test("Router 未配置白名单时连 localhost 桌面调试端口也拒绝", async () => {
  const server = await serveRouter(routerWithPing());
  try {
    const denied = await fetch(`${server.base}/ping`, {
      headers: { origin: "http://localhost:5173" },
    });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /ORIGIN_DENIED/);
    const desk = await fetch(`${server.base}/ping`, {
      headers: { origin: "desk://bundle" },
    });
    assert.equal(desk.status, 200);
  } finally {
    await server.close();
  }
});

test("parseBackendConfig 解析宿主令牌、来源白名单与免鉴权开关", () => {
  const root = tempRoot("sec04-config-");
  try {
    const config = parseBackendConfig(
      [
        "--app-root",
        root,
        "--host-token",
        "cli-token",
        "--allow-origin",
        "http://localhost:5173/",
        "--allow-origin",
        "https://a.example",
        "--allow-unauthenticated",
      ],
      {
        NOWADAYS_HOST_TOKEN: "env-token",
        NOWADAYS_ALLOWED_ORIGINS:
          " http://b.example , http://localhost:5173/ ",
        NOWADAYS_MASTER_KEY: "base64-key",
      },
    );
    assert.equal(config.hostToken, "cli-token");
    assert.equal(config.allowUnauthenticated, true);
    assert.deepEqual(config.allowedOrigins, [
      "http://localhost:5173",
      "https://a.example",
      "http://b.example",
    ]);
    assert.equal(config.masterKey, "base64-key");

    const fromEnv = parseBackendConfig(["--app-root", root], {
      NOWADAYS_HOST_TOKEN: "env-token",
      NOWADAYS_ALLOWED_ORIGINS: "http://localhost:5173",
    });
    assert.equal(fromEnv.hostToken, "env-token");
    assert.equal(fromEnv.allowUnauthenticated, false);
    assert.deepEqual(fromEnv.allowedOrigins, ["http://localhost:5173"]);
    assert.equal(fromEnv.masterKey, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
