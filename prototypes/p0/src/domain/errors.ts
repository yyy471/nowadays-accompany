export interface SerializedError {
  name: string;
  message: string;
  code?: string;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return {
    name: "NonErrorThrown",
    message: typeof error === "string" ? error : JSON.stringify(error),
  };
}
