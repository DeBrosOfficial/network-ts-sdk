import { HttpClient } from "../core/http";
import { WSClient, WSClientConfig } from "../core/ws";

export interface Message {
  data: string;
  topic: string;
  timestamp: number;
}

export interface RawEnvelope {
  data: string; // base64-encoded
  timestamp: number;
  topic: string;
}

// Cross-platform base64 encoding/decoding utilities
function base64Encode(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str).toString("base64");
  } else if (typeof btoa !== "undefined") {
    return btoa(
      encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
  }
  throw new Error("No base64 encoding method available");
}

function base64EncodeBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  } else if (typeof btoa !== "undefined") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  throw new Error("No base64 encoding method available");
}

function base64Decode(b64: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(b64, "base64").toString("utf-8");
  } else if (typeof atob !== "undefined") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
  throw new Error("No base64 decoding method available");
}

export type MessageHandler = (message: Message) => void;
export type ErrorHandler = (error: Error) => void;
export type CloseHandler = () => void;

/**
 * Simple PubSub client - one WebSocket connection per topic
 * No connection pooling, no reference counting - keep it simple
 */
export class PubSubClient {
  private httpClient: HttpClient;
  private wsConfig: Partial<WSClientConfig>;

  constructor(httpClient: HttpClient, wsConfig: Partial<WSClientConfig> = {}) {
    this.httpClient = httpClient;
    this.wsConfig = wsConfig;
  }

  /**
   * Publish a message to a topic via HTTP
   */
  async publish(topic: string, data: string | Uint8Array): Promise<void> {
    let dataBase64: string;
    if (typeof data === "string") {
      dataBase64 = base64Encode(data);
    } else {
      dataBase64 = base64EncodeBytes(data);
    }

    await this.httpClient.post(
      "/v1/pubsub/publish",
      {
        topic,
        data_base64: dataBase64,
      },
      {
        timeout: 30000,
      }
    );
  }

  /**
   * List active topics in the current namespace
   */
  async topics(): Promise<string[]> {
    const response = await this.httpClient.get<{ topics: string[] }>(
      "/v1/pubsub/topics"
    );
    return response.topics || [];
  }

  /**
   * Subscribe to a topic via WebSocket
   * Creates one WebSocket connection per topic
   */
  async subscribe(
    topic: string,
    handlers: {
      onMessage?: MessageHandler;
      onError?: ErrorHandler;
      onClose?: CloseHandler;
    } = {}
  ): Promise<Subscription> {
    // Build WebSocket URL for this topic
    const wsUrl = new URL(this.wsConfig.wsURL || "ws://127.0.0.1:6001");
    wsUrl.pathname = "/v1/pubsub/ws";
    wsUrl.searchParams.set("topic", topic);

    const authToken = this.httpClient.getApiKey() ?? this.httpClient.getToken();

    // Create WebSocket client
    const wsClient = new WSClient({
      ...this.wsConfig,
      wsURL: wsUrl.toString(),
      authToken,
    });

    await wsClient.connect();

    // Create subscription wrapper
    const subscription = new Subscription(wsClient, topic);

    if (handlers.onMessage) {
      subscription.onMessage(handlers.onMessage);
    }
    if (handlers.onError) {
      subscription.onError(handlers.onError);
    }
    if (handlers.onClose) {
      subscription.onClose(handlers.onClose);
    }

    return subscription;
  }
}

/**
 * Subscription represents an active WebSocket subscription to a topic
 */
export class Subscription {
  private wsClient: WSClient;
  private topic: string;
  private messageHandlers: Set<MessageHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private closeHandlers: Set<CloseHandler> = new Set();
  private isClosed = false;
  private wsMessageHandler: ((data: string) => void) | null = null;
  private wsErrorHandler: ((error: Error) => void) | null = null;
  private wsCloseHandler: (() => void) | null = null;

  constructor(wsClient: WSClient, topic: string) {
    this.wsClient = wsClient;
    this.topic = topic;

    // Register message handler
    this.wsMessageHandler = (data) => {
      try {
        // Parse gateway JSON envelope: {data: base64String, timestamp, topic}
        const envelope: RawEnvelope = JSON.parse(data);

        // Validate envelope structure
        if (!envelope || typeof envelope !== "object") {
          throw new Error("Invalid envelope: not an object");
        }
        if (!envelope.data || typeof envelope.data !== "string") {
          throw new Error("Invalid envelope: missing or invalid data field");
        }
        if (!envelope.topic || typeof envelope.topic !== "string") {
          throw new Error("Invalid envelope: missing or invalid topic field");
        }
        if (typeof envelope.timestamp !== "number") {
          throw new Error(
            "Invalid envelope: missing or invalid timestamp field"
          );
        }

        // Decode base64 data
        const messageData = base64Decode(envelope.data);

        const message: Message = {
          topic: envelope.topic,
          data: messageData,
          timestamp: envelope.timestamp,
        };

        console.log("[Subscription] Received message on topic:", this.topic);
        this.messageHandlers.forEach((handler) => handler(message));
      } catch (error) {
        console.error("[Subscription] Error processing message:", error);
        this.errorHandlers.forEach((handler) =>
          handler(error instanceof Error ? error : new Error(String(error)))
        );
      }
    };

    this.wsClient.onMessage(this.wsMessageHandler);

    // Register error handler
    this.wsErrorHandler = (error) => {
      this.errorHandlers.forEach((handler) => handler(error));
    };
    this.wsClient.onError(this.wsErrorHandler);

    // Register close handler
    this.wsCloseHandler = () => {
      this.closeHandlers.forEach((handler) => handler());
    };
    this.wsClient.onClose(this.wsCloseHandler);
  }

  /**
   * Register message handler
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Register error handler
   */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Register close handler
   */
  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * Close subscription and underlying WebSocket
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    // Remove handlers from WSClient
    if (this.wsMessageHandler) {
      this.wsClient.offMessage(this.wsMessageHandler);
      this.wsMessageHandler = null;
    }
    if (this.wsErrorHandler) {
      this.wsClient.offError(this.wsErrorHandler);
      this.wsErrorHandler = null;
    }
    if (this.wsCloseHandler) {
      this.wsClient.offClose(this.wsCloseHandler);
      this.wsCloseHandler = null;
    }

    // Clear all local handlers
    this.messageHandlers.clear();
    this.errorHandlers.clear();
    this.closeHandlers.clear();

    // Close WebSocket connection
    this.wsClient.close();
  }

  /**
   * Check if subscription is active
   */
  isConnected(): boolean {
    return !this.isClosed && this.wsClient.isConnected();
  }
}
