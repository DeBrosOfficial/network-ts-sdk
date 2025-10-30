import { HttpClient, HttpClientConfig } from "./core/http";
import { AuthClient } from "./auth/client";
import { DBClient } from "./db/client";
import { PubSubClient } from "./pubsub/client";
import { NetworkClient } from "./network/client";
import { WSClientConfig } from "./core/ws";
import {
  StorageAdapter,
  MemoryStorage,
  LocalStorageAdapter,
} from "./auth/types";

export interface ClientConfig extends Omit<HttpClientConfig, "fetch"> {
  apiKey?: string;
  jwt?: string;
  storage?: StorageAdapter;
  wsConfig?: Partial<WSClientConfig>;
  fetch?: typeof fetch;
}

export interface Client {
  auth: AuthClient;
  db: DBClient;
  pubsub: PubSubClient;
  network: NetworkClient;
}

export function createClient(config: ClientConfig): Client {
  const httpClient = new HttpClient({
    baseURL: config.baseURL,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryDelayMs: config.retryDelayMs,
    fetch: config.fetch,
  });

  const auth = new AuthClient({
    httpClient,
    storage: config.storage,
    apiKey: config.apiKey,
    jwt: config.jwt,
  });

  // Derive WebSocket URL from baseURL if not explicitly provided
  const wsURL =
    config.wsConfig?.wsURL ??
    config.baseURL.replace(/^http/, "ws").replace(/\/$/, "");

  const db = new DBClient(httpClient);
  const pubsub = new PubSubClient(httpClient, {
    ...config.wsConfig,
    wsURL,
  });
  const network = new NetworkClient(httpClient);

  return {
    auth,
    db,
    pubsub,
    network,
  };
}

// Re-exports
export { HttpClient } from "./core/http";
export { WSClient } from "./core/ws";
export { AuthClient } from "./auth/client";
export { DBClient } from "./db/client";
export { QueryBuilder } from "./db/qb";
export { Repository } from "./db/repository";
export { PubSubClient, Subscription } from "./pubsub/client";
export { NetworkClient } from "./network/client";
export { SDKError } from "./errors";
export { MemoryStorage, LocalStorageAdapter } from "./auth/types";
export type { StorageAdapter, AuthConfig, WhoAmI } from "./auth/types";
export type * from "./db/types";
export type {
  Message,
  MessageHandler,
  ErrorHandler,
  CloseHandler,
} from "./pubsub/client";
export type {
  PeerInfo,
  NetworkStatus,
  ProxyRequest,
  ProxyResponse,
} from "./network/client";
