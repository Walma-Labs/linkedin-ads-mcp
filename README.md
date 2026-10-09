# linkedin-ads-mcp — LinkedIn Ads MCP server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, Cursor, Claude Code and other MCP clients read access to LinkedIn Campaign Manager: accounts, campaigns, creatives, performance, period comparisons and audience demographics.

Built by [Walma AI](https://walma.ai) to run our own LinkedIn ads through Claude Code.

## Tools

| Tool | What it does |
|---|---|
| `list_ad_accounts` | Ad accounts you have a role on, with currency, status and role |
| `list_campaigns` | Campaigns and campaign groups with status, objective, budgets and bids |
| `get_performance` | Impressions, clicks, cost, conversions and leads per account, group, campaign, creative or demographic (job function, seniority, industry, company, company size, country), with CTR/CPC/CPM/cost per lead |
| `compare_periods` | Two date ranges side by side with deltas, per campaign or any other pivot |
| `list_creatives` | Ads per account or campaign with status and review state |

| `search_targeting` | Targeting URNs (locations, job titles, seniorities, company sizes, industries …) |
| `create_campaign_group` / `create_campaign` / `create_ad` | Build a campaign as **drafts** (needs `rw_ads`) |
| `delete_draft` | Remove a draft this server created |

The default scopes are `r_ads r_ads_reporting`, so the server cannot change anything. To let it build campaigns, log in once with `LINKEDIN_SCOPES='r_ads r_ads_reporting rw_ads' linkedin-ads-mcp auth`. Even then everything is created as `DRAFT` and there is no tool that activates anything: a person reviews and launches in Campaign Manager, so no money is spent from a chat. Ads are posted as the ad account's company page; if LinkedIn refuses that, add `w_organization_social` to the scopes.

## Setup

1. Create an app at [developer.linkedin.com](https://www.linkedin.com/developers/apps) linked to your company page, and request the **Advertising API** product.
2. Under *Auth*, add the redirect URL `http://localhost:8790/callback`.
3. Your LinkedIn user needs a role (Viewer or higher) on each ad account in Campaign Manager.
4. Install and sign in once:

```bash
git clone https://github.com/Walma-Labs/linkedin-ads-mcp && cd linkedin-ads-mcp
python -m venv .venv && .venv/bin/pip install -e .
export LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=...
.venv/bin/linkedin-ads-mcp auth
```

Tokens are stored in `~/.config/linkedin-ads-mcp/token.json` (mode 600). The access token lasts 60 days and is refreshed automatically from the refresh token, which lasts 365 days.

5. Add it to Claude Code:

```bash
claude mcp add linkedin-ads -s user \
  -e LINKEDIN_CLIENT_ID=... -e LINKEDIN_CLIENT_SECRET=... \
  -- /path/to/linkedin-ads-mcp/.venv/bin/linkedin-ads-mcp
```

## Configuration

| Variable | Default | |
|---|---|---|
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | — | From your developer app |
| `LINKEDIN_API_VERSION` | `202609` | `LinkedIn-Version` header (YYYYMM). LinkedIn retires versions after about a year. |
| `LINKEDIN_TOKEN_FILE` | `~/.config/linkedin-ads-mcp/token.json` | |
| `LINKEDIN_REDIRECT_PORT` | `8790` | Must match the redirect URL in the app |
| `LINKEDIN_SCOPES` | `r_ads r_ads_reporting` | Used by `auth` |

## License

MIT
