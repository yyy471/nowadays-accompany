import fs from "node:fs";
import type http from "node:http";
import { MessageService } from "../application/message-service.js";
import { ResourceService } from "../application/resource-service.js";
import { RoleAccess } from "../application/role-access.js";
import { RoleService } from "../application/role-service.js";
import { createHttpServer } from "../http/server.js";
import type { ApiServices } from "../http/routes.js";
import { AppStore } from "../storage/app-store.js";
import type { BackendConfig } from "./config.js";

export interface BackendApp {
  config: BackendConfig;
  appStore: AppStore;
  services: ApiServices;
  server: http.Server;
  close(): Promise<void>;
}

export function createBackendApp(config: BackendConfig): BackendApp {
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const appStore = new AppStore(config.appDatabasePath);
  const roleService = new RoleService(appStore, config.dataRoot);
  const roleAccess = new RoleAccess(appStore, config.dataRoot);
  const messageService = new MessageService(roleAccess);
  const resourceService = new ResourceService(appStore, roleAccess);
  const services: ApiServices = {
    roles: roleService,
    messages: messageService,
    resources: resourceService,
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
    server,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
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
  });
}
