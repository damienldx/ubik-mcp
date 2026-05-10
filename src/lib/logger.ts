import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "development"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
  base: { service: "ubik" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Create child loggers for different modules
export const dbLogger = logger.child({ module: "db" });
export const authLogger = logger.child({ module: "auth" });
export const mcpLogger = logger.child({ module: "mcp" });
export const wsLogger = logger.child({ module: "websocket" });
export const apiLogger = logger.child({ module: "api" });
