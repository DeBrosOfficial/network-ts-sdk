import { SDKError } from "../errors";

export interface HttpClientConfig {
  baseURL: string;
  timeout?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

export class HttpClient {
  private baseURL: string;
  private timeout: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private fetch: typeof fetch;
  private apiKey?: string;
  private jwt?: string;

  constructor(config: HttpClientConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, "");
    this.timeout = config.timeout ?? 60000; // Increased from 30s to 60s for pub/sub operations
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  setApiKey(apiKey?: string) {
    this.apiKey = apiKey;
    // Don't clear JWT - allow both to coexist
    if (typeof console !== "undefined") {
      console.log(
        "[HttpClient] API key set:",
        !!apiKey,
        "JWT still present:",
        !!this.jwt
      );
    }
  }

  setJwt(jwt?: string) {
    this.jwt = jwt;
    // Don't clear API key - allow both to coexist
    if (typeof console !== "undefined") {
      console.log(
        "[HttpClient] JWT set:",
        !!jwt,
        "API key still present:",
        !!this.apiKey
      );
    }
  }

  private getAuthHeaders(path: string): Record<string, string> {
    const headers: Record<string, string> = {};

    // For database operations, ONLY use API key to avoid JWT user context
    // interfering with namespace-level authorization
    const isDbOperation = path.includes("/v1/rqlite/");

    if (isDbOperation) {
      // For database operations: use only API key (preferred for namespace operations)
      if (this.apiKey) {
        headers["X-API-Key"] = this.apiKey;
      } else if (this.jwt) {
        // Fallback to JWT if no API key
        headers["Authorization"] = `Bearer ${this.jwt}`;
      }
    } else {
      // For auth/other operations: send both JWT and API key
      if (this.jwt) {
        headers["Authorization"] = `Bearer ${this.jwt}`;
      }
      if (this.apiKey) {
        headers["X-API-Key"] = this.apiKey;
      }
    }
    return headers;
  }

  private getAuthToken(): string | undefined {
    return this.jwt || this.apiKey;
  }

  async request<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      body?: any;
      headers?: Record<string, string>;
      query?: Record<string, string | number | boolean>;
      timeout?: number; // Per-request timeout override
    } = {}
  ): Promise<T> {
    const url = new URL(this.baseURL + path);
    if (options.query) {
      Object.entries(options.query).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.getAuthHeaders(path),
      ...options.headers,
    };

    // Debug: Log headers being sent
    if (
      typeof console !== "undefined" &&
      (path.includes("/db/") ||
        path.includes("/query") ||
        path.includes("/auth/"))
    ) {
      console.log("[HttpClient] Request headers for", path, {
        hasAuth: !!headers["Authorization"],
        hasApiKey: !!headers["X-API-Key"],
        authPrefix: headers["Authorization"]
          ? headers["Authorization"].substring(0, 20)
          : "none",
        apiKeyPrefix: headers["X-API-Key"]
          ? headers["X-API-Key"].substring(0, 20)
          : "none",
      });
    }

    const controller = new AbortController();
    const requestTimeout = options.timeout ?? this.timeout; // Use override or default
    const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (options.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    try {
      return await this.requestWithRetry(url.toString(), fetchOptions);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async requestWithRetry(
    url: string,
    options: RequestInit,
    attempt: number = 0
  ): Promise<any> {
    try {
      const response = await this.fetch(url, options);

      if (!response.ok) {
        let body: any;
        try {
          body = await response.json();
        } catch {
          body = { error: response.statusText };
        }
        throw SDKError.fromResponse(response.status, body);
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return response.json();
      }
      return response.text();
    } catch (error) {
      if (
        error instanceof SDKError &&
        attempt < this.maxRetries &&
        [408, 429, 500, 502, 503, 504].includes(error.httpStatus)
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelayMs * (attempt + 1))
        );
        return this.requestWithRetry(url, options, attempt + 1);
      }
      throw error;
    }
  }

  async get<T = any>(
    path: string,
    options?: Omit<Parameters<typeof this.request>[2], "body">
  ): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  async post<T = any>(
    path: string,
    body?: any,
    options?: Omit<Parameters<typeof this.request>[2], "body">
  ): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  async put<T = any>(
    path: string,
    body?: any,
    options?: Omit<Parameters<typeof this.request>[2], "body">
  ): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  async delete<T = any>(
    path: string,
    options?: Omit<Parameters<typeof this.request>[2], "body">
  ): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  getToken(): string | undefined {
    return this.getAuthToken();
  }
}
