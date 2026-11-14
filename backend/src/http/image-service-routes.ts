import type { Router } from "./router.js";
import type { ApiServices } from "./routes.js";
import { readJsonBody } from "./body.js";
import type { RouteResponse } from "./errors.js";
import { parseBody } from "./validation.js";
import {
  createImageServiceSchema,
  probeImageServiceSchema,
  sceneImagePreviewBodySchema,
  sceneImageProbeBodySchema,
  sceneImageSettingsBodySchema,
  updateImageServiceSchema,
} from "./schemas.js";
import type { SceneImageSettingsInput } from "../domain/scene-image-settings.js";

function compactDraft(
  source: Record<string, unknown>,
): Partial<SceneImageSettingsInput> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<SceneImageSettingsInput>;
}

export function registerImageServiceRoutes(
  router: Router,
  services: ApiServices,
): void {
  router.add("GET", "/v1/image-services", (): RouteResponse => ({
    status: 200,
    body: { items: services.imageServices.list() },
  }));

  router.add(
    "POST",
    "/v1/image-services",
    async ({ request }): Promise<RouteResponse> => {
      const body = parseBody(createImageServiceSchema, await readJsonBody(request));
      return {
        status: 201,
        body: {
          service: services.imageServices.create({
            name: body.name,
            config: body.config,
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...(body.secret === undefined ? {} : { secret: body.secret }),
          }),
        },
      };
    },
  );

  router.add(
    "PATCH",
    "/v1/image-services/:serviceId",
    async ({ request, params }): Promise<RouteResponse> => {
      const body = parseBody(updateImageServiceSchema, await readJsonBody(request));
      return {
        status: 200,
        body: {
          service: services.imageServices.update(params.serviceId ?? "", {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...(body.config === undefined ? {} : { config: body.config }),
            ...(body.secret === undefined ? {} : { secret: body.secret }),
          }),
        },
      };
    },
  );

  router.add(
    "DELETE",
    "/v1/image-services/:serviceId",
    ({ params }): RouteResponse => ({
      status: 200,
      body: services.imageServices.delete(params.serviceId ?? ""),
    }),
  );

  router.add(
    "POST",
    "/v1/image-services/probe",
    async ({ request }): Promise<RouteResponse> => {
      const body = parseBody(probeImageServiceSchema, await readJsonBody(request));
      return {
        status: 200,
        body: await services.imageServices.probeDraft({
          ...(body.serviceId === undefined ? {} : { serviceId: body.serviceId }),
          config: body.config,
          ...(body.secret === undefined ? {} : { secret: body.secret }),
          ...(body.workflow === undefined ? {} : { workflow: body.workflow }),
        }),
      };
    },
  );

  router.add(
    "POST",
    "/v1/image-services/:serviceId/probe",
    async ({ params }): Promise<RouteResponse> => ({
      status: 200,
      body: await services.imageServices.probe(params.serviceId ?? ""),
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/scene-image",
    ({ params }): RouteResponse => ({
      status: 200,
      body: services.sceneImageSettings.get(params.roleId ?? ""),
    }),
  );

  router.add(
    "PUT",
    "/v1/roles/:roleId/scene-image",
    async ({ request, params }): Promise<RouteResponse> => {
      const body = parseBody(
        sceneImageSettingsBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: services.sceneImageSettings.save(params.roleId ?? "", body),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/scene-image/probe",
    async ({ request, params }): Promise<RouteResponse> => {
      const body = parseBody(sceneImageProbeBodySchema, await readJsonBody(request));
      return {
        status: 200,
        body: await services.sceneImageSettings.probe(params.roleId ?? "", {
          ...(body.serviceId === undefined ? {} : { serviceId: body.serviceId }),
          ...(body.serviceDraft === undefined
            ? {}
            : {
                serviceDraft: {
                  ...(body.serviceDraft.serviceId === undefined
                    ? {}
                    : { serviceId: body.serviceDraft.serviceId }),
                  config: body.serviceDraft.config,
                  ...(body.serviceDraft.secret === undefined
                    ? {}
                    : { secret: body.serviceDraft.secret }),
                },
              }),
          ...(body.workflow === undefined ? {} : { workflow: body.workflow }),
        }),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/scene-image/preview",
    async ({ request, params }): Promise<RouteResponse> => {
      const body = parseBody(
        sceneImagePreviewBodySchema,
        await readJsonBody(request),
      );
      const { prompt, outfitId, serviceDraft, settings, ...flat } = body;
      const draft =
        settings !== undefined
          ? compactDraft(settings)
          : Object.values(flat).some((value) => value !== undefined)
            ? compactDraft(flat)
            : undefined;
      return {
        status: 200,
        body: await services.sceneImageSettings.preview(params.roleId ?? "", {
          ...(prompt === undefined ? {} : { prompt }),
          ...(outfitId === undefined ? {} : { outfitId }),
          ...(serviceDraft === undefined
            ? {}
            : {
                serviceDraft: {
                  ...(serviceDraft.serviceId === undefined
                    ? {}
                    : { serviceId: serviceDraft.serviceId }),
                  config: serviceDraft.config,
                  ...(serviceDraft.secret === undefined
                    ? {}
                    : { secret: serviceDraft.secret }),
                },
              }),
          ...(draft === undefined ? {} : { draft }),
        }),
      };
    },
  );
}
