# @debros/network-ts-sdk - TypeScript SDK for DeBros Network

A modern, isomorphic TypeScript SDK for the DeBros Network gateway. Works seamlessly in both Node.js and browser environments with support for database operations, pub/sub messaging, and network management.

## Features

- **Isomorphic**: Works in Node.js and browsers (uses fetch and isomorphic-ws)
- **Database ORM-like API**: QueryBuilder, Repository pattern, transactions
- **Pub/Sub Messaging**: WebSocket subscriptions with automatic reconnection
- **Authentication**: API key and JWT support with automatic token management
- **TypeScript First**: Full type safety and IntelliSense
- **Error Handling**: Unified SDKError with HTTP status and code

## Installation

```bash
npm install @debros/network-ts-sdk
```

## Quick Start

### Initialize the Client

```typescript
import { createClient } from "@debros/network-ts-sdk";

const client = createClient({
  baseURL: "http://localhost:6001",
  apiKey: "ak_your_api_key:namespace",
});

// Or with JWT
const client = createClient({
  baseURL: "http://localhost:6001",
  jwt: "your_jwt_token",
});
```

### Database Operations

#### Create a Table

```typescript
await client.db.createTable(
  "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)"
);
```

#### Insert Data

```typescript
const result = await client.db.exec(
  "INSERT INTO users (name, email) VALUES (?, ?)",
  ["Alice", "alice@example.com"]
);
console.log(result.last_insert_id);
```

#### Query Data

```typescript
const users = await client.db.query("SELECT * FROM users WHERE email = ?", [
  "alice@example.com",
]);
```

#### Using QueryBuilder

```typescript
const activeUsers = await client.db
  .createQueryBuilder("users")
  .where("active = ?", [1])
  .orderBy("name DESC")
  .limit(10)
  .getMany();

const firstUser = await client.db
  .createQueryBuilder("users")
  .where("id = ?", [1])
  .getOne();
```

#### Using Repository Pattern

```typescript
interface User {
  id?: number;
  name: string;
  email: string;
}

const repo = client.db.repository<User>("users");

// Find
const users = await repo.find({ active: 1 });
const user = await repo.findOne({ email: "alice@example.com" });

// Save (INSERT or UPDATE)
const newUser: User = { name: "Bob", email: "bob@example.com" };
await repo.save(newUser);

// Remove
await repo.remove(newUser);
```

#### Transactions

```typescript
const results = await client.db.transaction([
  {
    kind: "exec",
    sql: "INSERT INTO users (name, email) VALUES (?, ?)",
    args: ["Charlie", "charlie@example.com"],
  },
  {
    kind: "query",
    sql: "SELECT COUNT(*) as count FROM users",
    args: [],
  },
]);
```

### Pub/Sub Messaging

The SDK provides a robust pub/sub client with:

- **Multi-subscriber support**: Multiple connections can subscribe to the same topic
- **Namespace isolation**: Topics are scoped to your authenticated namespace
- **Server timestamps**: Messages preserve server-side timestamps
- **Binary-safe**: Supports both string and binary (`Uint8Array`) payloads
- **Strict envelope validation**: Type-safe message parsing with error handling

#### Publish a Message

```typescript
// Publish a string message
await client.pubsub.publish("notifications", "Hello, Network!");

// Publish binary data
const binaryData = new Uint8Array([1, 2, 3, 4]);
await client.pubsub.publish("binary-topic", binaryData);
```

#### Subscribe to Topics

```typescript
const subscription = await client.pubsub.subscribe("notifications", {
  onMessage: (msg) => {
    console.log("Topic:", msg.topic);
    console.log("Data:", msg.data);
    console.log("Server timestamp:", new Date(msg.timestamp));
  },
  onError: (err) => {
    console.error("Subscription error:", err);
  },
  onClose: () => {
    console.log("Subscription closed");
  },
});

// Later, close the subscription
subscription.close();
```

**Message Interface:**

```typescript
interface Message {
  data: string; // Decoded message payload (string)
  topic: string; // Topic name
  timestamp: number; // Server timestamp in milliseconds
}
```

#### Debug Raw Envelopes

For debugging, you can inspect raw message envelopes before decoding:

```typescript
const subscription = await client.pubsub.subscribe("notifications", {
  onMessage: (msg) => {
    console.log("Decoded message:", msg.data);
  },
  onRaw: (envelope) => {
    console.log("Raw envelope:", envelope);
    // { data: "base64...", timestamp: 1234567890, topic: "notifications" }
  },
});
```

#### Multi-Subscriber Support

Multiple subscriptions to the same topic are supported. Each receives its own copy of messages:

```typescript
// First subscriber
const sub1 = await client.pubsub.subscribe("events", {
  onMessage: (msg) => console.log("Sub1:", msg.data),
});

// Second subscriber (both receive messages)
const sub2 = await client.pubsub.subscribe("events", {
  onMessage: (msg) => console.log("Sub2:", msg.data),
});

// Unsubscribe independently
sub1.close(); // sub2 still active
sub2.close(); // fully unsubscribed
```

#### List Topics

```typescript
const topics = await client.pubsub.topics();
console.log("Active topics:", topics);
```

### Authentication

#### Switch API Key

```typescript
client.auth.setApiKey("ak_new_key:namespace");
```

#### Switch JWT

```typescript
client.auth.setJwt("new_jwt_token");
```

#### Get Current Token

```typescript
const token = client.auth.getToken(); // Returns API key or JWT
```

#### Get Authentication Info

```typescript
const info = await client.auth.whoami();
console.log(info.authenticated, info.namespace);
```

#### Logout

```typescript
await client.auth.logout();
```

### Network Operations

#### Check Health

```typescript
const healthy = await client.network.health();
```

#### Get Network Status

```typescript
const status = await client.network.status();
console.log(status.healthy, status.peers);
```

#### List Peers

```typescript
const peers = await client.network.peers();
peers.forEach((peer) => {
  console.log(peer.id, peer.addresses);
});
```

## Configuration

### ClientConfig

```typescript
interface ClientConfig {
  baseURL: string; // Gateway URL
  apiKey?: string; // API key (optional, if using JWT instead)
  jwt?: string; // JWT token (optional, if using API key instead)
  timeout?: number; // Request timeout in ms (default: 30000)
  maxRetries?: number; // Max retry attempts (default: 3)
  retryDelayMs?: number; // Delay between retries (default: 1000)
  storage?: StorageAdapter; // For persisting JWT/API key (default: MemoryStorage)
  wsConfig?: Partial<WSClientConfig>; // WebSocket configuration
  fetch?: typeof fetch; // Custom fetch implementation
}
```

### Storage Adapters

By default, credentials are stored in memory. For browser apps, use localStorage:

```typescript
import { createClient, LocalStorageAdapter } from "@debros/network-ts-sdk";

const client = createClient({
  baseURL: "http://localhost:6001",
  storage: new LocalStorageAdapter(),
  apiKey: "ak_your_key:namespace",
});
```

## Error Handling

The SDK throws `SDKError` for all errors:

```typescript
import { SDKError } from "@debros/network-ts-sdk";

try {
  await client.db.query("SELECT * FROM nonexistent");
} catch (error) {
  if (error instanceof SDKError) {
    console.log(error.httpStatus); // e.g., 400
    console.log(error.code); // e.g., "HTTP_400"
    console.log(error.message); // Error message
    console.log(error.details); // Full error response
  }
}
```

## Browser Usage

The SDK works in browsers with minimal setup:

```typescript
// Browser example
import { createClient } from "@debros/network-ts-sdk";

const client = createClient({
  baseURL: "https://gateway.example.com",
  apiKey: "ak_browser_key:my-app",
});

// Use like any other API client
const data = await client.db.query("SELECT * FROM items");
```

**Note**: For WebSocket connections in browsers with authentication, ensure your gateway supports either header-based auth or query parameter auth.

## Testing

Run E2E tests against a running gateway:

```bash
# Set environment variables
export GATEWAY_BASE_URL=http://localhost:6001
export GATEWAY_API_KEY=ak_test_key:default

# Run tests
npm run test:e2e
```

## Examples

See the `tests/e2e/` directory for complete examples of:

- Authentication (`auth.test.ts`)
- Database operations (`db.test.ts`)
- Transactions (`tx.test.ts`)
- Pub/Sub messaging (`pubsub.test.ts`)
- Network operations (`network.test.ts`)

## Building

```bash
npm run build
```

Output goes to `dist/` with ESM and type declarations.

## Development

```bash
npm run dev      # Watch mode
npm run typecheck # Type checking
npm run lint     # Linting (if configured)
```

## License

MIT

## Support

For issues, questions, or contributions, please open an issue on GitHub or visit [DeBros Network Documentation](https://network.debros.io/docs/).
