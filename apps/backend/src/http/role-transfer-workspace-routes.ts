import { z } from "zod";
import type { RoleTransferHttpService } from "../application/transfer/role-transfer-service.js";
import type { RoleWorkspaceService } from "../application/role/role-workspace-service.js";
import { readJsonBody } from "./body.js";
import { HttpError, type JsonResponse } from "./errors.js";
import type { Router } from "./router.js";
import { parseBody } from "./validation.js";

export interface RoleTransferWorkspaceServices {
  roleWorkspace: RoleWorkspaceService;
  roleTransfer: RoleTransferHttpService;
}

const exportBodySchema = z.object({
  file: z.string().trim().min(1),
});

const preflightBodySchema = z.object({
  file: z.string().trim().min(1),
  mapping: z.record(z.string(), z.string()).optional(),
});

const applyBodySchema = z.object({
  file: z.string().trim().min(1),
  token: z.string().min(1),
  mapping: z.record(z.string(), z.string()).optional(),
  choice: z.enum(["local", "package"]).optional(),
});

/**
 * 角色工作空间笔记浏览与单角色迁移接口（409 UX-05）。
 *
 * 迁移的导出／导入会先经服务层 `activity.guardRole` 持有停机租约，
 * 因此这里不把路由登记进 `ROLE_CONFIG_WRITES`，避免守卫重复加锁。
 */
export function registerRoleTransferWorkspaceRoutes(
  router: Router,
  services: RoleTransferWorkspaceServices,
): Router {
  router.add(
    "GET",
    "/v1/roles/:roleId/workspace/notes",
    ({ params }): JsonResponse => ({
      status: 200,
      body: { items: services.roleWorkspace.listNotes(params.roleId ?? "") },
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/workspace/note",
    ({ params, url }): JsonResponse => {
      const relativePath = url.searchParams.get("path");
      if (relativePath === null || relativePath.trim().length === 0) {
        throw new HttpError(400, "INVALID_QUERY", "请指定笔记路径 path");
      }
      return {
        status: 200,
        body: { note: services.roleWorkspace.readNote(params.roleId ?? "", relativePath) },
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/workspace/path",
    ({ params }): JsonResponse => ({
      status: 200,
      body: { path: services.roleWorkspace.getWorkspaceDir(params.roleId ?? "") },
    }),
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/transfer/export",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody(exportBodySchema, await readJsonBody(request));
      return {
        status: 200,
        body: { result: await services.roleTransfer.exportRole(params.roleId ?? "", body.file) },
      };
    },
  );

  router.add(
    "POST",
    "/v1/role-transfers/preflight",
    async ({ request }): Promise<JsonResponse> => {
      const body = parseBody(preflightBodySchema, await readJsonBody(request));
      return {
        status: 200,
        body: { preview: await services.roleTransfer.preflightImport(body.file, body.mapping ?? {}) },
      };
    },
  );

  router.add(
    "POST",
    "/v1/role-transfers/apply",
    async ({ request }): Promise<JsonResponse> => {
      const body = parseBody(applyBodySchema, await readJsonBody(request));
      return {
        status: 200,
        body: {
          result: await services.roleTransfer.applyImport({
            file: body.file,
            token: body.token,
            ...(body.mapping === undefined ? {} : { mapping: body.mapping }),
            ...(body.choice === undefined ? {} : { choice: body.choice }),
          }),
        },
      };
    },
  );

  return router;
}
