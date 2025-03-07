import {
  type AgentNamespace,
  routeAgentRequest,
  type Schedule,
} from "agents-sdk";
import { AIChatAgent } from "agents-sdk/ai-chat-agent";
import { jsonSchemaToZod, type JsonSchemaObject } from '@n8n/json-schema-to-zod';
import {
  createDataStreamResponse,
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  tool,
  type ToolSet,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { processToolCalls } from "./utils";
import { tools, executions } from "./tools";
import { AsyncLocalStorage } from "node:async_hooks";

// Override with a compatible version for Cloudflare Workers
const originalFetch = global.fetch;

global.fetch = (url, options = {}) => {
  const workerOptions = { ...options };
  // Remove unsupported properties
  // @ts-ignore
  // biome-ignore lint/performance/noDelete: <explanation>
  delete workerOptions.mode;
  
  // Call the original fetch with fixed options
  return originalFetch(url, workerOptions);
};

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z, type ZodRawShape } from "zod";

// Environment variables type definition
export type Env = {
  OPENAI_API_KEY: string;
  Chat: AgentNamespace<Chat>;
};

// We use ALS to expose the agent context to the tools
export const agentContext = new AsyncLocalStorage<Chat>();

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env> {
  /**
   * MCP client instance
   */
  private mcpClient: Client | null = null;
  
  /**
   * MCP transport instance
   */
  private mcpTransport: SSEClientTransport | null = null;
  
  /**
   * Flag to track if we've attempted connection
   */
  private mcpConnectionAttempted = false;
  
  /**
   * Available tools from the MCP server
   */
  private mcpTools: ToolSet = {};

  /**
   * Connect to the MCP server
   */
  private async connectToMcpServer(): Promise<boolean> {
    // Don't attempt connection more than once per instance
    if (this.mcpConnectionAttempted) {
      return this.mcpClient !== null;
    }
    
    this.mcpConnectionAttempted = true;
    
    try {
      console.log("Connecting to MCP server...");
      
      // Initialize the transport with proper URL
      this.mcpTransport = new SSEClientTransport(new URL("http://localhost:8008/sse"));
      
      // Initialize the client
      this.mcpClient = new Client(
        {
          name: "cloudflare-durable-object-client",
          version: "1.0.0"
        }, 
        {}
      );
      
      // Connect to the server
      await this.mcpClient.connect(this.mcpTransport);
      
      // Get server capabilities
      const capabilities = await this.mcpClient.getServerCapabilities();
      console.log("MCP Server capabilities:", capabilities);
      
      // Fetch available tools
      const toolsResponse = await this.mcpClient.listTools();
      // @ts-ignore one life
      this.mcpTools = toolsResponse.tools || {} as ToolSet;
      console.log(`Found ${this.mcpTools.length} tools:`, this.mcpTools);
      
      return true;
    } catch (error) {
      console.error("Failed to connect to MCP server:", error);
      this.mcpClient = null;
      this.mcpTransport = null;
      return false;
    }
  }

  // biome-ignore lint/complexity/noBannedTypes: <explanation>
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    // Create a streaming response that handles both text and tool outputs
    return agentContext.run(this, async () => {
      // Connect to MCP server if not already connected
      const mcpConnected = await this.connectToMcpServer();
      
      if (mcpConnected) {
        console.log("Successfully connected to MCP server");
      } else {
        console.warn("MCP server connection failed, proceeding without MCP capabilities");
      }

      const dataStreamResponse = createDataStreamResponse({
        execute: async (dataStream) => {

          if (this.mcpClient && mcpConnected) {
            try {
              const toolsMcp = await this.mcpClient.listTools();

              console.log("Tools MCP: ", JSON.stringify(toolsMcp, null, 2));

              this.mcpTools = toolsMcp.tools.reduce((acc, i) => {
                acc[i.name] = tool({
                  description: i.description,
                  parameters: jsonSchemaToZod(i.inputSchema as JsonSchemaObject),
                  execute: async (args) => {
                    const result = await this.mcpClient?.callTool({
                      name: i.name,
                      arguments: args,
                    });
                    return result;
                  },
                });
                return acc;
              }, {} as ToolSet);
              console.log("MCP tools refreshed:", Object.keys(this.mcpTools));
            } catch (error) {
              console.error("Error fetching MCP tools:", error);
            }
          }

          // // Process any pending tool calls from previous messages
          // // This handles human-in-the-loop confirmations for tools
          const processedMessages = await processToolCalls({
            messages: this.messages,
            dataStream,
            tools: { ...tools, ...this.mcpTools },
            executions,
          });

          // Initialize OpenAI client with API key from environment
          const openai = createOpenAI({
            apiKey: this.env.OPENAI_API_KEY,
          });
          

          try {
            // Stream the AI response using GPT-4
            const result = streamText({
              model: openai("gpt-4o-mini"),
              system: `
                You are a helpful assistant that can do various tasks. If the user asks, then you can also schedule tasks to be executed later. 
                The input may have a date/time/cron pattern to be input as an object into a scheduler.
                The time is now: ${new Date().toISOString()}.
                ${mcpConnected ? `You also have access to the following MCP tools: ${JSON.stringify(Object.keys(this.mcpTools))}` : ''}
              `,
              messages: processedMessages,
              tools: { ...tools, ...this.mcpTools },
              onFinish,
              maxSteps: 10,
              onError: (error) => {
                console.error("Error streaming AI response:", error);
              }
            });
            result.mergeIntoDataStream(dataStream);
          } catch (error) {
            console.error("Error streaming AI response:", error);
          }
        },
      });

      return dataStreamResponse;
    });
  }

  async executeTask(description: string, task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        content: `scheduled message: ${description}`,
      },
    ]);
  }
  
  /**
   * Clean up resources when the Durable Object is about to be destroyed
   */
  async cleanup() {
    if (this.mcpClient) {
      try {
        console.log("Closing MCP client connection...");
        await this.mcpClient.close();
      } catch (error) {
        console.error("Error closing MCP client:", error);
      } finally {
        this.mcpClient = null;
        this.mcpTransport = null;
      }
    }
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
      return new Response("OPENAI_API_KEY is not set", { status: 500 });
    }
    
    // Register cleanup callback for when the DO is about to be destroyed
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(
        (async () => {
          const url = new URL(request.url);
          if (url.pathname === "/__cleanup") {
            // Get the DO instance
            const id = url.searchParams.get("id");
            if (id) {
              const doId = env.Chat.idFromString(id);
              const chat = env.Chat.get(doId);
              // Call cleanup
              await chat.cleanup();
              return new Response("Cleanup complete", { status: 200 });
            }
          }
        })()
      );
    }
    
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;