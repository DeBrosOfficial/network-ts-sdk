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

    // For database, pubsub, proxy, and cache operations, ONLY use API key to avoid JWT user context
    // interfering with namespace-level authorization
    const isDbOperation = path.includes("/v1/rqlite/");
    const isPubSubOperation = path.includes("/v1/pubsub/");
    const isProxyOperation = path.includes("/v1/proxy/");
    const isCacheOperation = path.includes("/v1/cache/");

    // For auth operations, prefer API key over JWT to ensure proper authentication
    const isAuthOperation = path.includes("/v1/auth/");

    if (
      isDbOperation ||
      isPubSubOperation ||
      isProxyOperation ||
      isCacheOperation
    ) {
      // For database/pubsub/proxy/cache operations: use only API key (preferred for namespace operations)
      if (this.apiKey) {
        headers["X-API-Key"] = this.apiKey;
      } else if (this.jwt) {
        // Fallback to JWT if no API key
        headers["Authorization"] = `Bearer ${this.jwt}`;
      }
    } else if (isAuthOperation) {
      // For auth operations: prefer API key over JWT (auth endpoints should use explicit API key)
      if (this.apiKey) {
        headers["X-API-Key"] = this.apiKey;
      }
      if (this.jwt) {
        headers["Authorization"] = `Bearer ${this.jwt}`;
      }
    } else {
      // For other operations: send both JWT and API key
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

  getApiKey(): string | undefined {
    return this.apiKey;
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
    const startTime = performance.now(); // Track request start time
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

    // Extract and log SQL query details for rqlite operations
    const isRqliteOperation = path.includes("/v1/rqlite/");
    let queryDetails: string | null = null;
    if (isRqliteOperation && options.body) {
      try {
        const body =
          typeof options.body === "string"
            ? JSON.parse(options.body)
            : options.body;
        
        if (body.sql) {
          // Direct SQL query (query/exec endpoints)
          queryDetails = `SQL: ${body.sql}`;
          if (body.args && body.args.length > 0) {
            queryDetails += ` | Args: [${body.args.map((a: any) => 
              typeof a === 'string' ? `"${a}"` : a
            ).join(', ')}]`;
          }
        } else if (body.table) {
          // Table-based query (find/find-one/select endpoints)
          queryDetails = `Table: ${body.table}`;
          if (body.criteria && Object.keys(body.criteria).length > 0) {
            queryDetails += ` | Criteria: ${JSON.stringify(body.criteria)}`;
          }
          if (body.options) {
            queryDetails += ` | Options: ${JSON.stringify(body.options)}`;
          }
          if (body.select) {
            queryDetails += ` | Select: ${JSON.stringify(body.select)}`;
          }
          if (body.where) {
            queryDetails += ` | Where: ${JSON.stringify(body.where)}`;
          }
          if (body.limit) {
            queryDetails += ` | Limit: ${body.limit}`;
          }
          if (body.offset) {
            queryDetails += ` | Offset: ${body.offset}`;
          }
        }
      } catch (e) {
        // Failed to parse body, ignore
      }
    }

    try {
      const result = await this.requestWithRetry(
        url.toString(),
        fetchOptions,
        0,
        startTime
      );
      const duration = performance.now() - startTime;
      if (typeof console !== "undefined") {
        const logMessage = `[HttpClient] ${method} ${path} completed in ${duration.toFixed(2)}ms`;
        if (queryDetails) {
          console.log(logMessage);
          console.log(`[HttpClient]   ${queryDetails}`);
        } else {
          console.log(logMessage);
        }
      }
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      if (typeof console !== "undefined") {
        // Cache "key not found" (404 or error message) is expected behavior - don't log as error
        const isCacheGetNotFound =
          path === "/v1/cache/get" &&
          error instanceof SDKError &&
          (error.httpStatus === 404 ||
            (error.httpStatus === 500 &&
              error.message?.toLowerCase().includes("key not found")));

        // "Not found" (404) for blocked_users is expected behavior - don't log as error
        // This happens when checking if users are blocked (most users aren't blocked)
        const isBlockedUsersNotFound =
          path === "/v1/rqlite/find-one" &&
          error instanceof SDKError &&
          error.httpStatus === 404 &&
          options.body &&
          (() => {
            try {
              const body =
                typeof options.body === "string"
                  ? JSON.parse(options.body)
                  : options.body;
              return body.table === "blocked_users";
            } catch {
              return false;
            }
          })();

        // "Not found" (404) for conversation_participants is expected behavior - don't log as error
        // This happens when checking if a user is a participant (e.g., on first group join)
        const isConversationParticipantNotFound =
          path === "/v1/rqlite/find-one" &&
          error instanceof SDKError &&
          error.httpStatus === 404 &&
          options.body &&
          (() => {
            try {
              const body =
                typeof options.body === "string"
                  ? JSON.parse(options.body)
                  : options.body;
              return body.table === "conversation_participants";
            } catch {
              return false;
            }
          })();

        if (
          isCacheGetNotFound ||
          isBlockedUsersNotFound ||
          isConversationParticipantNotFound
        ) {
          // Log cache miss, non-blocked status, or non-participant status as debug/info, not error
          // These are expected behaviors
        } else {
          const errorMessage = `[HttpClient] ${method} ${path} failed after ${duration.toFixed(2)}ms:`;
          console.error(errorMessage, error);
          if (queryDetails) {
            console.error(`[HttpClient]   ${queryDetails}`);
          }
        }
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async requestWithRetry(
    url: string,
    options: RequestInit,
    attempt: number = 0,
    startTime?: number // Track start time for timing across retries
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
        return this.requestWithRetry(url, options, attempt + 1, startTime);
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

  /**
   * Upload a file using multipart/form-data
   * This is a special method for file uploads that bypasses JSON serialization
   */
  async uploadFile<T = any>(
    path: string,
    formData: FormData,
    options?: {
      timeout?: number;
    }
  ): Promise<T> {
    const startTime = performance.now(); // Track upload start time
    const url = new URL(this.baseURL + path);
    const headers: Record<string, string> = {
      ...this.getAuthHeaders(path),
      // Don't set Content-Type - browser will set it with boundary
    };

    const controller = new AbortController();
    const requestTimeout = options?.timeout ?? this.timeout * 5; // 5x timeout for uploads
    const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

    const fetchOptions: RequestInit = {
      method: "POST",
      headers,
      body: formData,
      signal: controller.signal,
    };

    try {
      const result = await this.requestWithRetry(
        url.toString(),
        fetchOptions,
        0,
        startTime
      );
      const duration = performance.now() - startTime;
      if (typeof console !== "undefined") {
        console.log(
          `[HttpClient] POST ${path} (upload) completed in ${duration.toFixed(
            2
          )}ms`
        );
      }
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      if (typeof console !== "undefined") {
        console.error(
          `[HttpClient] POST ${path} (upload) failed after ${duration.toFixed(
            2
          )}ms:`,
          error
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get a binary response (returns Response object for streaming)
   */
  async getBinary(path: string): Promise<Response> {
    const url = new URL(this.baseURL + path);
    const headers: Record<string, string> = {
      ...this.getAuthHeaders(path),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout * 5); // 5x timeout for downloads

    const fetchOptions: RequestInit = {
      method: "GET",
      headers,
      signal: controller.signal,
    };

    try {
      const response = await this.fetch(url.toString(), fetchOptions);
      if (!response.ok) {
        clearTimeout(timeoutId);
        const error = await response.json().catch(() => ({
          error: response.statusText,
        }));
        throw SDKError.fromResponse(response.status, error);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof SDKError) {
        throw error;
      }
      throw error;
    }
  }

  getToken(): string | undefined {
    return this.getAuthToken();
  }
}
