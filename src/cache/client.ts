import { HttpClient } from "../core/http";

export interface CacheGetRequest {
  dmap: string;
  key: string;
}

export interface CacheGetResponse {
  key: string;
  value: any;
  dmap: string;
}

export interface CachePutRequest {
  dmap: string;
  key: string;
  value: any;
  ttl?: string; // Duration string like "1h", "30m"
}

export interface CachePutResponse {
  status: string;
  key: string;
  dmap: string;
}

export interface CacheDeleteRequest {
  dmap: string;
  key: string;
}

export interface CacheDeleteResponse {
  status: string;
  key: string;
  dmap: string;
}

export interface CacheScanRequest {
  dmap: string;
  match?: string; // Optional regex pattern
}

export interface CacheScanResponse {
  keys: string[];
  count: number;
  dmap: string;
}

export interface CacheHealthResponse {
  status: string;
  service: string;
}

export class CacheClient {
  private httpClient: HttpClient;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }

  /**
   * Check cache service health
   */
  async health(): Promise<CacheHealthResponse> {
    return this.httpClient.get("/v1/cache/health");
  }

  /**
   * Get a value from cache
   */
  async get(dmap: string, key: string): Promise<CacheGetResponse> {
    return this.httpClient.post<CacheGetResponse>("/v1/cache/get", {
      dmap,
      key,
    });
  }

  /**
   * Put a value into cache
   */
  async put(
    dmap: string,
    key: string,
    value: any,
    ttl?: string
  ): Promise<CachePutResponse> {
    return this.httpClient.post<CachePutResponse>("/v1/cache/put", {
      dmap,
      key,
      value,
      ttl,
    });
  }

  /**
   * Delete a value from cache
   */
  async delete(dmap: string, key: string): Promise<CacheDeleteResponse> {
    return this.httpClient.post<CacheDeleteResponse>("/v1/cache/delete", {
      dmap,
      key,
    });
  }

  /**
   * Scan keys in a distributed map, optionally matching a regex pattern
   */
  async scan(dmap: string, match?: string): Promise<CacheScanResponse> {
    return this.httpClient.post<CacheScanResponse>("/v1/cache/scan", {
      dmap,
      match,
    });
  }
}
