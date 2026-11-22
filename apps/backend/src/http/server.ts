import http from "node:http";
import { Router } from "./router.js";
import { registerApiRoutes, type ApiServices } from "./routes.js";

export interface HttpServerOptions {
  version: string;
  services: ApiServices;
}

export function createHttpServer(options: HttpServerOptions): http.Server {
  const router = new Router();
  registerApiRoutes(router, options.services, options.version);
  return http.createServer((request, response) => {
    void router.handle(request, response);
  });
}
