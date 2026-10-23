export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  fields?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  readonly scope: string;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|password|passwd|cookie|authorization|api[-_]?key/i;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  return redactValue(fields, 0) as Record<string, unknown>;
}

const defaultSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'warn') console.error(line);
  else console.log(line);
};

export function createLogger(options: {
  scope: string;
  level?: LogLevel;
  sink?: LogSink;
}): Logger {
  const threshold = LEVEL_WEIGHT[options.level ?? 'info'];
  const sink = options.sink ?? defaultSink;

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      scope: options.scope,
      message
    };
    const redacted = redactFields(fields);
    if (redacted) record.fields = redacted;
    sink(record);
  };

  return {
    scope: options.scope,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (scope) => createLogger({ scope: `${options.scope}/${scope}`, level: options.level, sink })
  };
}

export function silentLogger(scope = 'test'): Logger {
  return createLogger({ scope, level: 'error', sink: () => {} });
}
