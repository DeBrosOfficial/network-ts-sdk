import { HttpClient } from "../core/http";
import {
  AuthConfig,
  WhoAmI,
  StorageAdapter,
  MemoryStorage,
} from "./types";

export class AuthClient {
  private httpClient: HttpClient;
  private storage: StorageAdapter;
  private currentApiKey?: string;
  private currentJwt?: string;

  constructor(config: {
    httpClient: HttpClient;
    storage?: StorageAdapter;
    apiKey?: string;
    jwt?: string;
  }) {
    this.httpClient = config.httpClient;
    this.storage = config.storage ?? new MemoryStorage();
    this.currentApiKey = config.apiKey;
    this.currentJwt = config.jwt;

    if (this.currentApiKey) {
      this.httpClient.setApiKey(this.currentApiKey);
    }
    if (this.currentJwt) {
      this.httpClient.setJwt(this.currentJwt);
    }
  }

  setApiKey(apiKey: string) {
    this.currentApiKey = apiKey;
    this.currentJwt = undefined;
    this.httpClient.setApiKey(apiKey);
    this.storage.set("apiKey", apiKey);
  }

  setJwt(jwt: string) {
    this.currentJwt = jwt;
    this.currentApiKey = undefined;
    this.httpClient.setJwt(jwt);
    this.storage.set("jwt", jwt);
  }

  getToken(): string | undefined {
    return this.httpClient.getToken();
  }

  async whoami(): Promise<WhoAmI> {
    try {
      const response = await this.httpClient.get<WhoAmI>("/v1/auth/whoami");
      return response;
    } catch {
      return { authenticated: false };
    }
  }

  async refresh(): Promise<string> {
    const response = await this.httpClient.post<{ token: string }>(
      "/v1/auth/refresh"
    );
    const token = response.token;
    this.setJwt(token);
    return token;
  }

  async logout(): Promise<void> {
    // Only attempt server-side logout if using JWT
    // API keys don't support server-side logout with all=true
    if (this.currentJwt) {
      try {
        await this.httpClient.post("/v1/auth/logout", { all: true });
      } catch (error) {
        // Log warning but don't fail - local cleanup is more important
        console.warn('Server-side logout failed, continuing with local cleanup:', error);
      }
    }
    
    // Always clear local state
    this.currentApiKey = undefined;
    this.currentJwt = undefined;
    this.httpClient.setApiKey(undefined);
    this.httpClient.setJwt(undefined);
    await this.storage.clear();
  }

  async clear(): Promise<void> {
    this.currentApiKey = undefined;
    this.currentJwt = undefined;
    this.httpClient.setApiKey(undefined);
    this.httpClient.setJwt(undefined);
    await this.storage.clear();
  }
}
