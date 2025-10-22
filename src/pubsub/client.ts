import { HttpClient } from "../core/http";
import { WSClient, WSClientConfig } from "../core/ws";

export interface Message {
  data: string;
  topic: string;
  timestamp?: number;
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
    const dataBase64 =
      typeof data === "string" ? Buffer.from(data).toString("base64") : Buffer.from(data).toString("base64");

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
        const message: Message = {
          topic: this.topic,
          data: data,
          timestamp: Date.now(),
        };
        this.messageHandlers.forEach((handler) => handler(message));
      } catch (error) {
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
