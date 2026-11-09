import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  voiceCapabilitiesSchema,
  voiceLanguageCodeSchema,
} from "../domain/voice-capabilities.js";
import type { Router } from "./router.js";
import type { ApiServices } from "./routes.js";
import { readJsonBody, readMultipartForm } from "./body.js";
import { HttpError, type RouteResponse } from "./errors.js";
import { parseBody } from "./validation.js";

const voiceProtocolSchema = z.enum(["indextts", "nowadays-tts-v1"]);
const voiceSpeedSchema = z.number().min(0.1).max(10);

const voiceSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reference"),
      referenceAssetId: z.string().min(1).max(200).nullable().optional(),
      referenceMode: z.string().min(1).max(100).nullable().optional(),
      referenceText: z.string().min(1).max(2000).nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("preset"),
      voiceId: z.string().min(1).max(200),
    })
    .strict(),
]);

const voiceCandidateShape = {
  baseUrl: z.string().min(1).max(2000).optional(),
  protocol: voiceProtocolSchema.optional(),
  voiceSource: voiceSourceSchema.optional(),
  referenceAssetId: z.string().min(1).max(200).nullable().optional(),
  capabilities: voiceCapabilitiesSchema.nullable().optional(),
  language: voiceLanguageCodeSchema.optional(),
  speed: voiceSpeedSchema.optional(),
  emoAlpha: z.number().min(0).max(1).optional(),
} as const;

const voiceCandidateSchema = z.object(voiceCandidateShape).strict();

const flatCandidateKeys = [
  "baseUrl",
  "protocol",
  "voiceSource",
  "referenceAssetId",
  "capabilities",
  "language",
  "speed",
  "emoAlpha",
] as const;

const saveVoiceSchema = z
  .object({
    ...voiceCandidateShape,
    baseUrl: z.string().min(1).max(2000),
  })
  .strict();

const previewVoiceSchema = z
  .object({
    text: z.string().min(1).max(4000),
    config: voiceCandidateSchema.optional(),
    ...voiceCandidateShape,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.config === undefined) {
      return;
    }
    if (flatCandidateKeys.some((key) => value[key] !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message: "config 不能与平铺候选字段同时使用",
      });
    }
  });

const probeVoiceSchema = z
  .object({
    baseUrl: z.string().min(1).max(2000),
  })
  .strict();

export function registerVoiceRoutes(
  router: Router,
  services: ApiServices,
): void {
  router.add(
    "GET",
    "/v1/roles/:roleId/voice",
    ({ params }): RouteResponse => ({
      status: 200,
      body: services.voice.getVoice(params.roleId ?? ""),
    }),
  );

  router.add(
    "PUT",
    "/v1/roles/:roleId/voice",
    async ({ request, params }): Promise<RouteResponse> => {
      const body = parseBody(saveVoiceSchema, await readJsonBody(request));
      return {
        status: 200,
        body: services.voice.saveVoice(params.roleId ?? "", body),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/voice/probe",
    async ({ request, response, params }): Promise<RouteResponse> => {
      const body = parseBody(probeVoiceSchema, await readJsonBody(request));
      return {
        status: 200,
        body: await services.voice.probe(
          params.roleId ?? "",
          body.baseUrl,
          abortSignalFor(request, response),
        ),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/voice/reference",
    async ({ request, params }): Promise<RouteResponse> => {
      const form = await readMultipartForm(request);
      const files = form.files.get("file") ?? [];
      if (files.length !== 1) {
        throw new HttpError(
          400,
          "VOICE_REFERENCE_FILE_REQUIRED",
          "需要且只能上传一个参考音频文件",
        );
      }
      return {
        status: 201,
        body: services.voice.importReference(params.roleId ?? "", {
          fileName: files[0]!.fileName,
          data: files[0]!.data,
        }),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/voice/preview",
    async ({ request, response, params }): Promise<RouteResponse> => {
      const body = parseBody(previewVoiceSchema, await readJsonBody(request));
      const { text, config, ...flat } = body;
      const audio = await services.voice.preview(
        params.roleId ?? "",
        { text, ...(config ?? flat) },
        abortSignalFor(request, response),
      );
      return {
        status: 200,
        contentType: audio.mediaType,
        body: audio.data,
        cacheControl: "no-store",
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/windows/:windowId/segments/:segmentId/speech",
    async ({ request, response, params }): Promise<RouteResponse> => {
      const audio = await services.voice.synthesizeSegment(
        params.roleId ?? "",
        params.windowId ?? "",
        params.segmentId ?? "",
        abortSignalFor(request, response),
      );
      return {
        status: 200,
        contentType: audio.mediaType,
        body: audio.data,
        cacheControl: "no-store",
      };
    },
  );
}

function abortSignalFor(
  request: IncomingMessage,
  response: ServerResponse,
): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  return controller.signal;
}
