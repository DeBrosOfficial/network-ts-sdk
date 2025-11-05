import { HttpClient } from "../core/http";

export interface StorageUploadResponse {
  cid: string;
  name: string;
  size: number;
}

export interface StoragePinRequest {
  cid: string;
  name?: string;
}

export interface StoragePinResponse {
  cid: string;
  name: string;
}

export interface StorageStatus {
  cid: string;
  name: string;
  status: string; // "pinned", "pinning", "queued", "unpinned", "error"
  replication_min: number;
  replication_max: number;
  replication_factor: number;
  peers: string[];
  error?: string;
}

export class StorageClient {
  private httpClient: HttpClient;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }

  /**
   * Upload content to IPFS and pin it.
   * Supports both File objects (browser) and Buffer/ReadableStream (Node.js).
   *
   * @param file - File to upload (File, Blob, or Buffer)
   * @param name - Optional filename
   * @returns Upload result with CID
   *
   * @example
   * ```ts
   * // Browser
   * const fileInput = document.querySelector('input[type="file"]');
   * const file = fileInput.files[0];
   * const result = await client.storage.upload(file, file.name);
   * console.log(result.cid);
   *
   * // Node.js
   * const fs = require('fs');
   * const fileBuffer = fs.readFileSync('image.jpg');
   * const result = await client.storage.upload(fileBuffer, 'image.jpg');
   * ```
   */
  async upload(
    file: File | Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
    name?: string
  ): Promise<StorageUploadResponse> {
    // Create FormData for multipart upload
    const formData = new FormData();

    // Handle different input types
    if (file instanceof File) {
      formData.append("file", file);
    } else if (file instanceof Blob) {
      formData.append("file", file, name);
    } else if (file instanceof ArrayBuffer) {
      const blob = new Blob([file]);
      formData.append("file", blob, name);
    } else if (file instanceof Uint8Array) {
      // Convert Uint8Array to ArrayBuffer for Blob constructor
      const buffer = file.buffer.slice(
        file.byteOffset,
        file.byteOffset + file.byteLength
      ) as ArrayBuffer;
      const blob = new Blob([buffer], { type: "application/octet-stream" });
      formData.append("file", blob, name);
    } else if (file instanceof ReadableStream) {
      // For ReadableStream, we need to read it into a blob first
      // This is a limitation - in practice, pass File/Blob/Buffer
      const chunks: ArrayBuffer[] = [];
      const reader = file.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        ) as ArrayBuffer;
        chunks.push(buffer);
      }
      const blob = new Blob(chunks);
      formData.append("file", blob, name);
    } else {
      throw new Error(
        "Unsupported file type. Use File, Blob, ArrayBuffer, Uint8Array, or ReadableStream."
      );
    }

    return this.httpClient.uploadFile<StorageUploadResponse>(
      "/v1/storage/upload",
      formData,
      { timeout: 300000 } // 5 minute timeout for large files
    );
  }

  /**
   * Pin an existing CID
   *
   * @param cid - Content ID to pin
   * @param name - Optional name for the pin
   * @returns Pin result
   */
  async pin(cid: string, name?: string): Promise<StoragePinResponse> {
    return this.httpClient.post<StoragePinResponse>("/v1/storage/pin", {
      cid,
      name,
    });
  }

  /**
   * Get the pin status for a CID
   *
   * @param cid - Content ID to check
   * @returns Pin status information
   */
  async status(cid: string): Promise<StorageStatus> {
    return this.httpClient.get<StorageStatus>(`/v1/storage/status/${cid}`);
  }

  /**
   * Retrieve content from IPFS by CID
   *
   * @param cid - Content ID to retrieve
   * @returns ReadableStream of the content
   *
   * @example
   * ```ts
   * const stream = await client.storage.get(cid);
   * const reader = stream.getReader();
   * while (true) {
   *   const { done, value } = await reader.read();
   *   if (done) break;
   *   // Process chunk
   * }
   * ```
   */
  async get(cid: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.httpClient.getBinary(`/v1/storage/get/${cid}`);

    if (!response.body) {
      throw new Error("Response body is null");
    }

    return response.body;
  }

  /**
   * Unpin a CID
   *
   * @param cid - Content ID to unpin
   */
  async unpin(cid: string): Promise<void> {
    await this.httpClient.delete(`/v1/storage/unpin/${cid}`);
  }
}
