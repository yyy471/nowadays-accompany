import fs from "node:fs";
import type http from "node:http";
import {
  ConversationService,
  type ChatModelPortFactory,
} from "../application/conversation-service.js";
import { AutonomyService } from "../application/autonomy-service.js";
import { MemoryQueryService } from "../application/memory-query-service.js";
import {
  MemoryRuntime,
  type MemoryModelFactory,
} from "../application/memory-runtime.js";
import { MessageService } from "../application/message-service.js";
import { ModelBindingResolver } from "../application/model-binding-resolver.js";
import { ModelService } from "../application/model-service.js";
import { ResourceService } from "../application/resource-service.js";
import { RoleAccess } from "../application/role-access.js";
import { RoleService } from "../application/role-service.js";
import { createHttpServer } from "../http/server.js";
import type { ApiServices } from "../http/routes.js";
import { AppStore } from "../storage/app-store.js";
import type { BackendConfig } from "./config.js";

export interface BackendAppOptions {
  now?: () => Date;
  timeZone?: string;
  typingMs?: number;
  autoRecallLimit?: number;
  maxToolRounds?: number;
  modelPortFactory?: ChatModelPortFactory;
  memoryModelFactory?: MemoryModelFactory;
  memoryIdleMs?: number;
  disableMemoryRuntime?: boolean;
}

export interface BackendApp {
  config: BackendConfig;
  appStore: AppStore;
  services: ApiServices;
  conversation: ConversationService;
  server: http.Server;
  close(): Promise<void>;
}

export function createBackendApp(
  config: BackendConfig,
  options: BackendAppOptions = {},
): BackendApp {
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const now = options.now ?? (() => new Date());
  const appStore = new AppStore(config.appDatabasePath);
  const roleService = new RoleService(appStore, config.dataRoot);
  const roleAccess = new RoleAccess(appStore, config.dataRoot);
  const messageService = new MessageService(roleAccess);
  const resourceService = new ResourceService(appStore, roleAccess);
  const memoryService = new MemoryQueryService(roleAccess, {
    now,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const modelService = new ModelService(appStore, config.appRoot, { now });
  const bindings = new ModelBindingResolver(appStore, roleAccess);
  const autonomy = new AutonomyService(roleAccess, {
    now,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const memoryRuntime = options.disableMemoryRuntime
    ? null
    : new MemoryRuntime(
        appStore,
        roleAccess,
        bindings,
        config.appRoot,
        config.dataRoot,
        {
          now,
          ...(options.timeZone === undefined
            ? {}
            : { timeZone: options.timeZone }),
          ...(options.memoryModelFactory === undefined
            ? {}
            : { modelFactory: options.memoryModelFactory }),
          ...(options.memoryIdleMs === undefined
            ? {}
            : { idleMs: options.memoryIdleMs }),
        },
      );
  const conversation = new ConversationService(
    appStore,
    roleAccess,
    bindings,
    memoryService,
    config.appRoot,
    config.dataRoot,
    {
      now,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      ...(options.typingMs === undefined ? {} : { typingMs: options.typingMs }),
      ...(options.autoRecallLimit === undefined
        ? {}
        : { autoRecallLimit: options.autoRecallLimit }),
      ...(options.maxToolRounds === undefined
        ? {}
        : { maxToolRounds: options.maxToolRounds }),
      ...(options.modelPortFactory === undefined
        ? {}
        : { modelPortFactory: options.modelPortFactory }),
      memoryRuntime,
      autonomy,
    },
  );
  memoryRuntime?.recoverOnStartup();
  conversation.recoverOnStartup();
  autonomy.setWakeListener((roleId) => conversation.refreshWakeTimer(roleId));
  const services: ApiServices = {
    roles: roleService,
    messages: messageService,
    resources: resourceService,
    memory: memoryService,
    modelServices: modelService,
    conversation,
    autonomy,
  };
  let server: http.Server;
  try {
    server = createHttpServer({ version: "0.1.0", services });
  } catch (error) {
    appStore.close();
    throw error;
  }

  let closed = false;
  return {
    config,
    appStore,
    services,
    conversation,
    server,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await conversation.close();
      if (server.listening) {
        await closeServer(server);
      }
      appStore.close();
    },
  };
}

export function listen(
  server: http.Server,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
        return;
      }
      reject(new Error("SERVER_ADDRESS_UNAVAILABLE"));
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}
