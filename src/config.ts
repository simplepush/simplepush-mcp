/** Process configuration, read once at startup.
 *
 * Split by transport because the two get their credential from opposite places.
 * On stdio the credential is ambient (an env var), which is what the MCP spec
 * prescribes: "implementations using an STDIO transport SHOULD NOT follow [the
 * authorization spec], and instead retrieve credentials from the environment."
 * On the hosted HTTP transport there is no ambient credential at all — each
 * request carries its own OAuth access token, so nothing here holds one.
 */
import type { KeysConfig } from "@simplepush/sdk";

export class ConfigError extends Error {}

export type SharedConfig = {
  baseUrl: string;
  /** Ceiling for how long `send_task` may block, in seconds. Per-call
   * `wait_seconds` is clamped to this. */
  maxWaitSeconds: number;
  pollIntervalMs: number;
};

/** The scope codes a tool can require; what SP_SCOPES may name. */
export const SCOPE_CODES = ["send", "read", "files:read"] as const;

export type StdioConfig =
  | (SharedConfig & {
      /** SP_SCOPES: list only the tools these scopes cover. A listing trim,
       * not an authorization boundary: the backend still treats the
       * credential as whatever it was minted with. */
      scopes?: ReadonlySet<string>;
      kind: "personal";
      apiToken: string;
      /** Personal keys exported from the app, for encrypted sends. See
       * `parseKeys` below for the format. Absent = send in the clear. */
      keys?: KeysConfig;
    })
  | (SharedConfig & {
      scopes?: ReadonlySet<string>;
      kind: "org";
      /** The full `spi_<credential>.<seed>` token; the SDK splits it and the
       * seed never sits in more places than necessary. */
      integrationToken: string;
    });

export type HttpConfig = SharedConfig & {
  port: number;
  /** Origin of the authorization server. Must match the `issuer` in its
   * metadata exactly — clients compare them. */
  issuer: string;
  /** Origin this server reaches the authorization server at for introspection.
   * The issuer is what clients see; in a cluster the same backend is closer on
   * an internal address. */
  authServerUrl: string;
  /** Static bearer we present to the AS's `/oauth/introspect`. */
  introspectionSecret: string;
  /** Our own canonical resource URI (RFC 8707 / RFC 9728). A token whose
   * audience does not name this is refused. */
  canonicalUri: string;
};

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

function shared(env: NodeJS.ProcessEnv): SharedConfig {
  return {
    baseUrl: env.SP_BASE_URL?.trim() || "https://api.simplepu.sh",
    maxWaitSeconds: intFromEnv(env, "SP_MAX_WAIT_SECONDS", 15 * 60),
    pollIntervalMs: intFromEnv(env, "SP_POLL_INTERVAL_MS", 2000),
  };
}

/** Parses `SP_SCOPES`, a space- or comma-separated list of scope codes:
 *
 *   SP_SCOPES="read files:read"   # the query and download tools only
 *   SP_SCOPES=read                # the query tools only
 */
function parseScopes(env: NodeJS.ProcessEnv): ReadonlySet<string> | undefined {
  const raw = env.SP_SCOPES?.trim();
  if (!raw) return undefined;
  const codes = raw.split(/[\s,]+/).filter(Boolean);
  const unknown = codes.filter((c) => !(SCOPE_CODES as readonly string[]).includes(c));
  if (unknown.length > 0) {
    throw new ConfigError(`SP_SCOPES names unknown scope(s) ${unknown.join(", ")}; the scopes are ${SCOPE_CODES.join(", ")}`);
  }
  return new Set(codes);
}

/** Parses `SP_KEYS` into the SDK's `keys` config.
 *
 * Format is a comma-separated list where a bare base64 key is the Personal
 * Password key (self-sends) and `topic=key` binds a key to one topic:
 *
 *   SP_KEYS="AbC...="                       # default key only
 *   SP_KEYS="alerts=AbC...=,deploys=XyZ...=" # two topic keys
 *   SP_KEYS="AbC...=,alerts=XyZ...="         # both
 *
 * Keys only; there is no SP_PASSWORD.
 */
function parseKeys(env: NodeJS.ProcessEnv): KeysConfig | undefined {
  const raw = env.SP_KEYS?.trim();
  if (!raw) return undefined;
  const entries: Array<string | [string, string]> = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    // A bare base64 key ends in '=' padding, so only an '=' with something
    // after it separates a topic from its key.
    if (eq > 0 && eq < part.length - 1) entries.push([part.slice(eq + 1), part.slice(0, eq)]);
    else entries.push(part);
  }
  return entries;
}

function scopesEntry(env: NodeJS.ProcessEnv): { scopes?: ReadonlySet<string> } {
  const scopes = parseScopes(env);
  return scopes !== undefined ? { scopes } : {};
}

export function loadStdioConfig(env: NodeJS.ProcessEnv = process.env): StdioConfig {
  const apiToken = env.SP_API_TOKEN?.trim();
  const integrationToken = env.SP_INTEGRATION_TOKEN?.trim();
  if (integrationToken) {
    // Deliberate beats ambient. MCP clients spawn stdio servers with the
    // parent shell's environment PLUS the configured one, so an SP_API_TOKEN
    // exported for unrelated CLI work rides along uninvited. Nobody sets
    // SP_INTEGRATION_TOKEN by accident — it wins, with a note rather than a
    // refusal (a hard conflict error here killed real servers whose only sin
    // was the shell they were spawned from).
    if (apiToken) {
      console.error("both SP_INTEGRATION_TOKEN and SP_API_TOKEN are set — using the integration token (org mode)");
    }
    return { ...shared(env), ...scopesEntry(env), kind: "org", integrationToken };
  }
  if (!apiToken) {
    throw new ConfigError(
      "A credential is required: SP_API_TOKEN (personal — API Token screen in the app) or " +
        "SP_INTEGRATION_TOKEN (org — printed by `sp integration create`).",
    );
  }
  const keys = parseKeys(env);
  return { ...shared(env), ...scopesEntry(env), kind: "personal", apiToken, ...(keys !== undefined ? { keys } : {}) };
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const introspectionSecret = env.SP_INTROSPECTION_SECRET?.trim();
  if (!introspectionSecret) {
    throw new ConfigError(
      "SP_INTROSPECTION_SECRET is required. It must match `oauth.introspectionSecret` on the backend.",
    );
  }
  const canonicalUri = env.SP_CANONICAL_URI?.trim();
  if (!canonicalUri) {
    throw new ConfigError(
      "SP_CANONICAL_URI is required — the public URL clients reach this server at, e.g. https://mcp.simplepu.sh/mcp. " +
        "Tokens are audience-bound to it, so a mismatch rejects every request.",
    );
  }
  const issuer = env.SP_OAUTH_ISSUER?.trim() || "https://api.simplepu.sh";
  return {
    ...shared(env),
    port: intFromEnv(env, "SP_MCP_PORT", 8787),
    issuer,
    authServerUrl: env.SP_AUTH_SERVER_URL?.trim() || issuer,
    introspectionSecret,
    canonicalUri,
  };
}
