// Drive the real MCP wire (in-memory transport) against a mocked LinkedIn
// client: tool registration, request shapes sent to LinkedIn, and the draft-only
// guard rails — without network or credentials.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLinkedInAdsServer, type ServerOptions } from "../src/server.js";
import type { LinkedInClient } from "../src/linkedin.js";

function fake(opts: { scopes?: string[]; status?: string } = {}) {
  const gets: Array<[string, Record<string, string> | undefined]> = [];
  const sends: Array<{ method: string; path: string; body: any; params?: Record<string, string> }> = [];
  const client: LinkedInClient = {
    async get(path, params) {
      gets.push([path, params]);
      if (path === "/adAccountUsers") return { elements: [{ account: "urn:li:sponsoredAccount:5", role: "ACCOUNT_MANAGER" }] };
      if (path === "/adAccounts/5") return { name: "Walma", currency: "SEK", status: "ACTIVE", type: "BUSINESS", reference: "urn:li:organization:77" };
      if (path === "/adAnalytics") {
        return { elements: [{ pivotValues: ["urn:li:sponsoredCampaign:9"], impressions: 1000, clicks: 20, costInLocalCurrency: "400", oneClickLeads: 2 }] };
      }
      if (path.endsWith("/adCampaigns")) return { elements: [{ id: 9, name: "AI Hub", status: "COMPLETED", campaignGroup: "urn:li:sponsoredCampaignGroup:3", dailyBudget: { amount: "400", currencyCode: "SEK" } }] };
      if (path.endsWith("/adCampaignGroups")) return { elements: [{ id: 3, name: "Q4", status: "ACTIVE" }] };
      if (/adCampaigns\/\d+$/.test(path)) return { status: opts.status ?? "DRAFT" };
      return { elements: [] };
    },
    async send(method, path, body, params) {
      sends.push({ method, path, body, params });
      return { status: 201, headers: { "x-restli-id": "urn:li:sponsoredCampaign:123" }, data: null };
    },
    async uploadBinary() { /* not used */ },
    async scopes() { return new Set(opts.scopes ?? ["r_ads", "r_ads_reporting"]); },
  };
  return { client, gets, sends };
}

async function connect(client: LinkedInClient, opts: ServerOptions = {}) {
  const server = createLinkedInAdsServer(client, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(b), mcp.connect(a)]);
  return mcp;
}

const text = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(text(r));

describe("linkedin-ads MCP server", () => {
  it("is read-only unless draft tools are enabled", async () => {
    const ro = await connect(fake().client);
    const names = (await ro.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_ad_accounts", "list_campaigns", "get_performance", "compare_periods", "list_creatives", "search_targeting"]));
    expect(names).not.toContain("create_campaign");

    const rw = await connect(fake().client, { draftTools: true });
    expect((await rw.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(["create_campaign_group", "create_campaign", "create_ad", "delete_draft"]));
    // No tool may ever activate anything.
    expect((await rw.listTools()).tools.map(t => t.name).some(n => /activate|launch|update|status/.test(n))).toBe(false);
  });

  it("lists accounts and leaves COMPLETED out of the campaign-group search", async () => {
    const f = fake();
    const mcp = await connect(f.client);
    expect(json(await mcp.callTool({ name: "list_ad_accounts", arguments: {} }))[0]).toMatchObject({ id: "5", name: "Walma", currency: "SEK" });
    const res = json(await mcp.callTool({ name: "list_campaigns", arguments: { account_id: "5" } }));
    expect(res.campaigns[0]).toMatchObject({ name: "AI Hub", dailyBudget: "400 SEK", group: "3" });
    const camp = f.gets.find(([p]) => p === "/adAccounts/5/adCampaigns" && p)!;
    const grp = f.gets.find(([p]) => p === "/adAccounts/5/adCampaignGroups")!;
    expect(camp[1]!.search).toContain("COMPLETED");
    expect(grp[1]!.search).not.toContain("COMPLETED");
  });

  it("computes performance with names and derived metrics", async () => {
    const mcp = await connect(fake().client);
    const res = json(await mcp.callTool({ name: "get_performance", arguments: { account_id: "5", start_date: "2026-09-01", end_date: "2026-09-30" } }));
    expect(res.rows[0]).toMatchObject({ pivot: "AI Hub", cpc: 20, costPerConversionOrLead: 200 });
    expect(res.totals).toMatchObject({ clicks: 20, costInLocalCurrency: 400 });
  });

  it("refuses to write without rw_ads", async () => {
    const mcp = await connect(fake({ scopes: ["r_ads"] }).client, { draftTools: true });
    const r = await mcp.callTool({ name: "create_campaign_group", arguments: { account_id: "5", name: "x", start_date: "2026-10-20" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/read-only/);
  });

  it("creates campaigns only as drafts, after the political-ads confirmation", async () => {
    const f = fake({ scopes: ["r_ads", "rw_ads"] });
    const mcp = await connect(f.client, { draftTools: true });
    const args = {
      account_id: "5", campaign_group_id: "3", name: "AI Hub", objective: "LEAD_GENERATION", daily_budget: 400,
      targeting: { locations: ["urn:li:geo:105117694"] }, start_date: "2026-10-20",
    };
    const refused = await mcp.callTool({ name: "create_campaign", arguments: args });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/not political advertising/);
    expect(f.sends).toHaveLength(0);

    const ok = json(await mcp.callTool({ name: "create_campaign", arguments: { ...args, advertiser_confirmed_not_political: true } }));
    expect(ok).toMatchObject({ id: "123", status: "DRAFT" });
    expect(f.sends[0]!.body).toMatchObject({
      status: "DRAFT", politicalIntent: "NOT_POLITICAL", objectiveType: "LEAD_GENERATION", optimizationTargetType: "MAX_LEAD",
      dailyBudget: { amount: "400.00", currencyCode: "SEK" }, locale: { language: "sv", country: "SE" },
    });
  });

  it("never reads local files unless running locally", async () => {
    const mcp = await connect(fake({ scopes: ["rw_ads"] }).client, { draftTools: true });
    const r = await mcp.callTool({ name: "create_ad", arguments: {
      account_id: "5", campaign_id: "9", name: "x", intro_text: "x", headline: "x", image_path: "/proc/self/environ", landing_page: "https://walma.ai",
    } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/only available when running locally/);
  });

  it("only deletes drafts", async () => {
    const live = await connect(fake({ scopes: ["rw_ads"], status: "ACTIVE" }).client, { draftTools: true });
    const r = await live.callTool({ name: "delete_draft", arguments: { account_id: "5", kind: "campaign", entity_id: "9" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Refusing/);
  });
});
