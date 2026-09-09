import type { HttpConfig } from "./config.js";

/** What the AS tells us about a presented token (RFC 7662). Only the fields we
 * act on are modelled. `aud` is present when the client used RFC 8707 resource
 * indicators; absent means the token was minted without an audience. */
type Introspection = {
  active: boolean;
  scope?: string;
  aud?: string[] | string;
  sub?: string;
  account_type?: string;
};

export type Principal = {
  accessToken: string;
  scopes: Set<string>;
  subject: string | undefined;
  /** Which account the grant was approved for on the consent page: a personal
   * user (API token) or an organization (admin sign-in). */
  accountType: "user" | "organization" | undefined;
};

export class AuthError extends Error {
  readonly status: number;
  /** Value for the `WWW-Authenticate` response header. */
  readonly challenge: string;
  constructor(status: number, challenge: string, message: string) {
    super(message);
    this.status = status;
    this.challenge = challenge;
  }
}

/** Where the protected-resource metadata document lives (RFC 9728). */
export const PRM_PATH = "/.well-known/oauth-protected-resource";

/** The scopes this server ever needs. Advertised in the metadata so clients can
 * ask for the minimum rather than everything. */
export const SCOPES_SUPPORTED = ["send", "read", "files:read"];

function metadataUrl(config: HttpConfig): string {
  return new URL(PRM_PATH, config.canonicalUri).toString();
}

/** RFC 9728 document. This is the entry point of the whole discovery chain: an
 * unauthenticated client is pointed here by the 401, and from here it learns
 * which authorization server to go to. */
export function protectedResourceMetadata(config: HttpConfig): Record<string, unknown> {
  return {
    resource: config.canonicalUri,
    authorization_servers: [config.issuer],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
  };
}

function challenge(config: HttpConfig, extra?: { error?: string; scope?: string; description?: string }): string {
  const parts = [`Bearer resource_metadata="${metadataUrl(config)}"`];
  if (extra?.error) parts.push(`error="${extra.error}"`);
  if (extra?.description) parts.push(`error_description="${extra.description}"`);
  if (extra?.scope) parts.push(`scope="${extra.scope}"`);
  return parts.join(", ");
}

function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const prefix = "bearer ";
  if (header.length <= prefix.length || header.slice(0, prefix.length).toLowerCase() !== prefix) return undefined;
  const value = header.slice(prefix.length).trim();
  return value.length > 0 ? value : undefined;
}

function audienceMatches(aud: Introspection["aud"], canonicalUri: string): boolean {
  // No audience at all: the client never sent `resource`. The MCP spec requires
  // clients to send it, but an AS that ignored it would mint audienceless
  // tokens, and refusing those outright would break every such deployment. We
  // accept them and rely on the AS having authenticated the user; what we
  // refuse is a token explicitly minted for someone ELSE.
  if (aud === undefined) return true;
  const list = Array.isArray(aud) ? aud : [aud];
  if (list.length === 0) return true;
  return list.includes(canonicalUri);
}

/** Validates the `Authorization` header of an MCP request.
 *
 * This is the resource-server half of OAuth: we do not run any flow, we check
 * what the authorization server minted. Three things must hold — the token is
 * live, it was issued FOR US (RFC 8707 audience binding, which is what stops a
 * token granted to another MCP server being replayed here), and it carries the
 * scope the operation needs.
 */
export async function authenticate(
  authorization: string | undefined,
  config: HttpConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Principal> {
  const token = bearerFrom(authorization);
  if (!token) {
    throw new AuthError(401, challenge(config), "Authorization required.");
  }

  const resp = await fetchImpl(new URL("/oauth/introspect", config.authServerUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.introspectionSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }).toString(),
  });
  if (!resp.ok) {
    // Our own credential to the AS is bad, or the AS is down. That is our
    // problem, not the caller's — do not report it as their token being bad.
    throw new AuthError(503, challenge(config), `Could not verify the token (AS returned ${resp.status}).`);
  }

  const intro = (await resp.json()) as Introspection;
  if (!intro.active) {
    throw new AuthError(401, challenge(config, { error: "invalid_token" }), "The access token is expired or revoked.");
  }
  if (!audienceMatches(intro.aud, config.canonicalUri)) {
    throw new AuthError(
      401,
      challenge(config, { error: "invalid_token" }),
      "This access token was issued for a different resource server.",
    );
  }

  return {
    accessToken: token,
    scopes: new Set((intro.scope ?? "").split(/\s+/).filter(Boolean)),
    subject: intro.sub,
    accountType: intro.account_type === "organization" || intro.account_type === "user" ? intro.account_type : undefined,
  };
}

/** Enforces a scope, as a 403 with the scope the client should re-request. */
export function requireScope(principal: Principal, scope: string, config: HttpConfig): void {
  if (principal.scopes.has(scope)) return;
  throw new AuthError(
    403,
    challenge(config, { error: "insufficient_scope", scope, description: `This operation needs the '${scope}' scope.` }),
    `This grant does not carry the '${scope}' scope.`,
  );
}
