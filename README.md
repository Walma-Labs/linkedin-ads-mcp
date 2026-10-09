# linkedin-ads-mcp — LinkedIn Ads MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, Cursor, Claude Code and other MCP clients access to LinkedIn Campaign Manager: accounts, campaigns, creatives, performance, period comparisons and audience demographics — plus, opt-in, building campaigns as **drafts**.

Built by [Walma AI](https://walma.ai) to run our own LinkedIn ads through Claude, and hosted per customer on the Walma MCP chassis.

## Tools

| Tool | What it does |
|---|---|
| `list_ad_accounts` | Ad accounts you have a role on, with currency, status, serving status and role |
| `list_campaigns` | Campaigns and campaign groups with status, objective, budgets and bids |
| `get_performance` | Impressions, clicks, cost, conversions and leads per account, group, campaign, creative or demographic (job function, seniority, industry, company, company size, country), with CTR/CPC/CPM/cost per lead |
| `compare_periods` | Two date ranges side by side with deltas, per campaign or any other pivot |
| `list_creatives` | Ads per account or campaign with status and review state |
| `search_targeting` | Targeting URNs: locations, job titles, seniorities, company sizes, industries … |
| `create_campaign_group` / `create_campaign` / `create_ad` | Build a campaign as **drafts** (opt-in, needs `rw_ads`) |
| `delete_draft` | Remove a draft |

### Safety model

- **Read-only by default.** The default scopes are `r_ads r_ads_reporting`.
- **Drafts only.** With `rw_ads`, the building tools create everything as `DRAFT`, and there is no tool that activates, pauses or edits a live campaign. A person reviews and launches in Campaign Manager, so no money is spent from a conversation.
- **EU political-ads notice.** `create_campaign` refuses until the advertiser has confirmed LinkedIn's not-political-advertising statement (it is sent as `politicalIntent`).
- **Server mode is sandboxed.** `create_ad` reads local image files only in the local stdio bin; as a hosted server it accepts public `https` image URLs, checked against private and internal addresses.

## Setup

1. Create an app at [developer.linkedin.com](https://www.linkedin.com/developers/apps) linked to your company page and request the **Advertising API** product.
2. Under *Auth*, add the redirect URL `http://localhost:8790/callback`.
3. On the Development tier, add each ad account the app may manage under *Products → Advertising API → View ad accounts* (max 5; needed for writes).
4. Your LinkedIn user needs a role on each ad account (Viewer to read, Campaign Manager or higher to build drafts).
5. Sign in once:

```bash
export LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=...
npx @walma-labs/linkedin-ads-mcp auth
# drafts too:
LINKEDIN_SCOPES='r_ads r_ads_reporting rw_ads' npx @walma-labs/linkedin-ads-mcp auth
```

Tokens go to `~/.config/linkedin-ads-mcp/token.json` (mode 600). Access tokens last 60 days and refresh automatically; the refresh token lasts 365 days, then sign in again.

6. Add it to Claude Code:

```bash
claude mcp add linkedin-ads -s user \
  -e LINKEDIN_CLIENT_ID=... -e LINKEDIN_CLIENT_SECRET=... \
  -- npx -y @walma-labs/linkedin-ads-mcp
```

## Hosted (Walma MCP chassis)

The package exports `createLinkedInAdsServer(client, options)` and `createLinkedInClient()`. In server mode the client reads `LINKEDIN_REFRESH_TOKEN` (plus client ID/secret) from the environment and keeps the access token in memory only. Draft tools are off unless `LINKEDIN_ADS_DRAFT_TOOLS=1`.

## Configuration

| Variable | Default | |
|---|---|---|
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | — | From your developer app |
| `LINKEDIN_REFRESH_TOKEN` | — | Server mode: use this instead of a token file |
| `LINKEDIN_TOKEN_FILE` | `~/.config/linkedin-ads-mcp/token.json` | Local mode |
| `LINKEDIN_SCOPES` | `r_ads r_ads_reporting` | Used by `auth` |
| `LINKEDIN_ADS_DRAFT_TOOLS` | `1` locally, off in server mode | Register the draft-building tools |
| `LINKEDIN_API_VERSION` | `202609` | `LinkedIn-Version` header (YYYYMM). LinkedIn retires versions after about a year. |
| `LINKEDIN_REDIRECT_PORT` | `8790` | Must match the redirect URL in the app |

## Development

```bash
npm install   # builds via prepare
npm test      # vitest: logic + the real MCP wire against a mocked LinkedIn client
```

## License

MIT
