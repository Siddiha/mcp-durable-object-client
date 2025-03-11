import { DurableObject } from 'cloudflare:workers'
import { ServerSentEventsTransport } from './transport'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Env } from './server'


const ALL_TOOLS: Tool[] = [{
    name: "add",
    inputSchema: {
        type: "object",
        properties: {
            a: { type: "number" },
            b: { type: "number" },
        }
    }
}]

const log = (...args: unknown[]) => console.error(...args)

const HANDLER = async (request: CallToolRequest) => {
    const {a, b} = request.params.arguments as {a: number, b: number}
    return {
        toolResult: {
            content: [{ type: "text", text: `Hello, world! ${a + b}` }],
        },
    }
}
export function createMcpServer(ctx: DurableObjectState) {
    const server = new Server(
        { name: 'cloudflare', version: '1.0.0' },
        { capabilities: { tools: {} } },
    )

    // Handle list tools request
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return { tools: ALL_TOOLS }
    })

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return HANDLER(request)
    })

    return server
}

export class McpObject extends DurableObject {
    private transport?: ServerSentEventsTransport
    private server: Server

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.server = createMcpServer(ctx)
    }


    override async fetch(request: Request) {
        const url = new URL(request.url)

        // Create the transport if it doesn't exist
        if (!this.transport) {
            const messageUrl = `${url.origin}${url.pathname.replace('sse', 'message')}`
            this.transport = new ServerSentEventsTransport(messageUrl, this.ctx.id.toString())
        }

        if (request.method === 'GET' && url.pathname.endsWith('/sse')) {
            await this.server.connect(this.transport)
            return this.transport.sseResponse
        }

        if (request.method === 'POST' && url.pathname.endsWith('/message')) {
            return this.transport.handlePostMessage(request)
        }

        return new Response('Not found', { status: 404 })
    }
}
