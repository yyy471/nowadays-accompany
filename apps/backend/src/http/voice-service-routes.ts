import { z } from "zod";
import { normalizeVoiceBaseUrl } from "../domain/voice.js";
import { voiceServiceConfigSchema } from "../domain/voice-service.js";
import type { Router } from "./router.js";
import type { ApiServices } from "./routes.js";
import { readJsonBody } from "./body.js";
import type { RouteResponse } from "./errors.js";
import { parseBody } from "./validation.js";

const createVoiceServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean().optional(),
    config: voiceServiceConfigSchema,
  })
  .strict();

const updateVoiceServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    config: voiceServiceConfigSchema.optional(),
  })
  .strict();

const probeVoiceServiceSchema = z
  .object({
    serviceId: z.string().trim().min(1).max(200).optional(),
    config: voiceServiceConfigSchema,
  })
  .strict();

export function registerVoiceServiceRoutes(
  router: Router,
  services: ApiServices,
): void {
  router.add("GET", "/v1/voice-services", (): RouteResponse => ({
    status: 200,
    body: { items: services.voiceServices.list() },
  }));

  router.add(
    "POST",
    "/v1/voice-services",
    async ({ request }): Promise<RouteResponse> => {
      const body = parseBody(
        createVoiceServiceSchema,
        await readJsonBody(request),
      );
      return {
        status: 201,
        body: {
          service: services.voiceServices.create({
            name: body.name,
            config: body.config,
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          }),
        },
      };
    },
  );

  router.add(
    "PATCH",
    "/v1/voice-services/:serviceId",
    async ({ request, params }): Promise<RouteResponse> => {
      const body = parseBody(
        updateVoiceServiceSchema,
        await readJsonBody(request),
      );
      const serviceId = params.serviceId ?? "";
      services.voiceServices.validateUpdate(serviceId, body);
      const current = services.voiceServices.get(serviceId);
      const next = body.config ?? current.config;
      const connectionChanged = next.protocol !== current.config.protocol || normalizeVoiceBaseUrl(next.baseUrl) !== normalizeVoiceBaseUrl(current.config.baseUrl) || (current.enabled && body.enabled === false);
      const result = await services.mediaMaintenance.update('voice', serviceId, connectionChanged, () => services.voiceServices.update(serviceId, body));
      return { status: 200, body: { service: result.value, maintenance: result.maintenance } };
    },
  );

  router.add(
    "DELETE",
    "/v1/voice-services/:serviceId",
    ({ params }): RouteResponse => ({
      status: 200,
      body: services.mediaMaintenance.remove("voice", params.serviceId ?? "", () => services.voiceServices.delete(params.serviceId ?? "")),
    }),
  );

  router.add(
    "POST",
    "/v1/voice-services/probe",
    async ({ request, response }): Promise<RouteResponse> => {
      const body = parseBody(
        probeVoiceServiceSchema,
        await readJsonBody(request),
      );
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      return {
        status: 200,
        body: await services.voiceServices.probeDraft(
          body.config,
          controller.signal,
        ),
      };
    },
  );

  router.add(
    "POST",
    "/v1/voice-services/:serviceId/probe",
    async ({ request, response, params }): Promise<RouteResponse> => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      return {
        status: 200,
        body: await services.voiceServices.probeSaved(
          params.serviceId ?? "",
          controller.signal,
        ),
      };
    },
  );
}
