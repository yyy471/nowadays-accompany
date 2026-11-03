import type {
  CreateResourceBody,
  CreateWindowBody,
  CreateRoleBody,
  PutBindingsBody,
  PutStateBody,
  SubmitMessageBody,
  UpdateDefinitionBody,
  UpdateResourceBody,
} from "./schemas.js";
import { readJsonBody } from "./body.js";
import { HttpError, type JsonResponse } from "./errors.js";
import type { Router } from "./router.js";
import type { MessageService } from "../application/message-service.js";
import type { ResourceService } from "../application/resource-service.js";
import type { RoleService } from "../application/role-service.js";
import { resourceKindSchema } from "../domain/resource.js";
import {
  createResourceSchema,
  createRoleSchema,
  createWindowSchema,
  putBindingsSchema,
  putStateSchema,
  submitMessageSchema,
  updateDefinitionSchema,
  updateResourceSchema,
} from "./schemas.js";
import { parseBody, queryInt } from "./validation.js";

export interface ApiServices {
  roles: RoleService;
  messages: MessageService;
  resources: ResourceService;
}

export function registerApiRoutes(
  router: Router,
  services: ApiServices,
  version: string,
): Router {
  router.add("GET", "/v1/health", (): JsonResponse => ({
    status: 200,
    body: { status: "ok", version },
  }));

  router.add("POST", "/v1/roles", async ({ request }): Promise<JsonResponse> => {
    const body = parseBody<CreateRoleBody>(
      createRoleSchema,
      await readJsonBody(request),
    );
    return {
      status: 201,
      body: { ...services.roles.createRole(body), status: "ready" },
    };
  });

  router.add(
    "POST",
    "/v1/roles/:roleId/initialize",
    ({ params }): JsonResponse => ({
      status: 200,
      body: {
        ...services.roles.initializeRole(params.roleId ?? ""),
        status: "ready",
      },
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.roles.getRole(params.roleId ?? ""),
    }),
  );

  router.add(
    "PATCH",
    "/v1/roles/:roleId/definition",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<UpdateDefinitionBody>(
        updateDefinitionSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.roles.updateDefinition(params.roleId ?? "", body),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/state",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.roles.getState(params.roleId ?? ""),
    }),
  );

  router.add(
    "PUT",
    "/v1/roles/:roleId/state",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<PutStateBody>(
        putStateSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.roles.setState(params.roleId ?? "", body),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/windows",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<CreateWindowBody>(
        createWindowSchema,
        await readJsonBody(request),
      );
      return {
        status: 201,
        body: services.roles.createWindow(params.roleId ?? "", {
          kind: body.kind ?? "custom",
          source: body.source ?? "nowadays",
        }),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/windows",
    ({ params }): JsonResponse => ({
      status: 200,
      body: { items: services.roles.listWindows(params.roleId ?? "") },
    }),
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/windows/:windowId/messages",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<SubmitMessageBody>(
        submitMessageSchema,
        await readJsonBody(request),
      );
      const result = services.messages.submit(
        params.roleId ?? "",
        params.windowId ?? "",
        {
          content: body.content,
          submissionId: body.submissionId,
          sourcePlatform: body.source ?? "nowadays",
        },
      );
      return {
        status: result.duplicate ? 200 : 201,
        body: result,
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/windows/:windowId/messages",
    ({ params, url }): JsonResponse => {
      const after = queryInt(url, "after", {
        min: 0,
        max: 2_147_483_647,
        defaultValue: 0,
      });
      const limit = queryInt(url, "limit", {
        min: 1,
        max: 200,
        defaultValue: 50,
      });
      return {
        status: 200,
        body: services.messages.list(
          params.roleId ?? "",
          params.windowId ?? "",
          after,
          limit,
        ),
      };
    },
  );

  router.add(
    "POST",
    "/v1/resources",
    async ({ request }): Promise<JsonResponse> => {
      const body = parseBody<CreateResourceBody>(
        createResourceSchema,
        await readJsonBody(request),
      );
      return { status: 201, body: services.resources.create(body) };
    },
  );

  router.add("GET", "/v1/resources", ({ url }): JsonResponse => {
    const rawKind = url.searchParams.get("kind");
    let kind;
    if (rawKind !== null) {
      const parsed = resourceKindSchema.safeParse(rawKind);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "INVALID_QUERY",
          "查询参数 kind 必须是 model、mcp 或 skill",
        );
      }
      kind = parsed.data;
    }
    return {
      status: 200,
      body: { items: services.resources.list(kind) },
    };
  });

  router.add(
    "GET",
    "/v1/resources/:resourceId",
    ({ params }): JsonResponse => ({
      status: 200,
      body: services.resources.get(params.resourceId ?? ""),
    }),
  );

  router.add(
    "PATCH",
    "/v1/resources/:resourceId",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<UpdateResourceBody>(
        updateResourceSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.resources.update(params.resourceId ?? "", body),
      };
    },
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/bindings",
    ({ params }): JsonResponse => ({
      status: 200,
      body: { items: services.resources.listBindings(params.roleId ?? "") },
    }),
  );

  router.add(
    "PUT",
    "/v1/roles/:roleId/bindings",
    async ({ request, params }): Promise<JsonResponse> => {
      const body = parseBody<PutBindingsBody>(
        putBindingsSchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: {
          items: services.resources.replaceBindings(
            params.roleId ?? "",
            body.bindings,
          ),
        },
      };
    },
  );

  return router;
}
