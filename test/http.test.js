import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  API_KEY_HEADER,
  ProviderCache,
  contextualProvider,
  providerContext,
  requestApiKey,
  startHttpServer,
} from "../src/http.js";

test("requestApiKey prefers the dedicated header over a bearer", () => {
  assert.equal(requestApiKey({ [API_KEY_HEADER]: " exd_a ", authorization: "Bearer exd_b" }), "exd_a");
  assert.equal(requestApiKey({ authorization: "Bearer exd_b" }), "exd_b");
  assert.equal(requestApiKey({ authorization: "Basic abc" }), "");
  assert.equal(requestApiKey({}), "");
});

test("ProviderCache reuses a provider per key and disconnects evicted ones", () => {
  const disconnected = [];
  const cache = new ProviderCache(
    (key) => ({ key, disconnect: () => disconnected.push(key) }),
    { max: 2 },
  );
  const a = cache.get("a");
  assert.equal(cache.get("a"), a);
  cache.get("b");
  cache.get("a"); // a is now the most recently used
  cache.get("c"); // evicts b, the least recently used
  assert.deepEqual(disconnected, ["b"]);
  assert.equal(cache.size, 2);
});

test("ProviderCache drops providers idle for longer than idleMs", () => {
  const disconnected = [];
  const cache = new ProviderCache(
    (key) => ({ key, disconnect: () => disconnected.push(key) }),
    { idleMs: -1 },
  );
  cache.get("a");
  cache.get("b");
  assert.deepEqual(disconnected, ["a"]);
});

test("contextualProvider reads from the provider of the current request", async () => {
  class Fake {
    #secret;
    constructor(secret) { this.#secret = secret; this.name = secret; }
    reveal() { return this.#secret; }
  }
  const provider = contextualProvider();
  assert.throws(() => provider.reveal(), /No ExcaliDash credentials/);
  await providerContext.run(new Fake("alice"), async () => {
    assert.equal(provider.reveal(), "alice");
    assert.equal(provider.name, "alice");
  });
});

async function post(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return { status: res.status, json: data ? JSON.parse(data.slice(6)) : JSON.parse(text) };
}

test("each HTTP request runs with the provider of the key it carries", async () => {
  const provider = contextualProvider();
  const buildServer = () => {
    const server = new McpServer({ name: "test", version: "0" });
    server.registerTool("whoami", { inputSchema: { n: z.number().optional() } }, async () => ({
      content: [{ type: "text", text: provider.user }],
    }));
    return server;
  };
  const providers = new ProviderCache((key) => ({ user: `user-of-${key}`, disconnect() {} }));
  const httpServer = await startHttpServer(buildServer, providers, { host: "127.0.0.1", port: 0 });
  const { port } = httpServer.address();
  try {
    const anonymous = await post(port, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(anonymous.status, 401);

    const call = (key) =>
      post(
        port,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } },
        { [API_KEY_HEADER]: key },
      );
    const [alice, bob] = await Promise.all([call("alice"), call("bob")]);
    assert.equal(alice.json.result.content[0].text, "user-of-alice");
    assert.equal(bob.json.result.content[0].text, "user-of-bob");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
