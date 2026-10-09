// `linkedin-ads-mcp auth`: 3-legged OAuth once, in the browser. Catches the
// redirect on localhost and stores access + refresh token in the token file.
// For server deployments, put the resulting refresh_token in your secret store
// as LINKEDIN_REFRESH_TOKEN (Walma chassis: Key Vault `mcp-linkedin-ads-refresh-token`).

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { TOKEN_URL, clientCreds, saveTokenFile, stamp, tokenFilePath, type TokenSet } from "./linkedin.js";

export const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const DEFAULT_SCOPES = "r_ads r_ads_reporting";

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(cmd, [url], () => { /* the URL is printed too */ });
}

export async function login(scopes = process.env.LINKEDIN_SCOPES || DEFAULT_SCOPES): Promise<void> {
  const { id, secret } = clientCreds();
  const port = Number(process.env.LINKEDIN_REDIRECT_PORT || 8790);
  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomBytes(16).toString("base64url");

  const code = await new Promise<string>((resolve, reject) => {
    const srv = createServer((req, res) => {
      const q = new URL(req.url ?? "/", redirectUri).searchParams;
      if (!q.get("code") && !q.get("error")) { res.statusCode = 404; res.end(); return; }
      const ok = q.get("state") === state && !!q.get("code");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(ok ? "Done, you can close this tab." : `Login failed: ${q.get("error_description") ?? "state mismatch"}`);
      srv.close();
      if (ok) resolve(q.get("code")!);
      else reject(new Error(`LinkedIn returned an error: ${q.get("error_description") ?? q.get("error") ?? "state mismatch"}`));
    }).listen(port, "localhost");

    const url = `${AUTH_URL}?${new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: redirectUri, state, scope: scopes })}`;
    console.error(`Opening browser for LinkedIn login (scopes: ${scopes})...\n${url}`);
    openBrowser(url);
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: id, client_secret: secret }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
  const tok: TokenSet = stamp(await resp.json() as TokenSet);
  saveTokenFile(tok);
  console.error(`Saved token to ${tokenFilePath()} (scopes: ${tok.scope ?? scopes})`);
}
