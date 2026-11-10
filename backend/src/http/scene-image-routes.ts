import type { Router } from "./router.js";
import type { ApiServices } from "./routes.js";
import { readJsonBody } from "./body.js";
import type { RouteResponse } from "./errors.js";
import { parseBody } from "./validation.js";
import { sceneImageRequestSchema } from "./schemas.js";

export function registerSceneImageRoutes(
  router: Router,
  services: ApiServices,
): void {
  router.add(
    "POST",
    "/v1/roles/:roleId/windows/:windowId/messages/:messageId/scene-images",
    async ({ request, params }): Promise<RouteResponse> => {
      const body = parseBody(sceneImageRequestSchema, await readJsonBody(request));
      const result = services.sceneImages.requestManual(
        params.roleId ?? "",
        params.windowId ?? "",
        params.messageId ?? "",
        {
          idempotencyKey: body.idempotencyKey,
          ...(body.layerMode === undefined ? {} : { layerMode: body.layerMode }),
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
    "/v1/roles/:roleId/windows/:windowId/scene-images/:taskId",
    ({ params }): RouteResponse => ({
      status: 200,
      body: {
        task: services.sceneImages.getTask(
          params.roleId ?? "",
          params.windowId ?? "",
          params.taskId ?? "",
        ),
      },
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/scene-images/assets/:assetId",
    ({ params }): RouteResponse => {
      const asset = services.sceneImages.readAsset(
        params.roleId ?? "",
        params.assetId ?? "",
      );
      return {
        status: 200,
        contentType: asset.mediaType,
        body: asset.data,
        cacheControl: "private, max-age=31536000, immutable",
      };
    },
  );
}
