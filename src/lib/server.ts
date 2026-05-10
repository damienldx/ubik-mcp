/**
 * Shared helper — create a standalone MCP stdio server.
 * Each server file calls createServer(), registers its tools, then run().
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function createMcpServer(name: string, version = "1.0.0"): McpServer & { _name: string } {
  const server = new McpServer({ name, version }) as McpServer & { _name: string };
  server._name = name;
  return server;
}

export async function runServer(server: McpServer & { _name?: string }): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${server._name ?? "mcp-server"}] running on stdio\n`);
}
