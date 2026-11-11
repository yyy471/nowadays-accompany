import fs from "node:fs";
import { CliError, type HttpClient } from "./client.js";

type Options = Map<string, string>;

export async function runCli(
  argv: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [group, ...rest] = argv;
  if (group === undefined) {
    throw new CliError("COMMAND_REQUIRED", "缺少命令");
  }
  switch (group) {
    case "health":
      parseArgs(rest, []);
      return client.request("GET", "/v1/health");
    case "role":
      return runRole(rest, client);
    case "state":
      return runState(rest, client);
    case "window":
      return runWindow(rest, client);
    case "message":
      return runMessage(rest, client);
    case "input":
      return runInput(rest, client);
    case "events":
      return runEvents(rest, client);
    case "execution":
      return runExecution(rest, client);
    case "task":
      return runTask(rest, client);
    case "resource":
      return runResource(rest, client);
    case "binding":
      return runBinding(rest, client);
    case "memory":
      return runMemory(rest, client);
    case "diary":
      return runDiary(rest, client);
    case "model":
      return runModel(rest, client);
    case "autonomy":
      return runAutonomy(rest, client);
    case "activity":
      return runActivity(rest, client);
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知命令 ${group}`);
  }
}

/** 角色活动状态：配置写入前须先 stop，完成后按需 resume（DL-148）。 */
async function runActivity(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "list":
      parseArgs(rest, []);
      return client.request("GET", "/v1/activities");
    case "get": {
      const options = parseArgs(rest, ["role"]);
      const roleId = encodeURIComponent(required(options, "role"));
      return client.request("GET", `/v1/roles/${roleId}/activity`);
    }
    case "stop": {
      const options = parseArgs(rest, ["role"]);
      const roleId = encodeURIComponent(required(options, "role"));
      return client.request("POST", `/v1/roles/${roleId}/activity/stop`);
    }
    case "resume": {
      const options = parseArgs(rest, ["role"]);
      const roleId = encodeURIComponent(required(options, "role"));
      return client.request("POST", `/v1/roles/${roleId}/activity/resume`);
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知角色活动命令 ${action ?? ""}`);
  }
}

async function runRole(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "list": {
      parseArgs(rest, []);
      return client.request("GET", "/v1/roles");
    }
    case "create": {
      const options = parseArgs(rest, [
        "name",
        "definition",
        "payload",
        "state",
      ]);
      const payload =
        options.get("payload") === undefined
          ? undefined
          : parseJsonObject(options.get("payload") ?? "", "--payload");
      const state =
        options.get("state") === undefined
          ? undefined
          : parseJsonObject(options.get("state") ?? "", "--state");
      return client.request("POST", "/v1/roles", {
        displayName: required(options, "name"),
        definition: {
          text: readText(required(options, "definition")),
          ...(payload === undefined ? {} : { payload }),
        },
        ...(state === undefined ? {} : { state }),
      });
    }
    case "get": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}`,
      );
    }
    case "update": {
      const options = parseArgs(rest, [
        "role",
        "name",
        "definition",
        "payload",
        "expected-revision",
      ]);
      const roleId = required(options, "role");
      const payload =
        options.get("payload") === undefined
          ? undefined
          : parseJsonObject(options.get("payload") ?? "", "--payload");
      let definitionText =
        options.get("definition") === undefined
          ? undefined
          : readText(options.get("definition") ?? "");
      if (payload !== undefined && definitionText === undefined) {
        const current = (await client.request(
          "GET",
          `/v1/roles/${encodeURIComponent(roleId)}`,
        )) as { definition?: { text?: unknown } };
        if (typeof current.definition?.text !== "string") {
          throw new CliError(
            "INVALID_BACKEND_RESPONSE",
            "后端角色缺少设定正文",
          );
        }
        definitionText = current.definition.text;
      }
      const expectedRevision = integerOption(
        options,
        "expected-revision",
        "--expected-revision",
      );
      const displayName = options.get("name");
      if (
        displayName === undefined &&
        definitionText === undefined &&
        expectedRevision === undefined
      ) {
        throw new CliError(
          "OPTION_REQUIRED",
          "至少提供 --name、--definition 或 --payload",
        );
      }
      return client.request(
        "PATCH",
        `/v1/roles/${encodeURIComponent(roleId)}/definition`,
        {
          ...(displayName === undefined ? {} : { displayName }),
          ...(definitionText === undefined
            ? {}
            : {
                definition: {
                  text: definitionText,
                  ...(payload === undefined ? {} : { payload }),
                },
              }),
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
      );
    }
    case "initialize": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "POST",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/initialize`,
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知角色命令 ${action ?? ""}`);
  }
}

async function runState(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "get": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/state`,
      );
    }
    case "put": {
      const options = parseArgs(rest, ["role", "state", "expected-version"]);
      const state = parseJsonObject(required(options, "state"), "--state");
      const expectedVersion = integerOption(
        options,
        "expected-version",
        "--expected-version",
      );
      return client.request(
        "PUT",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/state`,
        {
          state,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        },
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知状态命令 ${action ?? ""}`);
  }
}

async function runWindow(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "create": {
      const options = parseArgs(rest, ["role", "kind", "source"]);
      const roleId = required(options, "role");
      const kind = options.get("kind");
      const source = options.get("source");
      return client.request(
        "POST",
        `/v1/roles/${encodeURIComponent(roleId)}/windows`,
        {
          ...(kind === undefined ? {} : { kind }),
          ...(source === undefined ? {} : { source }),
        },
      );
    }
    case "list": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/windows`,
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知窗口命令 ${action ?? ""}`);
  }
}

async function runMessage(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "send": {
      const options = parseArgs(rest, [
        "role",
        "window",
        "content",
        "submission-id",
        "source",
      ]);
      const roleId = required(options, "role");
      const windowId = required(options, "window");
      const source = options.get("source");
      return client.request(
        "POST",
        `/v1/roles/${encodeURIComponent(roleId)}/windows/${encodeURIComponent(windowId)}/messages`,
        {
          content: required(options, "content"),
          submissionId: required(options, "submission-id"),
          ...(source === undefined ? {} : { source }),
        },
      );
    }
    case "list": {
      const options = parseArgs(rest, [
        "role",
        "window",
        "after",
        "limit",
      ]);
      const roleId = required(options, "role");
      const windowId = required(options, "window");
      const query = new URLSearchParams();
      const after = integerOption(options, "after", "--after");
      const limit = integerOption(options, "limit", "--limit");
      if (after !== undefined) {
        query.set("after", String(after));
      }
      if (limit !== undefined) {
        query.set("limit", String(limit));
      }
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(roleId)}/windows/${encodeURIComponent(windowId)}/messages${suffix}`,
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知消息命令 ${action ?? ""}`);
  }
}

async function runInput(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "set": {
      const options = parseArgs(rest, ["role", "window", "client", "typing"]);
      const roleId = required(options, "role");
      const windowId = required(options, "window");
      const typing = required(options, "typing");
      if (typing !== "true" && typing !== "false") {
        throw new CliError("INVALID_OPTION", "--typing 必须是 true 或 false");
      }
      return client.request(
        "POST",
        `/v1/roles/${encodeURIComponent(roleId)}/windows/${encodeURIComponent(windowId)}/input-state`,
        {
          clientId: required(options, "client"),
          typing: typing === "true",
        },
      );
    }
    case "clear": {
      const options = parseArgs(rest, ["role", "window", "client"]);
      const roleId = required(options, "role");
      const windowId = required(options, "window");
      const clientId = required(options, "client");
      return client.request(
        "DELETE",
        `/v1/roles/${encodeURIComponent(roleId)}/windows/${encodeURIComponent(windowId)}/input-state?clientId=${encodeURIComponent(clientId)}`,
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知输入状态命令 ${action ?? ""}`);
  }
}

async function runEvents(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const options = parseArgs(args, ["role", "window", "after"]);
  const roleId = required(options, "role");
  const windowId = required(options, "window");
  const after = integerOption(options, "after", "--after");
  const suffix = after === undefined ? "" : `?after=${after}`;
  for await (const data of client.stream(
    `/v1/roles/${encodeURIComponent(roleId)}/windows/${encodeURIComponent(windowId)}/events${suffix}`,
  )) {
    process.stdout.write(`${data}\n`);
  }
  return { streamed: true };
}

async function runExecution(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "get": {
      const options = parseArgs(rest, ["role", "id"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/executions/${encodeURIComponent(required(options, "id"))}`,
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知执行命令 ${action ?? ""}`);
  }
}

async function runTask(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "list": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/tasks`,
      );
    }
    case "get": {
      const options = parseArgs(rest, ["role", "id"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/tasks/${encodeURIComponent(required(options, "id"))}`,
      );
    }
    case "finish": {
      const options = parseArgs(rest, ["role", "id", "status", "reason"]);
      const status = required(options, "status");
      if (status !== "completed" && status !== "failed") {
        throw new CliError(
          "INVALID_OPTION",
          "--status 必须是 completed 或 failed",
        );
      }
      return client.request(
        "POST",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/tasks/${encodeURIComponent(required(options, "id"))}/finish`,
        {
          status,
          endReason: required(options, "reason"),
        },
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知任务命令 ${action ?? ""}`);
  }
}

async function runResource(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "create": {
      const options = parseArgs(rest, ["kind", "json"]);
      const payload = parseJsonObject(required(options, "json"), "--json");
      return client.request("POST", "/v1/resources", {
        ...payload,
        kind: required(options, "kind"),
      });
    }
    case "list": {
      const options = parseArgs(rest, ["kind"]);
      const kind = options.get("kind");
      const suffix =
        kind === undefined ? "" : `?kind=${encodeURIComponent(kind)}`;
      return client.request("GET", `/v1/resources${suffix}`);
    }
    case "get": {
      const options = parseArgs(rest, ["id"]);
      return client.request(
        "GET",
        `/v1/resources/${encodeURIComponent(required(options, "id"))}`,
      );
    }
    case "update": {
      const options = parseArgs(rest, ["id", "json"]);
      return client.request(
        "PATCH",
        `/v1/resources/${encodeURIComponent(required(options, "id"))}`,
        parseJsonObject(required(options, "json"), "--json"),
      );
    }
    case "references": {
      const options = parseArgs(rest, ["id"]);
      return client.request(
        "GET",
        `/v1/resources/${encodeURIComponent(required(options, "id"))}/references`,
      );
    }
    case "delete": {
      const options = parseArgs(rest, ["id"]);
      return client.request(
        "DELETE",
        `/v1/resources/${encodeURIComponent(required(options, "id"))}`,
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知资源命令 ${action ?? ""}`);
  }
}

async function runBinding(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "get": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/bindings`,
      );
    }
    case "put": {
      const options = parseArgs(rest, ["role", "json"]);
      const body = parseJsonObject(required(options, "json"), "--json");
      return client.request(
        "PUT",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/bindings`,
        body,
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知绑定命令 ${action ?? ""}`);
  }
}

async function runMemory(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "search": {
      const options = parseArgs(rest, ["role", "json"]);
      return client.request(
        "POST",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/memory/search`,
        parseJsonObject(required(options, "json"), "--json"),
      );
    }
    case "event": {
      const options = parseArgs(rest, ["role", "id"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/memory/events/${encodeURIComponent(required(options, "id"))}`,
      );
    }
    case "evidence": {
      const options = parseArgs(rest, ["role", "id"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/memory/evidence/${encodeURIComponent(required(options, "id"))}`,
      );
    }
    case "summary": {
      const options = parseArgs(rest, ["role", "id"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/memory/summaries/${encodeURIComponent(required(options, "id"))}`,
      );
    }
    case "status": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/memory/status`,
      );
    }
    case "batches": {
      const options = parseArgs(rest, ["role", "limit"]);
      const limit = integerOption(options, "limit", "--limit");
      const suffix = limit === undefined ? "" : `?limit=${limit}`;
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/memory/batches${suffix}`,
      );
    }
    case "trigger": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "POST",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/memory/batches`,
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知记忆命令 ${action ?? ""}`);
  }
}

async function runDiary(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "list": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/diaries`,
      );
    }
    case "create": {
      const options = parseArgs(rest, [
        "role",
        "content",
        "events",
        "occurred-at",
      ]);
      const events = options.get("events");
      const occurredAt = options.get("occurred-at");
      return client.request(
        "POST",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/diaries`,
        {
          content: readText(required(options, "content")),
          ...(events === undefined
            ? {}
            : {
                eventIds: events
                  .split(",")
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0),
              }),
          ...(occurredAt === undefined ? {} : { occurredAt }),
        },
      );
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知日记命令 ${action ?? ""}`);
  }
}

async function runAutonomy(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "status": {
      const options = parseArgs(rest, ["role"]);
      return client.request(
        "GET",
        `/v1/roles/${encodeURIComponent(required(options, "role"))}/autonomy`,
      );
    }
    case "budget": {
      const [sub, ...budgetArgs] = rest;
      if (sub === "get") {
        const options = parseArgs(budgetArgs, ["role"]);
        return client.request(
          "GET",
          `/v1/roles/${encodeURIComponent(required(options, "role"))}/autonomy/budget`,
        );
      }
      if (sub === "set") {
        const options = parseArgs(budgetArgs, [
          "role",
          "limit",
          "unlimited",
        ]);
        return client.request(
          "PUT",
          `/v1/roles/${encodeURIComponent(required(options, "role"))}/autonomy/budget`,
          {
            dailyLimit: integerOption(options, "limit", "--limit") ?? 200,
            unlimited: booleanOption(options, "unlimited", false),
          },
        );
      }
      throw new CliError("UNKNOWN_COMMAND", `未知额度命令 ${sub ?? ""}`);
    }
    case "wake": {
      const [sub, ...wakeArgs] = rest;
      if (sub === "list") {
        const options = parseArgs(wakeArgs, ["role"]);
        return client.request(
          "GET",
          `/v1/roles/${encodeURIComponent(required(options, "role"))}/autonomy/wakes`,
        );
      }
      if (sub === "add") {
        const options = parseArgs(wakeArgs, ["role", "at", "intent"]);
        return client.request(
          "POST",
          `/v1/roles/${encodeURIComponent(required(options, "role"))}/autonomy/wakes`,
          {
            wakeAt: required(options, "at"),
            intent: required(options, "intent"),
          },
        );
      }
      if (sub === "cancel") {
        const options = parseArgs(wakeArgs, ["role", "wake"]);
        const roleId = required(options, "role");
        return client.request(
          "DELETE",
          `/v1/roles/${encodeURIComponent(roleId)}/autonomy/wakes/${encodeURIComponent(required(options, "wake"))}`,
        );
      }
      throw new CliError("UNKNOWN_COMMAND", `未知安排命令 ${sub ?? ""}`);
    }
    case "activity": {
      const [sub, ...activityArgs] = rest;
      if (sub === "list") {
        const options = parseArgs(activityArgs, ["role"]);
        return client.request(
          "GET",
          `/v1/roles/${encodeURIComponent(required(options, "role"))}/autonomy/activities`,
        );
      }
      throw new CliError("UNKNOWN_COMMAND", `未知活动命令 ${sub ?? ""}`);
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知自主命令 ${action ?? ""}`);
  }
}

async function runModel(
  args: readonly string[],
  client: HttpClient,
): Promise<unknown> {
  const [action, ...rest] = args;
  switch (action) {
    case "models": {
      const options = parseArgs(rest, ["json"]);
      return client.request(
        "POST",
        "/v1/model-services/models",
        parseJsonObject(required(options, "json"), "--json"),
      );
    }
    case "test": {
      const options = parseArgs(rest, ["json", "model"]);
      const config = parseJsonObject(required(options, "json"), "--json");
      return client.request("POST", "/v1/model-services/test", {
        ...config,
        model: required(options, "model"),
      });
    }
    default:
      throw new CliError("UNKNOWN_COMMAND", `未知模型命令 ${action ?? ""}`);
  }
}

function parseArgs(args: readonly string[], allowed: readonly string[]): Options {
  const options: Options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("--")) {
      throw new CliError("UNEXPECTED_ARGUMENT", `无法识别参数 ${token}`);
    }
    const name = token.slice(2);
    if (!allowed.includes(name)) {
      throw new CliError("UNKNOWN_OPTION", `无法识别选项 --${name}`);
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new CliError("OPTION_VALUE_REQUIRED", `选项 --${name} 需要值`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

function required(options: Options, name: string): string {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    throw new CliError("OPTION_REQUIRED", `缺少选项 --${name}`);
  }
  return value;
}

function readText(raw: string): string {
  if (!raw.startsWith("@")) {
    return raw;
  }
  const filePath = raw.slice(1);
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    throw new CliError("FILE_READ_FAILED", `无法读取文件 ${filePath}`);
  }
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const text = readText(raw);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CliError("INVALID_JSON_ARGUMENT", `${label} 不是有效 JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("INVALID_JSON_ARGUMENT", `${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function integerOption(
  options: Options,
  name: string,
  label: string,
): number | undefined {
  const raw = options.get(name);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new CliError("INVALID_INTEGER", `${label} 必须是整数`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CliError("INVALID_INTEGER", `${label} 超出可表示范围`);
  }
  return value;
}

function booleanOption(
  options: Options,
  name: string,
  defaultValue: boolean,
): boolean {
  const raw = options.get(name);
  if (raw === undefined) {
    return defaultValue;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new CliError("INVALID_BOOLEAN", `--${name} 必须是 true 或 false`);
}
