import fs from "node:fs";
import path from "node:path";
import { ModelCredentialUnavailableError } from "../domain/errors.js";

export function resolveCredential(
  appRoot: string,
  reference: string | undefined,
): string | undefined {
  if (reference === undefined) {
    return undefined;
  }
  const separator = reference.indexOf(":");
  const kind = reference.slice(0, separator);
  const target = reference.slice(separator + 1);
  if (kind === "env") {
    const value = process.env[target];
    if (value === undefined || value.length === 0) {
      throw new ModelCredentialUnavailableError(reference);
    }
    return value;
  }
  if (kind === "file") {
    const root = path.resolve(appRoot);
    const filePath = path.resolve(root, target);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      throw new ModelCredentialUnavailableError(reference);
    }
    try {
      const value = fs.readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
      if (value.length === 0) {
        throw new ModelCredentialUnavailableError(reference);
      }
      return value;
    } catch (error) {
      if (error instanceof ModelCredentialUnavailableError) {
        throw error;
      }
      throw new ModelCredentialUnavailableError(reference);
    }
  }
  throw new ModelCredentialUnavailableError(reference);
}
