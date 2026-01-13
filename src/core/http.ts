import { SDKError } from "../errors";

export interface HttpClientConfig {
  baseURL: string | string[];
  timeout?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
  gatewayHealthCheckCooldownMs?: number;
}

/**
 * Create a fetch function with proper TLS configuration for staging certificates
 * In Node.js, we need to configure TLS to accept Let's Encrypt staging certificates
 */
function createFetchWithTLSConfig(): typeof fetch {
  // Check if we're in a Node.js environment
  if (typeof process !== "undefined" && process.versions?.node) {
    // For testing/staging/development: allow staging certificates
    // Let's Encrypt staging certificates are self-signed and not trusted by default
    const isDevelopmentOrStaging =
      process.env.NODE_ENV !== "production" ||
      process.env.DEBROS_ALLOW_STAGING_CERTS === "true" ||
      process.env.DEBROS_USE_HTTPS === "true";

    if (isDevelopmentOrStaging) {
      // Allow self-signed/staging certificates
      // WARNING: Only use this in development/testing environments
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }
  return globalThis.fetch;
}

interface GatewayHealth {
  url: string;
  unhealthyUntil: number | null; // Timestamp when gateway becomes healthy again
}

export class HttpClient {
  private baseURLs: string[];
  private currentURLIndex: number = 0;
  private timeout: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private fetch: typeof fetch;
  private apiKey?: string;
  private jwt?: string;
  private gatewayHealthCheckCooldownMs: number;
  private gatewayHealth: Map<string, GatewayHealth>;

  constructor(config: HttpClientConfig) {
    this.baseURLs = (Array.isArray(config.baseURL) ? config.baseURL : [config.baseURL])
      .map(url => url.replace(/\/$/, ""));
    this.timeout = config.timeout ?? 60000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.gatewayHealthCheckCooldownMs = config.gatewayHealthCheckCooldownMs ?? 600000; // Default 10 minutes
    // Use provided fetch or create one with proper TLS configuration for staging certificates
    this.fetch = config.fetch ?? createFetchWithTLSConfig();

    // Initialize gateway health tracking
    this.gatewayHealth = new Map();
    this.baseURLs.forEach(url => {
      this.gatewayHealth.set(url, { url, unhealthyUntil: null });
    });
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

  /**
   * Get the current base URL (for single gateway or current gateway in multi-gateway setup)
   */
  private getCurrentBaseURL(): string {
    return this.baseURLs[this.currentURLIndex];
  }

  /**
   * Get all base URLs (for WebSocket or other purposes that need all gateways)
   */
  getBaseURLs(): string[] {
    return [...this.baseURLs];
  }

  /**
   * Check if a gateway is healthy (not in cooldown period)
   */
  private isGatewayHealthy(url: string): boolean {
    const health = this.gatewayHealth.get(url);
    if (!health || health.unhealthyUntil === null) {
      return true;
    }
    const now = Date.now();
    if (now >= health.unhealthyUntil) {
      // Cooldown period expired, mark as healthy again
      health.unhealthyUntil = null;
      return true;
    }
    return false;
  }

  /**
   * Mark a gateway as unhealthy for the cooldown period
   */
  private markGatewayUnhealthy(url: string): void {
    const health = this.gatewayHealth.get(url);
    if (health) {
      health.unhealthyUntil = Date.now() + this.gatewayHealthCheckCooldownMs;
      if (typeof console !== "undefined") {
        console.warn(
          `[HttpClient] Gateway marked unhealthy for ${this.gatewayHealthCheckCooldownMs / 1000}s:`,
          url
        );
      }
    }
  }

  /**
   * Try the next healthy gateway in the list
   * Returns the index of the next healthy gateway, or -1 if none available
   */
  private findNextHealthyGateway(): number {
    if (this.baseURLs.length <= 1) {
      return -1; // No other gateways to try
    }

    const startIndex = this.currentURLIndex;
    let attempts = 0;

    // Try each gateway once (excluding current)
    while (attempts < this.baseURLs.length - 1) {
      const nextIndex = (startIndex + attempts + 1) % this.baseURLs.length;
      const nextUrl = this.baseURLs[nextIndex];

      if (this.isGatewayHealthy(nextUrl)) {
        return nextIndex;
      }

      attempts++;
    }

    return -1; // No healthy gateways found
  }

  /**
   * Move to the next healthy gateway
   */
  private moveToNextGateway(): boolean {
    const nextIndex = this.findNextHealthyGateway();
    if (nextIndex === -1) {
      return false;
    }
    this.currentURLIndex = nextIndex;
    return true;
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
    const url = new URL(this.getCurrentBaseURL() + path);
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
            queryDetails += ` | Args: [${body.args
              .map((a: any) => (typeof a === "string" ? `"${a}"` : a))
              .join(", ")}]`;
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
        const logMessage = `[HttpClient] ${method} ${path} completed in ${duration.toFixed(
          2
        )}ms`;
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
        // For 404 errors on find-one calls, log at warn level (not error) since "not found" is expected
        // Application layer handles these cases in try-catch blocks
        const is404FindOne =
          path === "/v1/rqlite/find-one" &&
          error instanceof SDKError &&
          error.httpStatus === 404;

        if (is404FindOne) {
          // Log as warning for visibility, but not as error since it's expected behavior
          console.warn(
            `[HttpClient] ${method} ${path} returned 404 after ${duration.toFixed(
              2
            )}ms (expected for optional lookups)`
          );
        } else {
          const errorMessage = `[HttpClient] ${method} ${path} failed after ${duration.toFixed(
            2
          )}ms:`;
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
    startTime?: number, // Track start time for timing across retries
    gatewayAttempt: number = 0 // Track gateway failover attempts
  ): Promise<any> {
    const currentGatewayUrl = this.getCurrentBaseURL();

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

      // Request succeeded - return response
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return response.json();
      }
      return response.text();
    } catch (error) {
      const isRetryableError =
        error instanceof SDKError &&
        [408, 429, 500, 502, 503, 504].includes(error.httpStatus);

      const isNetworkError =
        error instanceof TypeError ||
        (error instanceof Error && error.message.includes('fetch'));

      // Retry on the same gateway first (for retryable HTTP errors)
      if (isRetryableError && attempt < this.maxRetries) {
        if (typeof console !== "undefined") {
          console.warn(
            `[HttpClient] Retrying request on same gateway (attempt ${attempt + 1}/${this.maxRetries}):`,
            currentGatewayUrl
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelayMs * (attempt + 1))
        );
        return this.requestWithRetry(url, options, attempt + 1, startTime, gatewayAttempt);
      }

      // If all retries on current gateway failed, mark it unhealthy and try next gateway
      if ((isNetworkError || isRetryableError) && gatewayAttempt < this.baseURLs.length - 1) {
        // Mark current gateway as unhealthy
        this.markGatewayUnhealthy(currentGatewayUrl);

        // Try to move to next healthy gateway
        if (this.moveToNextGateway()) {
          if (typeof console !== "undefined") {
            console.warn(
              `[HttpClient] Gateway exhausted retries, trying next gateway (${gatewayAttempt + 1}/${this.baseURLs.length - 1}):`,
              this.getCurrentBaseURL()
            );
          }

          // Update URL to use the new gateway
          const currentPath = url.substring(url.indexOf('/', 8)); // Get path after protocol://host
          const newUrl = this.getCurrentBaseURL() + currentPath;

          // Small delay before trying next gateway
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));

          // Reset attempt counter for new gateway
          return this.requestWithRetry(newUrl, options, 0, startTime, gatewayAttempt + 1);
        }
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
    const url = new URL(this.getCurrentBaseURL() + path);
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
    const url = new URL(this.getCurrentBaseURL() + path);
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
