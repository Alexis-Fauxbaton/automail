/**
 * Minimal structured logger.
 *
 * Every log line is one JSON object on stdout (info/debug/warn) or stderr
 * (error). The `shop` field is mandatory — that is the whole point of this
 * wrapper. Without it, prod logs cannot be filtered to a single merchant
 * and triaging a support ticket means grepping the entire backend.
 *
 * Usage:
 *   const log = createLogger({ shop, mod: "orchestrator" });
 *   log.error({ err }, "Shopify search failed");
 *
 * Pass `correlationId` at request/job boundaries so every log line emitted
 * downstream carries the same id. Use `child` to layer extra context
 * (e.g. canonical thread id) without losing the parent fields.
 */

import { sanitizeError, sanitizeText, type SanitizedError } from "./sanitize";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  shop: string;
  mod: string;
  correlationId?: string;
  [key: string]: unknown;
}

interface LogPayload {
  err?: unknown;
  [key: string]: unknown;
}

export interface Logger {
  debug(payload: LogPayload | string, msg?: string): void;
  info(payload: LogPayload | string, msg?: string): void;
  warn(payload: LogPayload | string, msg?: string): void;
  error(payload: LogPayload | string, msg?: string): void;
  child(extra: Record<string, unknown>): Logger;
}

interface SerializedLine {
  ts: string;
  level: LogLevel;
  shop: string;
  mod: string;
  msg: string;
  correlationId?: string;
  err?: SanitizedError;
  [key: string]: unknown;
}

function emit(level: LogLevel, line: SerializedLine): void {
  const json = JSON.stringify(line);
  if (level === "error") {
    console.error(json);
  } else {
    console.log(json);
  }
}

function buildLine(
  level: LogLevel,
  ctx: LogContext,
  payload: LogPayload | string,
  msg?: string,
): SerializedLine {
  const isString = typeof payload === "string";
  const message = isString ? payload : msg ?? "";
  const extras: Record<string, unknown> = isString ? {} : { ...payload };
  const err = extras.err;
  delete extras.err;

  const line: SerializedLine = {
    ts: new Date().toISOString(),
    level,
    shop: ctx.shop,
    mod: ctx.mod,
    msg: sanitizeText(message),
    ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...stripCtxFields(ctx),
    ...extras,
  };

  if (err !== undefined) {
    line.err = sanitizeError(err);
  }

  return line;
}

/** Drop the ctx fields already projected into top-level keys. */
function stripCtxFields(ctx: LogContext): Record<string, unknown> {
  const { shop: _s, mod: _m, correlationId: _c, ...rest } = ctx;
  return rest;
}

export function createLogger(ctx: LogContext): Logger {
  if (!ctx.shop) {
    // Fail loud in dev, fail safe in prod: log a warning to stderr and
    // tag the line so it stands out in any aggregator.
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        shop: "<missing>",
        mod: ctx.mod || "<unknown>",
        msg: "createLogger called without shop — this is a bug",
      }),
    );
  }

  return {
    debug(payload, msg) {
      emit("debug", buildLine("debug", ctx, payload, msg));
    },
    info(payload, msg) {
      emit("info", buildLine("info", ctx, payload, msg));
    },
    warn(payload, msg) {
      emit("warn", buildLine("warn", ctx, payload, msg));
    },
    error(payload, msg) {
      emit("error", buildLine("error", ctx, payload, msg));
    },
    child(extra) {
      return createLogger({ ...ctx, ...extra });
    },
  };
}
