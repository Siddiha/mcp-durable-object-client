import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();

const port = 8008;

let servers: McpServer[] = [];

app.get("/sse", async (req, res) => {
      console.log("Got new SSE connection");

      const transport = new SSEServerTransport("/message", res);
      const server = new McpServer(
        {
          name: "mcp-typescript test server",
          version: "0.1.0",
        },
      );

      server.resource(
        "config",
        "config://app",
        async (uri) => ({
          contents: [{
            uri: uri.href,
            text: "App configuration here"
          }]
        })
      );

      server.tool("add",
        { a: z.number(), b: z.number() },
        async ({ a, b }) => ({
          content: [{ type: "text", text: String(a + b) }]
        })
      );

      servers.push(server);

      server.server.onclose = () => {
        console.log("SSE connection closed");
        servers = servers.filter((s) => s !== server);
      };

      await server.connect(transport);
    });

    app.post("/message", async (req, res) => {
      console.log("Received message");

      const sessionId = req.query.sessionId as string;
      const transport = servers
        .map((s) => s.server.transport as SSEServerTransport)
        .find((t) => t.sessionId === sessionId);
      if (!transport) {
        res.status(404).send("Session not found");
        return;
      }

      await transport.handlePostMessage(req, res);
    });

    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}/sse`);
    });