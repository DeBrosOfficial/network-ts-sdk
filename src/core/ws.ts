import WebSocket from "isomorphic-ws";
import { SDKError } from "../errors";

export interface WSClientConfig {
  wsURL: string;
  timeout?: number;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
  authMode?: "header" | "query";
  authToken?: string;
  WebSocket?: typeof WebSocket;
}

export type WSMessageHandler = (data: string) => void;
export type WSErrorHandler = (error: Error) => void;
export type WSCloseHandler = () => void;

export class WSClient {
  private url: string;
  private timeout: number;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private heartbeatIntervalMs: number;
  private authMode: "header" | "query";
  private authToken?: string;
  private WebSocketClass: typeof WebSocket;

  private ws?: WebSocket;
  private reconnectAttempts = 0;
  private heartbeatInterval?: NodeJS.Timeout;
  private messageHandlers: Set<WSMessageHandler> = new Set();
  private errorHandlers: Set<WSErrorHandler> = new Set();
  private closeHandlers: Set<WSCloseHandler> = new Set();
  private isManuallyClosed = false;

  constructor(config: WSClientConfig) {
    this.url = config.wsURL;
    this.timeout = config.timeout ?? 30000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 5;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 1000;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30000;
    this.authMode = config.authMode ?? "header";
    this.authToken = config.authToken;
    this.WebSocketClass = config.WebSocket ?? WebSocket;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.buildWSUrl();
        this.ws = new this.WebSocketClass(wsUrl);

        // Note: Custom headers via ws library in Node.js are not sent with WebSocket upgrade requests
        // so we rely on query parameters for authentication

        const timeout = setTimeout(() => {
          this.ws?.close();
          reject(new SDKError("WebSocket connection timeout", 408, "WS_TIMEOUT"));
        }, this.timeout);

        this.ws.addEventListener("open", () => {
          clearTimeout(timeout);
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          resolve();
        });

        this.ws.addEventListener("message", (event: Event) => {
          const msgEvent = event as MessageEvent;
          this.messageHandlers.forEach((handler) => handler(msgEvent.data));
        });

        this.ws.addEventListener("error", (event: Event) => {
          clearTimeout(timeout);
          const error = new SDKError(
            "WebSocket error",
            500,
            "WS_ERROR",
            event
          );
          this.errorHandlers.forEach((handler) => handler(error));
        });

        this.ws.addEventListener("close", () => {
          clearTimeout(timeout);
          this.stopHeartbeat();
          if (!this.isManuallyClosed) {
            this.attemptReconnect();
          } else {
            this.closeHandlers.forEach((handler) => handler());
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private buildWSUrl(): string {
    let url = this.url;
    
    // Always append auth token as query parameter for compatibility
    // Works in both Node.js and browser environments
    if (this.authToken) {
      const separator = url.includes("?") ? "&" : "?";
      const paramName = this.authToken.startsWith("ak_") ? "api_key" : "token";
      url += `${separator}${paramName}=${encodeURIComponent(this.authToken)}`;
    }
    
    return url;
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delayMs = this.reconnectDelayMs * this.reconnectAttempts;
      setTimeout(() => {
        this.connect().catch((error) => {
          this.errorHandlers.forEach((handler) => handler(error));
        });
      }, delayMs);
    } else {
      this.closeHandlers.forEach((handler) => handler());
    }
  }

  onMessage(handler: WSMessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: WSErrorHandler) {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: WSCloseHandler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  send(data: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new SDKError(
        "WebSocket is not connected",
        500,
        "WS_NOT_CONNECTED"
      );
    }
    this.ws.send(data);
  }

  close() {
    this.isManuallyClosed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setAuthToken(token?: string) {
    this.authToken = token;
  }
}
