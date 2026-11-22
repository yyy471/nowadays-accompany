import type { Router } from "./router.js";
import type { ApiServices } from "./routes.js";
import type { UploadedImage } from "../domain/appearance.js";
import { HttpError, type RouteResponse } from "./errors.js";
import {
  readJsonBody,
  readMultipartForm,
  type MultipartFile,
} from "./body.js";
import { parseBody } from "./validation.js";
import {
  renameOutfitBodySchema,
  type RenameOutfitBody,
} from "./schemas.js";

export function registerAppearanceRoutes(
  router: Router,
  services: ApiServices,
): void {
  router.add(
    "GET",
    "/v1/roles/:roleId/appearance/outfits",
    ({ params }): RouteResponse => ({
      status: 200,
      body: services.appearance.list(params.roleId ?? ""),
    }),
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/appearance/outfits",
    async ({ request, params }): Promise<RouteResponse> => {
      const form = await readMultipartForm(request);
      const homes = form.files.get("home") ?? [];
      if (homes.length > 1) {
        throw new HttpError(
          400,
          "MULTIPLE_HOME_IMAGES",
          "一套服饰只能包含一张主页立绘",
        );
      }
      const sprites = form.files.get("sprites") ?? [];
      return {
        status: 201,
        body: await services.appearance.importOutfit(params.roleId ?? "", {
          name: form.fields.get("name") ?? "",
          description: form.fields.get("description") ?? null,
          home: homes[0] === undefined ? null : toImage(homes[0]),
          sprites: sprites.map(toImage),
        }),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/appearance/outfits/:outfitId/sprites",
    async ({ request, params }): Promise<RouteResponse> => {
      const form = await readMultipartForm(request);
      const sprites = form.files.get("sprite") ?? [];
      if (sprites.length !== 1) {
        throw new HttpError(
          400,
          "SPRITE_FILE_REQUIRED",
          "单张上传需要且只能包含一张 sprite 文件",
        );
      }
      return {
        status: 201,
        body: await services.appearance.addSprite(
          params.roleId ?? "",
          params.outfitId ?? "",
          toImage(sprites[0]!),
        ),
      };
    },
  );

  router.add(
    "PATCH",
    "/v1/roles/:roleId/appearance/outfits/:outfitId",
    async ({ request, params }): Promise<RouteResponse> => {
      const body = parseBody<RenameOutfitBody>(
        renameOutfitBodySchema,
        await readJsonBody(request),
      );
      return {
        status: 200,
        body: await services.appearance.renameOutfit(
          params.roleId ?? "",
          params.outfitId ?? "",
          body,
        ),
      };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/appearance/outfits/:outfitId/home",
    async ({ request, params }): Promise<RouteResponse> => {
      const form = await readMultipartForm(request);
      const homes = form.files.get("home") ?? [];
      if (homes.length !== 1) {
        throw new HttpError(
          400,
          "HOME_FILE_REQUIRED",
          "主页立绘补传或替换需要且只能包含一张 home 文件",
        );
      }
      return {
        status: 201,
        body: await services.appearance.replaceHome(
          params.roleId ?? "",
          params.outfitId ?? "",
          toImage(homes[0]!),
        ),
      };
    },
  );

  router.add(
    "DELETE",
    "/v1/roles/:roleId/appearance/outfits/:outfitId",
    ({ params }): RouteResponse => ({
      status: 200,
      body: services.appearance.deleteOutfit(
        params.roleId ?? "",
        params.outfitId ?? "",
      ),
    }),
  );

  router.add(
    "DELETE",
    "/v1/roles/:roleId/appearance/outfits/:outfitId/sprites/:assetId",
    ({ params }): RouteResponse => ({
      status: 200,
      body: services.appearance.deleteSprite(
        params.roleId ?? "",
        params.outfitId ?? "",
        params.assetId ?? "",
      ),
    }),
  );

  router.add(
    "GET",
    "/v1/roles/:roleId/appearance/assets/:assetId",
    ({ params }): RouteResponse => {
      const asset = services.appearance.readAsset(
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

function toImage(file: MultipartFile): UploadedImage {
  return { fileName: file.fileName, data: file.data };
}
