import fs from "node:fs";
import type http from "node:http";
import {
  ConversationService,
  type ChatModelPortFactory,
} from "../application/conversation-service.js";
import { AutonomyService } from "../application/autonomy-service.js";
import { AppearanceService } from "../application/appearance-service.js";
import { VoiceService } from "../application/voice-service.js";
import { ImageServiceService } from "../application/image-service.js";
import { SceneImageSettingsService } from "../application/scene-image-settings.js";
import { MemoryQueryService } from "../application/memory-query-service.js";
import {
  MemoryRuntime,
  type MemoryModelFactory,
} from "../application/memory-runtime.js";
import { MessageService } from "../application/message-service.js";
import { ModelBindingResolver } from "../application/model-binding-resolver.js";
import { ModelService } from "../application/model-service.js";
import { CredentialResolver } from "../application/credential-resolver.js";
import { ResourceService } from "../application/resource-service.js";
import { RoleAccess } from "../application/role-access.js";
import { RoleService } from "../application/role-service.js";
import {
  SceneImageService,
  type SceneImageServiceOptions,
} from "../application/scene-image-service.js";
import { createHttpServer } from "../http/server.js";
import type { ApiServices } from "../http/routes.js";
import { AppStore } from "../storage/app-store.js";
import { SecretStore } from "../storage/secret-store.js";
import { SecretCipher } from "../security/secret-cipher.js";
import { FixedSceneImagePlanner } from "../scene/fixed-planner.js";
import { FakeSceneImageGenerator } from "../scene/fake-generator.js";
import { ConfiguredSceneImageGenerator } from "../scene/comfyui-generator.js";
import { ModelSceneImagePlanner } from "../scene/model-planner.js";
import type { BackendConfig } from "./config.js";

export interface BackendAppOptions {
  now?: () => Date;
  timeZone?: string;
  typingMs?: number;
  autoRecallLimit?: number;
  maxToolRounds?: number;
  toolForegroundWaitMs?: number;
  modelPortFactory?: ChatModelPortFactory;
  memoryModelFactory?: MemoryModelFactory;
  memoryIdleMs?: number;
  disableMemoryRuntime?: boolean;
  sceneImagePlanner?: SceneImageServiceOptions["planner"];
  sceneImageGenerator?: SceneImageServiceOptions["generator"];
  sceneImageGenerationTimeoutMs?: number;
  sceneImageInspector?: SceneImageServiceOptions["imageInspector"];
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
  const credentials = new CredentialResolver(
    config.appRoot,
    new SecretStore(appStore.db, new SecretCipher(config.appRoot)),
  );
  const roleService = new RoleService(appStore, config.dataRoot);
  const roleAccess = new RoleAccess(appStore, config.dataRoot);
  const messageService = new MessageService(roleAccess);
  const resourceService = new ResourceService(appStore, roleAccess, {
    credentialResolver: credentials,
    now,
  });
  const appearanceService = new AppearanceService(roleAccess);
  const voiceService = new VoiceService(roleAccess, { now });
  const imageServices = new ImageServiceService(appStore, {
    credentialResolver: credentials,
    now,
  });
  const sceneImageSettings = new SceneImageSettingsService(
    roleAccess,
    imageServices,
    { now },
  );
  const memoryService = new MemoryQueryService(roleAccess, {
    now,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const modelService = new ModelService(appStore, config.appRoot, {
    now,
    credentialResolver: credentials,
  });
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
          credentialResolver: credentials,
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
      credentialResolver: credentials,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      ...(options.typingMs === undefined ? {} : { typingMs: options.typingMs }),
      ...(options.autoRecallLimit === undefined
        ? {}
        : { autoRecallLimit: options.autoRecallLimit }),
      ...(options.maxToolRounds === undefined
        ? {}
        : { maxToolRounds: options.maxToolRounds }),
      ...(options.toolForegroundWaitMs === undefined
        ? {}
        : { toolForegroundWaitMs: options.toolForegroundWaitMs }),
      ...(options.modelPortFactory === undefined
        ? {}
        : { modelPortFactory: options.modelPortFactory }),
      memoryRuntime,
      autonomy,
    },
  );
  memoryRuntime?.recoverOnStartup();
  conversation.recoverOnStartup();
  const sceneImages = new SceneImageService(appStore, roleAccess, config.dataRoot, {
    now,
    planner:
      options.sceneImagePlanner ??
      new ModelSceneImagePlanner(roleAccess, bindings, {
        appRoot: config.appRoot,
        now,
        credentialResolver: credentials,
        ...(options.timeZone === undefined
          ? {}
          : { timeZone: options.timeZone }),
        ...(options.modelPortFactory === undefined
          ? {}
          : { modelFactory: options.modelPortFactory }),
        fallback: new FixedSceneImagePlanner(),
      }),
    generator:
      options.sceneImageGenerator ??
      new ConfiguredSceneImageGenerator({
        source: sceneImageSettings.source,
        fallback: new FakeSceneImageGenerator(),
      }),
    ...(options.sceneImageGenerationTimeoutMs === undefined
      ? {}
      : { generationTimeoutMs: options.sceneImageGenerationTimeoutMs }),
    ...(options.sceneImageInspector === undefined
      ? {}
      : { imageInspector: options.sceneImageInspector }),
  });
  sceneImages.recoverOnStartup();
  autonomy.setWakeListener((roleId) => conversation.refreshWakeTimer(roleId));
  autonomy.setProactiveMessageListener((notice) =>
    conversation.queueSegmentAnnotation(notice),
  );
  const services: ApiServices = {
    roles: roleService,
    messages: messageService,
    resources: resourceService,
    memory: memoryService,
    modelServices: modelService,
    conversation,
    autonomy,
    appearance: appearanceService,
    voice: voiceService,
    sceneImages,
    imageServices,
    sceneImageSettings,
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
      await sceneImages.close();
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
