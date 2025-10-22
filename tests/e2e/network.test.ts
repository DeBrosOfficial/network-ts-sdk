import { describe, it, expect, beforeAll } from "vitest";
import { createTestClient, skipIfNoGateway } from "./setup";

describe("Network", () => {
  beforeAll(() => {
    if (skipIfNoGateway()) {
      console.log("Skipping network tests");
    }
  });

  it("should check health", async () => {
    const client = await createTestClient();
    const healthy = await client.network.health();
    expect(typeof healthy).toBe("boolean");
  });

  it("should get network status", async () => {
    const client = await createTestClient();
    const status = await client.network.status();
    expect(status).toBeDefined();
    expect(typeof status.healthy).toBe("boolean");
    expect(typeof status.peers).toBe("number");
  });

  it("should list peers", async () => {
    const client = await createTestClient();
    const peers = await client.network.peers();
    expect(Array.isArray(peers)).toBe(true);
  });
});
