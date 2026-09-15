import { createServer, type ServerResponse } from "node:http";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { toWebRequest } from "@modelcontextprotocol/node";
import { Readable } from "node:stream";

import { OrgClient } from "@simplepush/sdk";

import { AuthError, PRM_PATH, authenticate, protectedResourceMetadata, requireScope } from "./auth.js";
import { ConfigError, loadHttpConfig, type HttpConfig } from "./config.js";
import { Simplepush } from "./simplepush.js";
import { status } from "./status.js";
import { TOOL_SCOPES, buildServer } from "./tools.js";

const MCP_PATH = "/mcp";


function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

/** The tool a `tools/call` is aiming at, if this body is one. */
function calledTool(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const msg = body as { method?: unknown; params?: { name?: unknown } };
  if (msg.method !== "tools/call") return undefined;
  return typeof msg.params?.name === "string" ? msg.params.name : undefined;
}

export function main(): void {
  const config: HttpConfig = loadHttpConfig();

  // The SDK never inspects credentials: it takes `authInfo` as validated
  // pass-through. So authentication stays ours (auth.ts), and the handler is
  // handed the result. The factory runs per request, which is what keeps one
  // caller's token from ever serving another's call.
  const handler = createMcpHandler((ctx) => {
    // Which protocol revision the caller negotiated. `modern` is 2026-07-28;
    // `legacy` is a 2025-era client served through the compatibility path.
    // Worth logging: it is the only way to see, from the server, whether a
    // given client has moved to the new revision.
    console.error(`[mcp] ${ctx.era} request`);
    const token = ctx.authInfo?.token;
    if (!token) throw new Error("unauthenticated request reached the MCP handler");
    // Hosted = OAuth. A grant approved by an organization admin acts for the
    // whole organization (topics, members, broadcast; reads of the org record)
    // but holds no keys, so it sends in the clear and leaves org ciphertext
    // sealed. Any other grant is a personal user. Integration tokens are for
    // self-run servers and are not accepted here (introspection rejects them).
    const org = ctx.authInfo?.extra?.["accountType"] === "organization";
    const sp = new Simplepush({
      mode: org
        ? { kind: "org", client: new OrgClient({ bearerToken: token, baseUrl: config.baseUrl }) }
        : { kind: "personal", credential: { accessToken: token } },
      baseUrl: config.baseUrl,
      maxWaitSeconds: config.maxWaitSeconds,
      pollIntervalMs: config.pollIntervalMs,
    });
    // What the grant covers is what gets listed; the per-request scope check
    // above still guards a direct call for an unlisted tool.
    return buildServer(sp, config, new Set(ctx.authInfo?.scopes ?? []));
  });


  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Discovery is deliberately unauthenticated: a client with no token yet
    // must be able to read this to find out where to get one.
    if (req.method === "GET" && url.pathname === PRM_PATH) {
      json(res, 200, protectedResourceMetadata(config));
      return;
    }

    // Liveness/readiness for the orchestrator; the gateway does not expose it.
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { status: "ok" });
      return;
    }

    // Public, for the uptime monitor; 503 unless every dependency answers.
    if (req.method === "GET" && url.pathname === "/status") {
      void status(config).then((s) => {
        json(res, s.status === "operational" ? 200 : 503, s, { "Access-Control-Allow-Origin": "*" });
      });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      json(res, 404, { error: "not_found" });
      return;
    }

    void (async () => {
      try {
        const principal = await authenticate(req.headers.authorization, config);

        // Read the body once here for the scope check, then hand the same bytes
        // to the SDK — the stream can only be consumed a single time.
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks);
        let parsed: unknown;
        try {
          parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
        } catch {
          parsed = undefined;
        }
        // What the client declared this request. Extensions are opt-in on both
        // sides, so this is the only way to see whether a client offers e.g.
        // `io.modelcontextprotocol/tasks` before we consider implementing it.
        const caps = (parsed as { params?: { _meta?: Record<string, unknown> } })?.params?._meta?.[
          "io.modelcontextprotocol/clientCapabilities"
        ];
        if (caps !== undefined) console.error(`[mcp] clientCapabilities ${JSON.stringify(caps)}`);

        const tool = calledTool(parsed);
        if (tool && TOOL_SCOPES[tool]) requireScope(principal, TOOL_SCOPES[tool] as string, config);

        // Hand-wired rather than `toNodeHandler`, because that adapter takes
        // `parsedBody` positionally and has no way to pass `authInfo` — and
        // authInfo is the whole point: the SDK performs no token verification
        // of its own, it consumes what we validated.
        const request = await toWebRequest(req, parsed);
        const response = await handler.fetch(request, {
          authInfo: {
            token: principal.accessToken,
            clientId: principal.subject ?? "unknown",
            scopes: [...principal.scopes],
            resource: new URL(config.canonicalUri),
            extra: { accountType: principal.accountType },
          },
        });

        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k] = v;
        });
        res.writeHead(response.status, headers);
        if (response.body) {
          // Streams SSE incrementally; a plain JSON body just flushes once.
          await new Promise<void>((resolve, reject) => {
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
              .on("error", reject)
              .on("end", resolve)
              .pipe(res);
          });
        } else {
          res.end();
        }
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof AuthError) {
          json(res, err.status, { error: "unauthorized", message: err.message }, { "WWW-Authenticate": err.challenge });
          return;
        }
        console.error(err);
        json(res, 500, { error: "internal_error" });
      }
    })();
  });

  server.listen(config.port, () => {
    console.error(`simplepush mcp server listening on :${config.port}${MCP_PATH}`);
    console.error(`  audience: ${config.canonicalUri}`);
    console.error(`  authorization server: ${config.issuer}`);
  });
}

try {
  main();
} catch (err: unknown) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
