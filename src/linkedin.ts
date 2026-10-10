// LinkedIn Marketing API client: OAuth token handling + the thin request layer
// the tools need. Deliberately just `fetch` — a handful of Rest.li endpoints
// don't justify an SDK, and an injectable interface keeps tests and the Walma
// MCP chassis free of network and credentials.
//
// Credentials (either mode needs LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET):
//   LINKEDIN_REFRESH_TOKEN  — server mode (Key Vault / chassis). The access
//                             token lives only in memory and is refreshed from it.
//   LINKEDIN_TOKEN_FILE     — local mode (default ~/.config/linkedin-ads-mcp/token.json),
//                             written by `linkedin-ads-mcp auth`; refreshes are saved back.
//
// LinkedIn access tokens last 60 days, refresh tokens 365 days, and a refresh
// does NOT extend the refresh token — so a year after `auth` someone signs in again.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const API = "https://api.linkedin.com/rest";
export const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
/** LinkedIn sunsets each monthly version after ~1 year; bump when it does. */
export const API_VERSION = process.env.LINKEDIN_API_VERSION || "202609";
/** Refresh this long before expiry so no request goes out with a dying token. */
const REFRESH_MARGIN_S = 24 * 3600;

export interface TokenSet {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  access_expires_at?: number;
  refresh_expires_at?: number;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

export interface Response {
  status: number;
  headers: Record<string, string>;
  data: any;
}

/** What the tools use — injectable for tests. */
export interface LinkedInClient {
  get(path: string, params?: Record<string, string>): Promise<any>;
  send(method: "POST" | "DELETE", path: string, body?: unknown, params?: Record<string, string>): Promise<Response>;
  uploadBinary(url: string, data: Uint8Array): Promise<void>;
  /** Scopes on the current token (e.g. to check for rw_ads). */
  scopes(): Promise<Set<string>>;
}

export function tokenFilePath(): string {
  const p = process.env.LINKEDIN_TOKEN_FILE || "~/.config/linkedin-ads-mcp/token.json";
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

export function clientCreds(): { id: string; secret: string } {
  const id = process.env.LINKEDIN_CLIENT_ID;
  const secret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!id || !secret) throw new Error("LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be set");
  return { id, secret };
}

/** Stamp absolute expiry times onto a fresh token response. */
export function stamp(tok: TokenSet, now = Math.floor(Date.now() / 1000)): TokenSet {
  const out = { ...tok };
  if (tok.expires_in) out.access_expires_at = now + Number(tok.expires_in);
  if (tok.refresh_token_expires_in) out.refresh_expires_at = now + Number(tok.refresh_token_expires_in);
  return out;
}

export function saveTokenFile(tok: TokenSet, path = tokenFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tok, null, 2));
  chmodSync(path, 0o600);
}

export function scopeSet(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
}

/** Token source: env refresh token (server) or the token file (local). */
function createTokenProvider() {
  const envRefresh = process.env.LINKEDIN_REFRESH_TOKEN;
  let tok: TokenSet = envRefresh ? { refresh_token: envRefresh, scope: process.env.LINKEDIN_SCOPES } : {};
  let loaded = !!envRefresh;

  function load(): TokenSet {
    if (loaded) return tok;
    const path = tokenFilePath();
    if (!existsSync(path)) {
      throw new Error(`No LinkedIn token at ${path}. Run \`linkedin-ads-mcp auth\` (or set LINKEDIN_REFRESH_TOKEN).`);
    }
    tok = JSON.parse(readFileSync(path, "utf8"));
    loaded = true;
    return tok;
  }

  async function refresh(): Promise<TokenSet> {
    const current = load();
    if (!current.refresh_token) throw new Error("Access token expired and no refresh token. Run `linkedin-ads-mcp auth`.");
    if (current.refresh_expires_at && current.refresh_expires_at < Date.now() / 1000) {
      throw new Error("LinkedIn refresh token expired (they last 365 days). Run `linkedin-ads-mcp auth` again.");
    }
    const { id, secret } = clientCreds();
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh_token, client_id: id, client_secret: secret }),
    });
    if (!resp.ok) throw new Error(`LinkedIn token refresh failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
    const fresh = stamp(await resp.json() as TokenSet);
    // LinkedIn keeps the original refresh-token expiry; carry over what isn't returned.
    tok = {
      ...fresh,
      refresh_token: fresh.refresh_token ?? current.refresh_token,
      refresh_expires_at: fresh.refresh_expires_at ?? current.refresh_expires_at,
      scope: fresh.scope ?? current.scope,
    };
    if (!envRefresh) saveTokenFile(tok);
    return tok;
  }

  return {
    async accessToken(): Promise<string> {
      let t = load();
      if (!t.access_token || (t.access_expires_at ?? 0) - REFRESH_MARGIN_S < Date.now() / 1000) t = await refresh();
      return t.access_token!;
    },
    async scopes(): Promise<Set<string>> {
      let t = load();
      if (!t.scope && t.refresh_token) t = await refresh();
      return scopeSet(t.scope);
    },
  };
}

/** Build the query string by hand: Rest.li params are pre-encoded and their
 * parentheses and commas must reach LinkedIn unescaped. */
export function buildUrl(path: string, params?: Record<string, string>): string {
  const qs = params ? Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&") : "";
  return `${API}${path}${qs ? `?${qs}` : ""}`;
}

async function errorFrom(resp: globalThis.Response, path: string): Promise<Error> {
  let msg = await resp.text();
  try {
    const body = JSON.parse(msg);
    msg = body.message ?? msg;
    // Validation errors carry the useful part (which field, why) in errorDetails.
    if (body.errorDetails) msg += ` — ${JSON.stringify(body.errorDetails)}`;
  } catch { /* not JSON */ }
  return new Error(`LinkedIn API ${resp.status} on ${path}: ${msg.slice(0, 1000)}`);
}

export function createLinkedInClient(): LinkedInClient {
  const tokens = createTokenProvider();
  const headers = async () => ({
    authorization: `Bearer ${await tokens.accessToken()}`,
    "linkedin-version": API_VERSION,
    "x-restli-protocol-version": "2.0.0",
  });

  return {
    async get(path, params) {
      const resp = await fetch(buildUrl(path, params), { headers: await headers() });
      if (!resp.ok) throw await errorFrom(resp, path);
      return resp.json();
    },
    async send(method, path, body, params) {
      const resp = await fetch(buildUrl(path, params), {
        method,
        headers: { ...(await headers()), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!resp.ok) throw await errorFrom(resp, path);
      const text = await resp.text();
      return {
        status: resp.status,
        headers: Object.fromEntries(resp.headers.entries()),
        data: text ? JSON.parse(text) : null,
      };
    },
    async uploadBinary(url, data) {
      const resp = await fetch(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${await tokens.accessToken()}` },
        // Copy into a plain ArrayBuffer-backed view: fetch types reject SharedArrayBuffer-backed arrays.
        body: new Blob([new Uint8Array(data)]),
      });
      if (!resp.ok) throw new Error(`Image upload failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
    },
    scopes: () => tokens.scopes(),
  };
}

/** New entity ID from a 201: x-restli-id (sometimes a URN) or x-linkedin-id. */
export function createdId(headers: Record<string, string>): string {
  const rid = headers["x-restli-id"] || headers["x-linkedin-id"] || "";
  return rid.split(":").pop() ?? "";
}
