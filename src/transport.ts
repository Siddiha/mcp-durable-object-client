import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

// Maximum allowed message size (4MB)
const MAX_MSG_SIZE: number = 4 * 1024 * 1024;

/**
 * ServerSentEventsTransport - Provides SSE communication for edge environments
 * Compatible with Cloudflare Workers and similar platforms
 */
export class ServerSentEventsTransport implements Transport {
  // Stream controller reference
  #streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  
  // Public readable stream for SSE events
  readonly eventStream: ReadableStream<Uint8Array>;
  
  // Track connection state
  #isActive = false;
  
  // Event handlers
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  
  /**
   * Creates a new SSE transport instance
   * 
   * @param endpointUrl - URL for clients to POST messages to
   * @param sessionId - Unique session identifier
   */
  constructor(
    private readonly endpointUrl: string,
    readonly sessionId: string
  ) {
    // Initialize the SSE stream
    this.eventStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#streamController = controller;
      },
      cancel: () => {
        this.#isActive = false;
        this.onclose?.();
      }
    });
  }
  
  /**
   * Initializes the SSE connection
   */
  async start(): Promise<void> {
    if (this.#isActive) {
      throw new Error('Transport already active - cannot start again');
    }
    
    if (!this.#streamController) {
      throw new Error('Stream initialization failed - controller not available');
    }
    
    // Send endpoint information to client
    const connectionInfo = `event: endpoint\ndata: ${encodeURI(this.endpointUrl)}?sessionId=${this.sessionId}\n\n`;
    this.#streamController.enqueue(new TextEncoder().encode(connectionInfo));
    
    this.#isActive = true;
  }
  
  /**
   * Creates a properly formatted SSE response
   */
  get sseResponse(): Response {
    if (!this.eventStream) {
      throw new Error('Event stream not properly initialized');
    }
    
    return new Response(this.eventStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  }
  
  /**
   * Processes incoming HTTP POST requests
   * 
   * @param request - The incoming request object
   * @returns HTTP response
   */
  async handlePostMessage(request: Request): Promise<Response> {
    if (!this.#isActive || !this.#streamController) {
      return new Response('SSE connection not established', { status: 503 });
    }
    
    try {
      // Validate content type
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return new Response(`Invalid content type: ${contentType}`, { status: 415 });
      }
      
      // Check message size
      const contentLength = Number.parseInt(request.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_MSG_SIZE) {
        return new Response(`Message exceeds size limit (${contentLength} > ${MAX_MSG_SIZE})`, { status: 413 });
      }
      
      // Process message
      const messageData = await request.json();
      await this.handleMessage(messageData);
      
      return new Response('Message processed', { status: 202 });
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return new Response(`Error processing message: ${error instanceof Error ? error.message : String(error)}`, { status: 400 });
    }
  }
  
  /**
   * Processes a message regardless of transport method
   * 
   * @param rawMessage - The message to process
   */
  async handleMessage(rawMessage: unknown): Promise<void> {
    try {
      const validatedMessage = JSONRPCMessageSchema.parse(rawMessage);
      this.onmessage?.(validatedMessage);
    } catch (validationError) {
      const error = validationError instanceof Error 
        ? validationError 
        : new Error(String(validationError));
      
      this.onerror?.(error);
      throw error;
    }
  }
  
  /**
   * Sends a message through the SSE channel
   * 
   * @param message - The message to send
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#isActive || !this.#streamController) {
      throw new Error('Cannot send: transport not connected');
    }
    
    const formattedMessage = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    this.#streamController.enqueue(new TextEncoder().encode(formattedMessage));
  }
  
  /**
   * Closes the SSE connection
   */
  async close(): Promise<void> {
    if (this.#isActive && this.#streamController) {
      this.#streamController.close();
      this.eventStream.cancel();
      this.#isActive = false;
      this.onclose?.();
    }
  }
}