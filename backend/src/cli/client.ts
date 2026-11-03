export class CliError extends Error {
  readonly code: string;
  readonly status?: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.status = status;
  }
}

interface BackendErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export class HttpClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new CliError("INVALID_BASE_URL", "--base-url 不是有效地址");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError(
        "INVALID_BASE_URL",
        "--base-url 必须使用 http 或 https",
      );
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(
        "BACKEND_UNREACHABLE",
        `无法连接后端 ${this.baseUrl}`,
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new CliError(
          "INVALID_BACKEND_RESPONSE",
          "后端返回了无法解析的响应",
          response.status,
        );
      }
    }

    if (!response.ok) {
      const backendError = (payload as BackendErrorBody | null)?.error;
      const code =
        typeof backendError?.code === "string"
          ? backendError.code
          : "HTTP_ERROR";
      const message =
        typeof backendError?.message === "string"
          ? backendError.message
          : `后端返回状态 ${response.status}`;
      throw new CliError(code, message, response.status);
    }
    return payload;
  }
}
