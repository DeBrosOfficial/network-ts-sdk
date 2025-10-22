import { HttpClient } from "../core/http";

export interface PeerInfo {
  id: string;
  addresses: string[];
  lastSeen?: string;
}

export interface NetworkStatus {
  healthy: boolean;
  peers: number;
  uptime?: number;
}

export class NetworkClient {
  private httpClient: HttpClient;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }

  /**
   * Check gateway health.
   */
  async health(): Promise<boolean> {
    try {
      await this.httpClient.get("/v1/health");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get network status.
   */
  async status(): Promise<NetworkStatus> {
    const response = await this.httpClient.get<NetworkStatus>("/v1/status");
    return response;
  }

  /**
   * Get connected peers.
   */
  async peers(): Promise<PeerInfo[]> {
    const response = await this.httpClient.get<{ peers: PeerInfo[] }>(
      "/v1/network/peers"
    );
    return response.peers || [];
  }

  /**
   * Connect to a peer.
   */
  async connect(peerAddr: string): Promise<void> {
    await this.httpClient.post("/v1/network/connect", { peer_addr: peerAddr });
  }

  /**
   * Disconnect from a peer.
   */
  async disconnect(peerId: string): Promise<void> {
    await this.httpClient.post("/v1/network/disconnect", { peer_id: peerId });
  }
}
