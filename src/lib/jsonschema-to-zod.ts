/**
 * Convert a JSON Schema (as returned by an upstream MCP server's `tools/list`)
 * into a `ZodRawShape` — the shape format expected by `McpServer.tool()`.
 *
 * Why this exists: the gateway in src/gateway.ts re-exposes upstream tools
 * through `McpServer.tool(name, desc, shape, handler)`. If `shape` is `{}`,
 * the MCP SDK advertises an empty schema to clients AND strict-validates
 * incoming arguments — so any required-param tool fails with "X: Required"
 * because the args are stripped before reaching the handler.
 *
 * Coverage (intentionally pragmatic):
 *   - `type: object` with `properties` + `required` (top-level only)
 *   - primitives: string, number, integer, boolean
 *   - arrays with `items`
 *   - enums (strings)
 *   - description, default
 *   - optional vs required (controlled by the `required` array)
 *
 * Anything more exotic (anyOf/oneOf/allOf, $ref, nested objects) falls back
 * to `z.any()` for that field — permissive but safe: the arg passes through
 * to the upstream, which performs its own strict validation.
 */
import { z, type ZodRawShape, type ZodTypeAny } from "zod";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchema;
  [k: string]: unknown;
};

function leafToZod(prop: JsonSchema): ZodTypeAny {
  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every((v) => typeof v === "string")) {
    return z.enum(prop.enum as [string, ...string[]]);
  }

  let base: ZodTypeAny;
  switch (prop.type) {
    case "string":
      base = z.string();
      break;
    case "number":
      base = z.number();
      break;
    case "integer":
      base = z.number().int();
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "array":
      base = z.array(prop.items ? leafToZod(prop.items) : z.any());
      break;
    case "object":
      // Nested objects → z.record for permissive pass-through. Upstream validates.
      base = z.record(z.any());
      break;
    default:
      base = z.any();
  }

  if (typeof prop.description === "string") {
    base = base.describe(prop.description);
  }
  if (prop.default !== undefined) {
    base = base.default(prop.default as never);
  }
  return base;
}

export function jsonSchemaToZodShape(schema: unknown): ZodRawShape {
  if (!schema || typeof schema !== "object") return {};
  const s = schema as JsonSchema;
  if (s.type !== "object" || !s.properties) return {};

  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const shape: ZodRawShape = {};

  for (const [key, propSchema] of Object.entries(s.properties)) {
    let field = leafToZod(propSchema);
    if (!required.has(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return shape;
}
