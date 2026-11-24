// Drive the real MCP wire (in-memory transport) against a mocked LinkedIn
// client: tool registration, request shapes sent to LinkedIn, and the draft-only
// guard rails — without network or credentials.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLinkedInAdsServer, parseAccountIds, restrictClient, type ServerOptions } from "../src/server.js";
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

  describe("account restriction", () => {
    // The signed-in user has a role on three accounts; this server is for account 5 only.
    function shared() {
      const gets: string[] = [];
      const sends: string[] = [];
      const client: LinkedInClient = {
        async get(path, params) {
          gets.push(path + (params?.accounts ? `?accounts=${params.accounts}` : "") + (params?.campaigns ? `?campaigns=${params.campaigns}` : ""));
          if (path === "/adAccountUsers") {
            return { elements: ["5", "6", "7"].map(id => ({ account: `urn:li:sponsoredAccount:${id}`, role: "ACCOUNT_MANAGER" })) };
          }
          const acc = /^\/adAccounts\/(\d+)$/.exec(path);
          if (acc) return { name: `Account ${acc[1]}`, currency: "SEK", status: "ACTIVE", reference: "urn:li:organization:77" };
          // Campaign 9 and group 3 are in account 5; campaign 60 and group 61 are in account 6.
          const ent = /^\/adAccounts\/(\d+)\/(adCampaigns|adCampaignGroups)\/(\d+)$/.exec(path);
          if (ent) return { status: "DRAFT", account: `urn:li:sponsoredAccount:${["9", "3"].includes(ent[3]!) ? "5" : "6"}` };
          return { elements: [] };
        },
        async send(method, path) {
          sends.push(`${method} ${path}`);
          return { status: 201, headers: { "x-restli-id": "1" }, data: { value: {} } };
        },
        async uploadBinary() { /* not used */ },
        async scopes() { return new Set(["r_ads", "r_ads_reporting", "rw_ads"]); },
      };
      return { client, gets, sends };
    }
    const only5: ServerOptions = { accountIds: ["5"], draftTools: true };
    const refused = async (mcp: Client, name: string, args: Record<string, unknown>, match: RegExp) => {
      const r: any = await mcp.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(match);
    };

    it("lists only the allowed accounts and never fetches the others", async () => {
      const f = shared();
      const mcp = await connect(f.client, only5);
      expect(json(await mcp.callTool({ name: "list_ad_accounts", arguments: {} })).map((a: any) => a.id)).toEqual(["5"]);
      expect(f.gets.filter(p => /^\/adAccounts\/[67]/.test(p))).toEqual([]);
    });

    it("refuses every tool for an account outside the list, before calling LinkedIn", async () => {
      const f = shared();
      const mcp = await connect(f.client, only5);
      const na = /not available on this server/;
      await refused(mcp, "list_campaigns", { account_id: "6" }, na);
      await refused(mcp, "get_performance", { account_id: "6" }, na);
      await refused(mcp, "compare_periods", { account_id: "6", current_start: "2026-09-01", current_end: "2026-09-30", previous_start: "2026-08-01", previous_end: "2026-08-31" }, na);
      await refused(mcp, "list_creatives", { account_id: "6" }, na);
      await refused(mcp, "create_campaign_group", { account_id: "6", name: "x", start_date: "2026-12-01" }, na);
      await refused(mcp, "create_ad", { account_id: "6", campaign_id: "60", name: "x", intro_text: "x", headline: "x", image_urn: "urn:li:image:1", landing_page: "https://example.com" }, na);
      await refused(mcp, "delete_draft", { account_id: "6", kind: "campaign", entity_id: "60" }, na);
      expect(f.gets).toEqual([]);
      expect(f.sends).toEqual([]);
    });

    it("refuses another account's campaign or group passed under an allowed account", async () => {
      const f = shared();
      const mcp = await connect(f.client, only5);
      const other = /does not belong to ad account 5/;
      await refused(mcp, "get_performance", { account_id: "5", campaign_ids: ["60"] }, other);
      await refused(mcp, "list_creatives", { account_id: "5", campaign_ids: ["9", "60"] }, other);
      await refused(mcp, "create_ad", { account_id: "5", campaign_id: "60", name: "x", intro_text: "x", headline: "x", image_urn: "urn:li:image:1", landing_page: "https://example.com" }, other);
      await refused(mcp, "create_campaign", {
        account_id: "5", campaign_group_id: "61", name: "x", objective: "WEBSITE_VISIT", daily_budget: 100,
        targeting: { locations: ["urn:li:geo:1"] }, start_date: "2026-12-01", advertiser_confirmed_not_political: true,
      }, other);
      expect(f.gets.some(p => p.startsWith("/adAnalytics"))).toBe(false);
      expect(f.sends).toEqual([]);
      // The account's own campaign still works.
      const ok: any = await mcp.callTool({ name: "get_performance", arguments: { account_id: "5", campaign_ids: ["9"] } });
      expect(ok.isError).toBeFalsy();
    });

    it("refuses IDs that are not plain numbers, with or without a restriction", async () => {
      for (const opts of [only5, { draftTools: true }]) {
        const f = shared();
        const mcp = await connect(f.client, opts);
        await refused(mcp, "list_campaigns", { account_id: "5/../6" }, /numeric ID/);
        await refused(mcp, "get_performance", { account_id: "5", campaign_ids: ["9),urn:li:sponsoredCampaign:60"] }, /numeric ID/);
        await refused(mcp, "delete_draft", { account_id: "5", kind: "campaign", entity_id: "../../6/adCampaigns/60" }, /numeric ID/);
        expect(f.gets).toEqual([]);
        expect(f.sends).toEqual([]);
      }
    });

    it("changes nothing when no restriction is set", async () => {
      const f = shared();
      const mcp = await connect(f.client, {});
      expect(json(await mcp.callTool({ name: "list_ad_accounts", arguments: {} })).map((a: any) => a.id)).toEqual(["5", "6", "7"]);
      const r: any = await mcp.callTool({ name: "get_performance", arguments: { account_id: "6", campaign_ids: ["60"] } });
      expect(r.isError).toBeFalsy();
      // No ownership lookups: LinkedIn's own permissions are the boundary, as before.
      expect(f.gets.some(p => /adCampaigns\/60$/.test(p))).toBe(false);
    });

    it("reads the list from LINKEDIN_AD_ACCOUNT_IDS and fails closed on a typo", async () => {
      expect(parseAccountIds(undefined)).toBeUndefined();
      expect(parseAccountIds("  ")).toBeUndefined();
      expect(parseAccountIds("5, 6\n7")).toEqual(["5", "6", "7"]);
      expect(() => parseAccountIds("5,urn:li:sponsoredAccount:6")).toThrow(/numeric/);
      process.env.LINKEDIN_AD_ACCOUNT_IDS = "5";
      try {
        const mcp = await connect(shared().client, { draftTools: false });
        expect(json(await mcp.callTool({ name: "list_ad_accounts", arguments: {} })).map((a: any) => a.id)).toEqual(["5"]);
        process.env.LINKEDIN_AD_ACCOUNT_IDS = "5,abc";
        expect(() => createLinkedInAdsServer(shared().client, {})).toThrow(/numeric/);
      } finally {
        delete process.env.LINKEDIN_AD_ACCOUNT_IDS;
      }
    });

    it("stops a request for another account at the client, whatever a tool does", async () => {
      const f = shared();
      const c = restrictClient(f.client, ["5"]);
      expect(() => c.get("/adAccounts/6/adCampaigns")).toThrow(/not available/);
      expect(() => c.get("/adAccounts/5/../6")).toThrow(/malformed/);
      expect(() => c.get("/adAnalytics", { accounts: "List(urn%3Ali%3AsponsoredAccount%3A6)" })).toThrow(/not available/);
      expect(() => c.send("POST", "/adAccounts/7/adCampaigns", {})).toThrow(/not available/);
      await c.get("/adAnalytics", { accounts: "List(urn%3Ali%3AsponsoredAccount%3A5)" });
      expect(f.gets.length).toBe(1);
    });
  });
});
