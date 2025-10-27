import { HttpClient } from "../core/http";
import { WSClient, WSClientConfig } from "../core/ws";

export interface Message {
  data: string;
  topic: string;
  timestamp?: number;
}

// Cross-platform base64 encoding/decoding utilities
function base64Encode(str: string): string {
  if (typeof Buffer !== "undefined") {
    // Node.js environment
    return Buffer.from(str).toString("base64");
  } else if (typeof btoa !== "undefined") {
    // Browser/React Native environment
    return btoa(
      encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
  }
  throw new Error("No base64 encoding method available");
}

function base64Decode(b64: string): string {
  if (typeof Buffer !== "undefined") {
    // Node.js environment
    return Buffer.from(b64, "base64").toString("utf-8");
  } else if (typeof atob !== "undefined") {
    // Browser/React Native environment
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

export class PubSubClient {
  private httpClient: HttpClient;
  private wsConfig: Partial<WSClientConfig>;

  constructor(httpClient: HttpClient, wsConfig: Partial<WSClientConfig> = {}) {
    this.httpClient = httpClient;
    this.wsConfig = wsConfig;
  }

  /**
   * Publish a message to a topic.
   */
  async publish(topic: string, data: string | Uint8Array): Promise<void> {
    let dataBase64: string;
    if (typeof data === "string") {
      dataBase64 = base64Encode(data);
    } else {
      // Convert Uint8Array to string first
      const decoder = new TextDecoder();
      const str = decoder.decode(data);
      dataBase64 = base64Encode(str);
    }

    await this.httpClient.post("/v1/pubsub/publish", {
      topic,
      data_base64: dataBase64,
    });
  }

  /**
   * List active topics in the current namespace.
   */
  async topics(): Promise<string[]> {
    const response = await this.httpClient.get<{ topics: string[] }>(
      "/v1/pubsub/topics"
    );
    return response.topics || [];
  }

  /**
   * Subscribe to a topic via WebSocket.
   * Returns a subscription object with event handlers.
   */
  async subscribe(
    topic: string,
    handlers: {
      onMessage?: MessageHandler;
      onError?: ErrorHandler;
      onClose?: CloseHandler;
    } = {}
  ): Promise<Subscription> {
    const wsUrl = new URL(this.wsConfig.wsURL || "ws://localhost:6001");
    wsUrl.pathname = "/v1/pubsub/ws";
    wsUrl.searchParams.set("topic", topic);

    const wsClient = new WSClient({
      ...this.wsConfig,
      wsURL: wsUrl.toString(),
      authToken: this.httpClient.getToken(),
    });

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

    await wsClient.connect();
    return subscription;
  }
}

export class Subscription {
  private wsClient: WSClient;
  private topic: string;
  private messageHandlers: Set<MessageHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private closeHandlers: Set<CloseHandler> = new Set();

  constructor(wsClient: WSClient, topic: string) {
    this.wsClient = wsClient;
    this.topic = topic;

    this.wsClient.onMessage((data) => {
      try {
        let messageData = data;

        // Parse gateway JSON envelope: {data: base64String, timestamp, topic}
        try {
          const envelope = JSON.parse(data);
          if (envelope.data && typeof envelope.data === "string") {
            // The gateway sends base64-encoded data in the 'data' field
            // Decode it back to the original string
            try {
              messageData = base64Decode(envelope.data);
            } catch (decodeError) {
              console.error(
                "[Subscription] Base64 decode failed:",
                decodeError
              );
              // If base64 decode fails, use the envelope data as-is
              messageData = envelope.data;
            }
          }
        } catch (parseError) {
          // If not JSON, use the data as-is
        }

        const message: Message = {
          topic: this.topic,
          data: messageData,
          timestamp: Date.now(),
        };
        this.messageHandlers.forEach((handler) => handler(message));
      } catch (error) {
        console.error("[Subscription] Error processing message:", error);
        this.errorHandlers.forEach((handler) =>
          handler(error instanceof Error ? error : new Error(String(error)))
        );
      }
    });

    this.wsClient.onError((error) => {
      this.errorHandlers.forEach((handler) => handler(error));
    });

    this.wsClient.onClose(() => {
      this.closeHandlers.forEach((handler) => handler());
    });
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: ErrorHandler) {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: CloseHandler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close() {
    this.wsClient.close();
  }

  isConnected(): boolean {
    return this.wsClient.isConnected();
  }
}
