import type { Router } from "./router.js";
import type { ApiServices } from "./routes.js";
import { readJsonBody, readMultipartForm } from "./body.js";
import { HttpError, type RouteResponse } from "./errors.js";
import { parseBody } from "./validation.js";
import {
  createImageServiceSchema,
  probeImageServiceSchema,
  sceneImageAnchorPromptBodySchema,
  sceneImagePreviewBodySchema,
  sceneImageProbeBodySchema,
  sceneImageSettingsBodySchema,
  updateImageServiceSchema,
} from "./schemas.js";
import type { UploadedImage } from "../domain/appearance.js";
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

  const referenceRoute = "/v1/roles/:roleId/scene-image/outfits/:outfitId/reference";
  router.add("GET", "/v1/roles/:roleId/scene-image/references", ({ params }) => ({
    status: 200, body: services.sceneImageSettings.listReferences(params.roleId ?? ""),
  }));
  router.add("GET", referenceRoute, ({ params }) => {
    const ref = services.sceneImageSettings.readReference(params.roleId ?? "", params.outfitId ?? "");
    return { status: 200, contentType: ref.mediaType, body: ref.data, cacheControl: "no-store" };
  });
  router.add("PUT", referenceRoute, async ({ params, request }) => {
    const form = await readMultipartForm(request);
    const images = form.files.get("image") ?? [];
    if (images.length !== 1 || form.files.size !== 1) throw new HttpError(400, "SCENE_REFERENCE_REQUIRED", "请上传一张服饰参考图");
    return { status: 200, body: await services.sceneImageSettings.uploadReference(params.roleId ?? "", params.outfitId ?? "", images[0]!) };
  });
  router.add("DELETE", referenceRoute, ({ params }) => {
    services.sceneImageSettings.deleteReference(params.roleId ?? "", params.outfitId ?? "");
    return { status: 200, body: { removed: true } };
  });
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
      const serviceId = params.serviceId ?? "";
      const connectionChanged = services.imageServices.connectionChanged(serviceId, body);
      const result = await services.mediaMaintenance.update('image', serviceId, connectionChanged, () => services.imageServices.update(serviceId, body));
      return { status: 200, body: { service: result.value, maintenance: result.maintenance } };
    },
  );

  router.add(
    "DELETE",
    "/v1/image-services/:serviceId",
    ({ params }): RouteResponse => ({
      status: 200,
      body: services.mediaMaintenance.remove("image", params.serviceId ?? "", () => services.imageServices.delete(params.serviceId ?? "")),
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

  router.add(
    "POST",
    "/v1/roles/:roleId/scene-image/anchor-prompts",
    async ({ request, params }): Promise<RouteResponse> => {
      const { body, uploadedImage } = await readAnchorPromptRequest(request);
      return {
        status: 200,
        body: await services.sceneImageSettings.generateAnchorPrompt(
          params.roleId ?? "",
          {
            target: body.target,
            ...(body.outfitId === undefined ? {} : { outfitId: body.outfitId }),
            ...(body.previousPrompt === undefined
              ? {}
              : { previousPrompt: body.previousPrompt }),
            ...(uploadedImage === undefined ? {} : { uploadedImage }),
          },
        ),
      };
    },
  );
}

async function readAnchorPromptRequest(request: Parameters<typeof readJsonBody>[0]): Promise<{
  body: {
    target: "base" | "outfit";
    outfitId?: string | undefined;
    previousPrompt?: string | undefined;
  };
  uploadedImage?: UploadedImage;
}> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType === "string" &&
    contentType.toLowerCase().startsWith("multipart/form-data")
  ) {
    const form = await readMultipartForm(request);
    const files = form.files.get("image") ?? [];
    if (files.length > 1) {
      throw new HttpError(
        400,
        "MULTIPLE_ANCHOR_IMAGES",
        "一次只能上传一张参考图片",
      );
    }
    let rawPayload: unknown;
    const payloadText = form.fields.get("payload");
    if (payloadText !== undefined) {
      try {
        rawPayload = JSON.parse(payloadText) as unknown;
      } catch {
        throw new HttpError(400, "INVALID_JSON", "payload 字段不是有效 JSON");
      }
    } else {
      const target = form.fields.get("target");
      const outfitId = form.fields.get("outfitId");
      const previousPrompt = form.fields.get("previousPrompt");
      rawPayload = {
        ...(target === undefined ? {} : { target }),
        ...(outfitId === undefined || outfitId === "" ? {} : { outfitId }),
        ...(previousPrompt === undefined ? {} : { previousPrompt }),
      };
    }
    const body = parseBody(sceneImageAnchorPromptBodySchema, rawPayload);
    const imageFile = files[0];
    return {
      body,
      ...(imageFile === undefined
        ? {}
        : {
            uploadedImage: {
              fileName: imageFile.fileName,
              data: imageFile.data,
            },
          }),
    };
  }
  const body = parseBody(
    sceneImageAnchorPromptBodySchema,
    await readJsonBody(request),
  );
  return { body };
}
