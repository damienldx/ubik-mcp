/**
 * Shared helper — create a standalone MCP stdio server.
 * Each server file calls createServer(), registers its tools, then run().
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function createMcpServer(name: string, version = "1.0.0"): McpServer {
  return new McpServer({ name, version });
}

export async function runServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${server.name}] running on stdio\n`);
}
