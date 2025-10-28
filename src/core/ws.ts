import WebSocket from "isomorphic-ws";
import { SDKError } from "../errors";

export interface WSClientConfig {
  wsURL: string;
  timeout?: number;
  authToken?: string;
  WebSocket?: typeof WebSocket;
}

export type WSMessageHandler = (data: string) => void;
export type WSErrorHandler = (error: Error) => void;
export type WSCloseHandler = () => void;
export type WSOpenHandler = () => void;

/**
 * Simple WebSocket client with minimal abstractions
 * No complex reconnection, no heartbeats - keep it simple
 */
export class WSClient {
  private url: string;
  private timeout: number;
  private authToken?: string;
  private WebSocketClass: typeof WebSocket;

  private ws?: WebSocket;
  private messageHandlers: Set<WSMessageHandler> = new Set();
  private errorHandlers: Set<WSErrorHandler> = new Set();
  private closeHandlers: Set<WSCloseHandler> = new Set();
  private openHandlers: Set<WSOpenHandler> = new Set();
  private isClosed = false;

  constructor(config: WSClientConfig) {
    this.url = config.wsURL;
    this.timeout = config.timeout ?? 30000;
    this.authToken = config.authToken;
    this.WebSocketClass = config.WebSocket ?? WebSocket;
  }

  /**
   * Connect to WebSocket server
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.buildWSUrl();
        this.ws = new this.WebSocketClass(wsUrl);
        this.isClosed = false;

        const timeout = setTimeout(() => {
          this.ws?.close();
          reject(
            new SDKError("WebSocket connection timeout", 408, "WS_TIMEOUT")
          );
        }, this.timeout);

        this.ws.addEventListener("open", () => {
          clearTimeout(timeout);
          console.log("[WSClient] Connected to", this.url);
          this.openHandlers.forEach((handler) => handler());
          resolve();
        });

        this.ws.addEventListener("message", (event: Event) => {
          const msgEvent = event as MessageEvent;
          this.messageHandlers.forEach((handler) => handler(msgEvent.data));
        });

        this.ws.addEventListener("error", (event: Event) => {
          console.error("[WSClient] WebSocket error:", event);
          clearTimeout(timeout);
          const error = new SDKError("WebSocket error", 500, "WS_ERROR", event);
          this.errorHandlers.forEach((handler) => handler(error));
        });

        this.ws.addEventListener("close", () => {
          clearTimeout(timeout);
          console.log("[WSClient] Connection closed");
          this.closeHandlers.forEach((handler) => handler());
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Build WebSocket URL with auth token
   */
  private buildWSUrl(): string {
    let url = this.url;

    if (this.authToken) {
      const separator = url.includes("?") ? "&" : "?";
      const paramName = this.authToken.startsWith("ak_") ? "api_key" : "token";
      url += `${separator}${paramName}=${encodeURIComponent(this.authToken)}`;
    }

    return url;
  }

  /**
   * Register message handler
   */
  onMessage(handler: WSMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Unregister message handler
   */
  offMessage(handler: WSMessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  /**
   * Register error handler
   */
  onError(handler: WSErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Unregister error handler
   */
  offError(handler: WSErrorHandler): void {
    this.errorHandlers.delete(handler);
  }

  /**
   * Register close handler
   */
  onClose(handler: WSCloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * Unregister close handler
   */
  offClose(handler: WSCloseHandler): void {
    this.closeHandlers.delete(handler);
  }

  /**
   * Register open handler
   */
  onOpen(handler: WSOpenHandler): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  /**
   * Send data through WebSocket
   */
  send(data: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new SDKError("WebSocket is not connected", 500, "WS_NOT_CONNECTED");
    }
    this.ws.send(data);
  }

  /**
   * Close WebSocket connection
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.ws?.close();
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return !this.isClosed && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Update auth token
   */
  setAuthToken(token?: string): void {
    this.authToken = token;
  }
}
