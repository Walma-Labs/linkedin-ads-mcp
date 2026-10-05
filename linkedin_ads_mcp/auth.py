"""OAuth 2.0 (3-legged) for the LinkedIn Marketing API.

Run `linkedin-ads-mcp auth` once: it opens the browser, catches the redirect on
localhost and stores access + refresh tokens in TOKEN_FILE. The server refreshes
the access token (60 days) from the refresh token (365 days) automatically.
"""
from __future__ import annotations

import json
import os
import secrets
import stat
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
DEFAULT_SCOPES = "r_ads r_ads_reporting"
REDIRECT_PORT = int(os.environ.get("LINKEDIN_REDIRECT_PORT", "8790"))
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/callback"
TOKEN_FILE = Path(
    os.environ.get("LINKEDIN_TOKEN_FILE", "~/.config/linkedin-ads-mcp/token.json")
).expanduser()
# Refresh this long before expiry so a request never goes out with a dying token.
REFRESH_MARGIN = 24 * 3600


def _client_creds() -> tuple[str, str]:
    cid = os.environ.get("LINKEDIN_CLIENT_ID")
    secret = os.environ.get("LINKEDIN_CLIENT_SECRET")
    if not cid or not secret:
        raise RuntimeError("LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be set")
    return cid, secret


def _save(tok: dict) -> None:
    now = int(time.time())
    tok["access_expires_at"] = now + int(tok.get("expires_in", 0))
    if "refresh_token_expires_in" in tok:
        tok["refresh_expires_at"] = now + int(tok["refresh_token_expires_in"])
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    TOKEN_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)


def _load() -> dict:
    if not TOKEN_FILE.exists():
        raise RuntimeError(f"No token at {TOKEN_FILE}. Run `linkedin-ads-mcp auth` first.")
    return json.loads(TOKEN_FILE.read_text())


def _refresh(tok: dict) -> dict:
    refresh = tok.get("refresh_token")
    if not refresh:
        raise RuntimeError("Access token expired and no refresh token. Run `linkedin-ads-mcp auth`.")
    if tok.get("refresh_expires_at", float("inf")) < time.time():
        raise RuntimeError("Refresh token expired. Run `linkedin-ads-mcp auth`.")
    cid, secret = _client_creds()
    resp = httpx.post(TOKEN_URL, data={
        "grant_type": "refresh_token", "refresh_token": refresh,
        "client_id": cid, "client_secret": secret,
    }, timeout=30)
    resp.raise_for_status()
    new = resp.json()
    # LinkedIn keeps the original refresh-token expiry; carry it over if not returned.
    new.setdefault("refresh_token", refresh)
    if "refresh_token_expires_in" not in new and "refresh_expires_at" in tok:
        new["refresh_token_expires_in"] = int(tok["refresh_expires_at"] - time.time())
    _save(new)
    return new


def access_token() -> str:
    tok = _load()
    if tok.get("access_expires_at", 0) - REFRESH_MARGIN < time.time():
        tok = _refresh(tok)
    return tok["access_token"]


def login(scopes: str | None = None) -> None:
    cid, secret = _client_creds()
    scopes = scopes or os.environ.get("LINKEDIN_SCOPES", DEFAULT_SCOPES)
    state = secrets.token_urlsafe(16)
    result: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            qs = parse_qs(urlparse(self.path).query)
            result.update({k: v[0] for k, v in qs.items()})
            ok = "code" in result and result.get("state") == state
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"Done, you can close this tab." if ok
                else f"Login failed: {result.get('error_description', 'state mismatch')}".encode()
            )

        def log_message(self, *_):
            pass

    url = AUTH_URL + "?" + urlencode({
        "response_type": "code", "client_id": cid, "redirect_uri": REDIRECT_URI,
        "state": state, "scope": scopes,
    })
    print(f"Opening browser for LinkedIn login (scopes: {scopes})...\n{url}")
    webbrowser.open(url)
    with HTTPServer(("localhost", REDIRECT_PORT), Handler) as srv:
        while "code" not in result and "error" not in result:
            srv.handle_request()
    if "error" in result:
        raise SystemExit(f"LinkedIn returned an error: {result.get('error_description', result['error'])}")
    if result.get("state") != state:
        raise SystemExit("State mismatch, aborting.")

    resp = httpx.post(TOKEN_URL, data={
        "grant_type": "authorization_code", "code": result["code"],
        "redirect_uri": REDIRECT_URI, "client_id": cid, "client_secret": secret,
    }, timeout=30)
    resp.raise_for_status()
    _save(resp.json())
    print(f"Saved token to {TOKEN_FILE}")
