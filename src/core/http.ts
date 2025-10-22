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
    this.timeout = config.timeout ?? 30000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  setApiKey(apiKey?: string) {
    this.apiKey = apiKey;
    this.jwt = undefined;
  }

  setJwt(jwt?: string) {
    this.jwt = jwt;
    this.apiKey = undefined;
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.jwt) {
      headers["Authorization"] = `Bearer ${this.jwt}`;
    } else if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
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
      ...this.getAuthHeaders(),
      ...options.headers,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeout),
    };

    if (options.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    return this.requestWithRetry(url.toString(), fetchOptions);
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
