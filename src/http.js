/**
 * Streamable HTTP transport for multi-user deployments.
 *
 * In stdio mode one process serves one person, so the ExcaliDash credentials come from the
 * environment. A chat front end with many users (LibreChat, Open WebUI) wants one shared server
 * where every request carries the caller's own ExcaliDash API key. This module serves MCP over
 * HTTP, reads that key from each request, and runs the request with a provider bound to it, so
 * every tool call acts with exactly the rights of the user whose key it carries.
 *
 * The server holds no credential of its own: a request without a key is refused with 401.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** The provider of the request being served; tool handlers resolve `provider` through it. */
export const providerContext = new AsyncLocalStorage();

/** Header a client sets to the user's ExcaliDash API key (`Authorization: Bearer` also works). */
export const API_KEY_HEADER = "x-excalidash-api-key";

/** Largest JSON-RPC body accepted; a whole scene is sent through draw tools, so leave room. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The API key a request carries, or "" when it has none. The dedicated header wins over a
 * bearer, because a proxy in front may use Authorization for its own purposes.
 */
export function requestApiKey(headers) {
  const direct = headers[API_KEY_HEADER];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (match) return match[1];
  }
  return "";
}

/**
 * Providers keyed by API key. A provider holds a Socket.IO connection and joined rooms, so it
 * is worth reusing across the calls of one conversation; an idle one is disconnected and
 * dropped after `idleMs`, and the cache never grows past `max` entries.
 */
export class ProviderCache {
  #entries = new Map();

  constructor(createProvider, { max = 64, idleMs = 15 * 60_000 } = {}) {
    this.createProvider = createProvider;
    this.max = max;
    this.idleMs = idleMs;
  }

  get(apiKey) {
    const now = Date.now();
    this.#evictIdle(now);
    let entry = this.#entries.get(apiKey);
    if (entry) {
      // Re-insert so iteration order stays least-recently-used first.
      this.#entries.delete(apiKey);
    } else {
      entry = { provider: this.createProvider(apiKey) };
      if (this.#entries.size >= this.max) this.#drop(this.#entries.keys().next().value);
    }
    entry.lastUsed = now;
    this.#entries.set(apiKey, entry);
    return entry.provider;
  }

  get size() {
    return this.#entries.size;
  }

  async closeAll() {
    const providers = [...this.#entries.values()].map((entry) => entry.provider);
    this.#entries.clear();
    await Promise.allSettled(providers.map((provider) => provider.disconnect()));
  }

  #evictIdle(now) {
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastUsed > this.idleMs) this.#drop(key);
    }
  }

  #drop(key) {
    const entry = this.#entries.get(key);
    this.#entries.delete(key);
    try {
      entry?.provider.disconnect();
    } catch {
      // A provider that fails to close is gone from the cache anyway.
    }
  }
}

/**
 * A stand-in for the module-level provider: every property is read from the provider of the
 * request being served, with methods bound to it (the provider uses private fields, which
 * require the real instance as `this`).
 */
export function contextualProvider() {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const provider = providerContext.getStore();
        if (!provider) {
          throw new Error("No ExcaliDash credentials for this request.");
        }
        const value = provider[property];
        return typeof value === "function" ? value.bind(provider) : value;
      },
    },
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJsonRpcError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Serve MCP over Streamable HTTP, stateless: every POST /mcp gets a fresh server and
 * transport, run inside the context of the caller's provider.
 *
 * @param {() => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} buildServer
 * @param {ProviderCache} providers
 */
export function startHttpServer(buildServer, providers, { host, port, path = "/mcp" } = {}) {
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    // Stateless mode has no session to stream to or terminate.
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const apiKey = requestApiKey(req.headers);
    if (!apiKey) {
      sendJsonRpcError(
        res,
        401,
        `Missing ExcaliDash API key: send it in the ${API_KEY_HEADER} header ` +
          "or as Authorization: Bearer.",
      );
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJsonRpcError(res, err.status ?? 400, err.message);
      return;
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await providerContext.run(providers.get(apiKey), async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      });
    } catch (err) {
      console.error("MCP request failed:", err);
      sendJsonRpcError(res, 500, "Internal server error");
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      console.error(`excalidash-mcp listening on http://${host}:${port}${path}`);
      resolve(httpServer);
    });
  });
}
