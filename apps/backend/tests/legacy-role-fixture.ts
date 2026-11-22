import { randomUUID } from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  XIA_CHENG_BIO_TEXT,
  XIA_CHENG_BUILTIN_KEY,
  XIA_CHENG_DEFAULT_DEFINITION_TEXT,
  XIA_CHENG_DISPLAY_NAME,
} from "../src/application/role/preset-assistant.js";
import type { CreateRoleInput, CreateRoleInternalOptions } from "../src/application/role/role-service.js";
import type { BackendApp } from "../src/bootstrap/app.js";
import { rolePaths, type BackendConfig } from "../src/bootstrap/config.js";
import { AppStore } from "../src/storage/core/app-store.js";
import { BUSINESS_SCHEMA_V22_SQL } from "../src/storage/core/schema.js";

/** 在浏览器/对话夹具中保留 V22 已有角色的调用顺序；正常初始化会升级旧库。 */
export function createLegacyRole(app: BackendApp, input: CreateRoleInput) {
  const roleId = seedLegacyRole(app.appStore, app.config.dataRoot, input);
  return app.services.roles.initializeRole(roleId);
}

/** 在后端启动前放入需要升级的既有预置角色。 */
export function seedLegacyPresetAssistant(config: BackendConfig): void {
  const appStore = new AppStore(config.appDatabasePath);
  try {
    seedLegacyRole(appStore, config.dataRoot, {
      displayName: XIA_CHENG_DISPLAY_NAME,
      definition: { text: XIA_CHENG_DEFAULT_DEFINITION_TEXT },
    }, { builtinKey: XIA_CHENG_BUILTIN_KEY, bioText: XIA_CHENG_BIO_TEXT });
  } finally {
    appStore.close();
  }
}

function seedLegacyRole(
  appStore: AppStore,
  dataRoot: string,
  input: CreateRoleInput,
  identity: CreateRoleInternalOptions = {},
): string {
  const roleId = randomUUID();
  const paths = rolePaths(dataRoot, roleId);
  appStore.createRoleIndex({
    roleId,
    relativeDir: `roles/${roleId}`,
    initPayload: {
      displayName: input.displayName,
      definition: { text: input.definition.text, payload: input.definition.payload ?? {} },
      state: input.state ?? {},
      ...identity,
    },
  });
  fs.mkdirSync(paths.roleDir, { recursive: true });
  const db = new Database(paths.businessDatabasePath);
  try {
    db.transaction(() => {
      db.exec(BUSINESS_SCHEMA_V22_SQL);
      db.pragma("user_version = 22");
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles
         (role_id, display_name, definition_text, definition_payload_json, definition_revision,
          state_json, state_version, created_at, updated_at, builtin_key, bio_text)
         VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?)`)
        .run(roleId, input.displayName, input.definition.text,
          JSON.stringify(input.definition.payload ?? {}), JSON.stringify(input.state ?? {}), now, now,
          identity.builtinKey ?? null, identity.bioText ?? "");
      db.prepare(`INSERT INTO windows (window_id, role_id, kind, source, created_at, updated_at)
         VALUES (?, ?, 'main', 'nowadays', ?, ?)`)
        .run(randomUUID(), roleId, now, now);
    })();
  } finally {
    db.close();
  }
  return roleId;
}
