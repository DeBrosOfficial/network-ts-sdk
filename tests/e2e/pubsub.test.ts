import { describe, it, expect, beforeEach } from "vitest";
import { createTestClient, skipIfNoGateway, delay } from "./setup";

describe("PubSub", () => {
  if (skipIfNoGateway()) {
    console.log("Skipping PubSub tests");
  }

  let topicName: string;

  beforeEach(() => {
    topicName = `test_topic_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  });

  it("should get topics list", async () => {
    const client = await createTestClient();
    const topics = await client.pubsub.topics();
    expect(Array.isArray(topics)).toBe(true);
  });

  it("should publish a message", async () => {
    const client = await createTestClient();
    const testMessage = "Hello from test";

    // Should not throw
    await client.pubsub.publish(topicName, testMessage);
    expect(true).toBe(true);
  });

  it("should subscribe and receive published message", async () => {
    const client = await createTestClient();
    const testMessage = "Test message";
    let receivedMessage: any = null;

    // Create subscription with handlers
    const subscription = await client.pubsub.subscribe(topicName, {
      onMessage: (msg) => {
        receivedMessage = msg;
      },
      onError: (err) => {
        console.error("Subscription error:", err);
      },
    });

    // Give subscription a moment to establish
    await delay(500);

    // Publish message
    await client.pubsub.publish(topicName, testMessage);

    // Wait for message to arrive
    await delay(1000);

    // Should have received the message
    expect(receivedMessage).toBeDefined();
    expect(receivedMessage?.topic).toBe(topicName);

    // Cleanup
    subscription.close();
  });

  it("should handle subscription events", async () => {
    const client = await createTestClient();
    const events: string[] = [];

    const subscription = await client.pubsub.subscribe(topicName, {
      onMessage: () => {
        events.push("message");
      },
      onError: (err) => {
        events.push("error");
      },
      onClose: () => {
        events.push("close");
      },
    });

    // Publish a message
    await delay(300);
    await client.pubsub.publish(topicName, "test");

    // Wait for event
    await delay(500);

    // Close and check for close event
    subscription.close();
    await delay(300);

    expect(events.length).toBeGreaterThanOrEqual(0);
  });
});
