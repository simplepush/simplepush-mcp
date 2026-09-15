import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { ConfigError, loadStdioConfig } from "./config.js";
import { OrgClient } from "@simplepush/sdk";
import { Simplepush, type Mode } from "./simplepush.js";
import { buildServer, toolsFor } from "./tools.js";

async function resolveMode(config: ReturnType<typeof loadStdioConfig>): Promise<Mode> {
  if (config.kind === "personal") {
    return { kind: "personal", credential: { apiToken: config.apiToken }, ...(config.keys !== undefined ? { keys: config.keys } : {}) };
  }
  // Org: the SDK splits the token, fetches this integration's wrapped master
  // keys and unwraps them with the seed — all before serving, so a revoked
  // credential or undecryptable key material fails LOUDLY at startup instead
  // of on the first tool call.
  const client = await OrgClient.fromIntegrationToken(config.integrationToken, { baseUrl: config.baseUrl });
  console.error(
    client.orgEncryptionEnabled
      ? "org master keys unwrapped; sends will be encrypted"
      : "org encryption is not enabled (or no keys are wrapped to this integration) — sends will be plaintext",
  );
  return { kind: "org", client };
}

async function main(): Promise<void> {
  const config = loadStdioConfig();
  const mode = await resolveMode(config);

  // One client for the process: stdio serves a single principal with one
  // ambient credential. (The hosted HTTP transport is the opposite case —
  // see http.ts.)
  const sp = new Simplepush({
    mode,
    baseUrl: config.baseUrl,
    maxWaitSeconds: config.maxWaitSeconds,
    pollIntervalMs: config.pollIntervalMs,
  });

  // Only the tools the grant covers are listed. An integration token reports
  // the scopes it was minted with; a personal token has none, so every tool.
  // SP_SCOPES narrows either: what is configured AND (where known) minted.
  const minted = mode.kind === "org" ? mode.client.scopes : undefined;
  const granted =
    config.scopes === undefined ? minted : minted === undefined ? config.scopes : new Set([...config.scopes].filter((s) => minted.has(s)));
  if (granted !== undefined) console.error(`tools listed for scopes [${[...granted].join(", ")}]: ${toolsFor(granted).join(", ")}`);
  const handle = serveStdio(() => buildServer(sp, config, granted));

  // stdout is the protocol channel — anything written there that is not a
  // JSON-RPC message corrupts the session. Diagnostics go to stderr, which is
  // also what the spec now recommends given Logging is deprecated.
  const shutdown = (): void => {
    void handle.close?.();
    void sp.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(`simplepush mcp server ready on stdio (${mode.kind} mode)`);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
