// The MCP server factory. One implementation, two consumers: the stdio bin
// (local use with Claude Code / Desktop) and the Walma MCP chassis, which
// imports createLinkedInAdsServer and mounts it on a path behind the gateway.
//
// Read tools are always on. The campaign-building tools are opt-in
// (`draftTools`) and can only ever create DRAFTs: there is deliberately no
// tool that sets anything ACTIVE, so no money can be spent from a
// conversation — a person reviews and launches in Campaign Manager.

import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createLinkedInClient, createdId, type LinkedInClient } from "./linkedin.js";
import {
  CTA_LABELS, DEFAULT_CAMPAIGN_STATUSES, DEFAULT_METRICS, FACETS, GRANULARITIES,
  OBJECTIVE_OPTIMIZATION, PIVOTS, POLITICAL_NOTICE, defaultRange, derive, enc, epochMs,
  idOf, label, money, restliDate, restliList, sumMetrics, targetingCriteria,
  type Granularity, type Pivot,
} from "./logic.js";

export const VERSION = "0.2.0";

export const INSTRUCTIONS =
  "LinkedIn Campaign Manager data via the Marketing API. Call list_ad_accounts first to " +
  "get account IDs. Costs are in the account's currency. Reporting data can lag a few " +
  "hours and demographic pivots are approximate (LinkedIn applies privacy thresholds and " +
  "hides small groups).";

const DRAFT_INSTRUCTIONS =
  " Campaign-building tools are enabled: they create campaign groups, campaigns and ads as " +
  "DRAFTs only — a person launches them in Campaign Manager. Use search_targeting first to " +
  "find targeting URNs.";

export interface ServerOptions {
  /** Register the draft-only campaign-building tools. Needs the rw_ads scope. */
  draftTools?: boolean;
  /** Let create_ad read images from the local disk. Only for the local stdio
   * bin: in a shared container a "path" could be any file, including the
   * process environment with its credentials. */
  allowLocalFiles?: boolean;
}

/** True for loopback, private, link-local, CGNAT and unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, "");
  if (/^(10|127|0)\./.test(v) || /^192\.168\./.test(v) || /^169\.254\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v)) return true;
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

/** Public https only: in a container the server sits inside a private network,
 * so a caller-supplied URL must not reach internal hosts. Checks the name, then
 * what it resolves to. */
export async function assertPublicImageUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("image_url must be https");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /(^|\.)internal(\.|$)/.test(host)) {
    throw new Error("image_url must point at a public host");
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address)) || /^\d+$/.test(host)) {
    throw new Error("image_url must point at a public host");
  }
  return url;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createLinkedInAdsServer(
  client: LinkedInClient = createLinkedInClient(),
  opts: ServerOptions = { draftTools: process.env.LINKEDIN_ADS_DRAFT_TOOLS === "1" },
): McpServer {
  const server = new McpServer(
    { name: "linkedin-ads", version: VERSION },
    { instructions: INSTRUCTIONS + (opts.draftTools ? DRAFT_INSTRUCTIONS : "") },
  );

  async function paged(path: string, params: Record<string, string>, limit = 1000): Promise<any[]> {
    const out: any[] = [];
    const p: Record<string, string> = { ...params, pageSize: "100" };
    while (out.length < limit) {
      const data = await client.get(path, p);
      out.push(...(data.elements ?? []));
      const token = data.metadata?.nextPageToken;
      if (!token) break;
      p.pageToken = enc(token);
    }
    return out.slice(0, limit);
  }

  async function names(accountId: string, pivot: Pivot): Promise<Record<string, string>> {
    if (pivot === "CAMPAIGN") {
      const rows = await paged(`/adAccounts/${accountId}/adCampaigns`, { q: "search" });
      return Object.fromEntries(rows.map(c => [`urn:li:sponsoredCampaign:${c.id}`, c.name ?? ""]));
    }
    if (pivot === "CAMPAIGN_GROUP") {
      const rows = await paged(`/adAccounts/${accountId}/adCampaignGroups`, { q: "search" });
      return Object.fromEntries(rows.map(g => [`urn:li:sponsoredCampaignGroup:${g.id}`, g.name ?? ""]));
    }
    return {};
  }

  async function analytics(
    accountId: string, start: string, end: string, pivot: Pivot, granularity: Granularity,
    metrics: string[], campaignIds?: string[],
  ): Promise<any[]> {
    const params: Record<string, string> = {
      q: "analytics",
      pivot,
      timeGranularity: granularity,
      dateRange: `(start:${restliDate(start)},end:${restliDate(end)})`,
      fields: [...new Set([...metrics, "dateRange", "pivotValues"])].join(","),
    };
    if (campaignIds?.length) params.campaigns = restliList(campaignIds.map(c => `urn:li:sponsoredCampaign:${c}`));
    else params.accounts = restliList([`urn:li:sponsoredAccount:${accountId}`]);
    return (await client.get("/adAnalytics", params)).elements ?? [];
  }

  async function rows(accountId: string, els: any[], pivot: Pivot, granularity: Granularity) {
    const nameMap = await names(accountId, pivot);
    return els.map(({ pivotValues, dateRange, ...metrics }) => {
      const urn = (pivotValues ?? [""])[0] as string;
      const row: Record<string, any> = { pivot: label(urn, nameMap), urn };
      if (granularity !== "ALL" && dateRange?.start) {
        const s = dateRange.start;
        row.date = `${String(s.year).padStart(4, "0")}-${String(s.month).padStart(2, "0")}-${String(s.day).padStart(2, "0")}`;
      }
      return derive({ ...row, ...metrics });
    });
  }

  // ─── Read tools ──────────────────────────────────────────────────────────

  server.registerTool("list_ad_accounts", {
    description: "List ad accounts the signed-in LinkedIn user has a role on, with name, currency, status and the user's role.",
    inputSchema: {},
  }, async () => {
    const users = (await client.get("/adAccountUsers", { q: "authenticatedUser" })).elements ?? [];
    const out = [];
    for (const u of users) {
      const id = idOf(u.account);
      const acc = await client.get(`/adAccounts/${id}`);
      out.push({ id, name: acc.name, currency: acc.currency, status: acc.status, type: acc.type, role: u.role, servingStatuses: acc.servingStatuses });
    }
    return jsonResult(out);
  });

  server.registerTool("list_campaigns", {
    description: "List campaigns (and campaign groups) in an ad account with status, objective, budgets and bids.",
    inputSchema: {
      account_id: z.string().describe("Numeric ad account ID from list_ad_accounts"),
      statuses: z.array(z.string()).optional()
        .describe("Any of ACTIVE, PAUSED, DRAFT, COMPLETED, CANCELED, ARCHIVED. Default: everything except ARCHIVED and CANCELED."),
      include_groups: z.boolean().default(true),
    },
  }, async ({ account_id, statuses, include_groups }) => {
    const st = statuses?.length ? statuses : DEFAULT_CAMPAIGN_STATUSES;
    const camps = await paged(`/adAccounts/${account_id}/adCampaigns`, { q: "search", search: `(status:(values:${restliList(st)}))` });
    const result: Record<string, unknown> = {
      campaigns: camps.map(c => ({
        id: c.id, name: c.name, status: c.status, type: c.type, objective: c.objectiveType,
        costType: c.costType, dailyBudget: money(c.dailyBudget), totalBudget: money(c.totalBudget),
        bid: money(c.unitCost), group: idOf(c.campaignGroup), runSchedule: c.runSchedule,
      })),
    };
    if (include_groups) {
      // Campaign groups have no COMPLETED status; LinkedIn rejects the whole
      // search (400 Invalid param) if it is included.
      const gst = st.filter(s => s !== "COMPLETED");
      const groups = await paged(`/adAccounts/${account_id}/adCampaignGroups`, {
        q: "search", search: `(status:(values:${restliList(gst.length ? gst : ["ACTIVE"])}))`,
      });
      result.groups = groups.map(g => ({ id: g.id, name: g.name, status: g.status, totalBudget: money(g.totalBudget), runSchedule: g.runSchedule }));
    }
    return jsonResult(result);
  });

  server.registerTool("get_performance", {
    description:
      "Performance from adAnalytics with CTR, CPC, CPM and cost per conversion/lead computed. " +
      "Pivot by campaign (default), group, creative, conversion or a demographic (approximate).",
    inputSchema: {
      account_id: z.string(),
      start_date: z.string().optional().describe("YYYY-MM-DD; default last 28 days ending yesterday"),
      end_date: z.string().optional(),
      pivot: z.enum(PIVOTS).default("CAMPAIGN"),
      granularity: z.enum(GRANULARITIES).default("ALL").describe("ALL = one row per pivot value"),
      campaign_ids: z.array(z.string()).optional().describe("Restrict to these campaigns"),
      metrics: z.array(z.string()).optional().describe("adAnalytics field names (max ~18)"),
    },
  }, async (a) => {
    const range = a.start_date && a.end_date ? { start: a.start_date, end: a.end_date } : defaultRange();
    const metrics = a.metrics?.length ? a.metrics : DEFAULT_METRICS;
    const els = await analytics(a.account_id, range.start, range.end, a.pivot, a.granularity, metrics, a.campaign_ids);
    const r = (await rows(a.account_id, els, a.pivot, a.granularity))
      .sort((x, y) => String(x.date ?? "").localeCompare(String(y.date ?? "")) || (y.costInLocalCurrency ?? 0) - (x.costInLocalCurrency ?? 0));
    return jsonResult({
      accountId: a.account_id, startDate: range.start, endDate: range.end, pivot: a.pivot, granularity: a.granularity,
      rowCount: r.length, totals: derive(sumMetrics(r, metrics)), rows: r,
    });
  });

  server.registerTool("compare_periods", {
    description: "Compare two date ranges side by side with deltas, account-wide and per pivot value (campaign by default). Rows present in only one period get zeros for the other.",
    inputSchema: {
      account_id: z.string(),
      current_start: z.string(), current_end: z.string(),
      previous_start: z.string(), previous_end: z.string(),
      pivot: z.enum(PIVOTS).default("CAMPAIGN"),
      row_limit: z.number().int().min(1).max(500).default(50),
    },
  }, async (a) => {
    const fields = ["impressions", "clicks", "costInLocalCurrency", "externalWebsiteConversions", "oneClickLeads"];
    const run = async (s: string, e: string) => {
      const r = await rows(a.account_id, await analytics(a.account_id, s, e, a.pivot, "ALL", fields), a.pivot, "ALL");
      return new Map(r.map(x => [x.urn as string, x]));
    };
    const [cur, prev] = await Promise.all([run(a.current_start, a.current_end), run(a.previous_start, a.previous_end)]);
    const total = (m: Map<string, any>) => derive(sumMetrics([...m.values()], fields));
    const delta = (x: Record<string, any>, y: Record<string, any>) => {
      const out: Record<string, number | null> = {};
      for (const k of [...fields, "ctr"]) out[k] = Math.round(((x[k] ?? 0) - (y[k] ?? 0)) * 1e4) / 1e4;
      for (const k of ["clicks", "costInLocalCurrency"]) out[`${k}_pct`] = y[k] ? Math.round(((x[k] - y[k]) / y[k]) * 1000) / 10 : null;
      return out;
    };
    const zero = derive(Object.fromEntries(fields.map(f => [f, 0])));
    const keys = [...new Set([...cur.keys(), ...prev.keys()])]
      .sort((x, y) => (cur.get(y)?.costInLocalCurrency ?? 0) - (cur.get(x)?.costInLocalCurrency ?? 0))
      .slice(0, a.row_limit);
    const cT = total(cur), pT = total(prev);
    return jsonResult({
      accountId: a.account_id, pivot: a.pivot,
      current: { startDate: a.current_start, endDate: a.current_end, ...cT },
      previous: { startDate: a.previous_start, endDate: a.previous_end, ...pT },
      delta: delta(cT, pT),
      rows: keys.map((k) => {
        const c = cur.get(k) ?? zero, p = prev.get(k) ?? zero;
        return { pivot: c.pivot ?? p.pivot ?? k, urn: k, current: c, previous: p, delta: delta(c, p) };
      }),
    });
  });

  server.registerTool("list_creatives", {
    description: "List creatives (ads) in an account, optionally only for some campaigns, with status, review state and campaign. Combine with get_performance(pivot='CREATIVE').",
    inputSchema: {
      account_id: z.string(),
      campaign_ids: z.array(z.string()).optional(),
    },
  }, async ({ account_id, campaign_ids }) => {
    const params: Record<string, string> = { q: "criteria" };
    if (campaign_ids?.length) params.campaigns = restliList(campaign_ids.map(c => `urn:li:sponsoredCampaign:${c}`));
    const r = await paged(`/adAccounts/${account_id}/creatives`, params);
    return jsonResult(r.map(c => ({
      id: idOf(c.id), name: c.name, status: c.intendedStatus, review: c.review?.status,
      campaign: idOf(c.campaign), content: c.content, createdAt: c.createdAt,
    })));
  });

  server.registerTool("search_targeting", {
    description: "Look up targeting values (URNs) — locations, job titles, seniorities, company sizes, industries … Leave query empty for small fixed lists (seniorities, staffCountRanges, jobFunctions).",
    inputSchema: {
      facet: z.enum(FACETS),
      query: z.string().default("").describe("Typeahead text, e.g. 'CTO' or 'Sweden'"),
      limit: z.number().int().min(1).max(100).default(15),
    },
  }, async ({ facet, query, limit }) => {
    const params: Record<string, string> = { facet: enc(`urn:li:adTargetingFacet:${facet}`), queryVersion: "QUERY_USES_URNS" };
    if (query) Object.assign(params, { q: "typeahead", query: enc(query) });
    else params.q = "adTargetingFacet";
    const els = (await client.get("/adTargetingEntities", params)).elements ?? [];
    return jsonResult(els.slice(0, limit).map((e: any) => ({ urn: e.urn, name: e.name })));
  });

  if (opts.draftTools) registerDraftTools(server, client, !!opts.allowLocalFiles);
  return server;
}

// ─── Draft-only campaign building ─────────────────────────────────────────

function registerDraftTools(server: McpServer, client: LinkedInClient, allowLocalFiles: boolean) {
  async function requireWrite() {
    if (!(await client.scopes()).has("rw_ads")) {
      throw new Error("The LinkedIn token is read-only. Sign in again with write access: LINKEDIN_SCOPES='r_ads r_ads_reporting rw_ads' linkedin-ads-mcp auth");
    }
  }
  const account = (id: string) => client.get(`/adAccounts/${id}`);
  const schedule = (start: string, end?: string) => ({ start: epochMs(start), ...(end ? { end: epochMs(end) } : {}) });

  server.registerTool("create_campaign_group", {
    description: "Create a campaign group as a DRAFT. Nothing runs until someone launches it in Campaign Manager.",
    inputSchema: {
      account_id: z.string(),
      name: z.string(),
      start_date: z.string().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("Required with total_budget"),
      total_budget: z.number().positive().optional().describe("Cap in the account currency"),
    },
  }, async (a) => {
    await requireWrite();
    const acct = await account(a.account_id);
    if (a.total_budget && !a.end_date) throw new Error("end_date is required when total_budget is set");
    const resp = await client.send("POST", `/adAccounts/${a.account_id}/adCampaignGroups`, {
      account: `urn:li:sponsoredAccount:${a.account_id}`,
      name: a.name,
      status: "DRAFT",
      runSchedule: schedule(a.start_date, a.end_date),
      ...(a.total_budget ? { totalBudget: { amount: a.total_budget.toFixed(2), currencyCode: acct.currency } } : {}),
    });
    return jsonResult({ id: createdId(resp.headers), name: a.name, status: "DRAFT" });
  });

  server.registerTool("create_campaign", {
    description:
      "Create a Sponsored Content campaign as a DRAFT, with automated bidding for the objective. " +
      "Before calling, show the user this statement and get their confirmation (LinkedIn requires it): " + POLITICAL_NOTICE,
    inputSchema: {
      account_id: z.string(),
      campaign_group_id: z.string(),
      name: z.string(),
      objective: z.enum(Object.keys(OBJECTIVE_OPTIMIZATION) as [keyof typeof OBJECTIVE_OPTIMIZATION, ...Array<keyof typeof OBJECTIVE_OPTIMIZATION>]),
      daily_budget: z.number().positive().describe("Account currency"),
      targeting: z.record(z.array(z.string()))
        .describe('Facet → URNs from search_targeting, ANDed across facets, ORed within one. Must include locations, e.g. {"locations":["urn:li:geo:105117694"],"titles":["urn:li:title:153"]}'),
      exclude: z.record(z.array(z.string())).optional(),
      start_date: z.string(),
      end_date: z.string().optional(),
      locale: z.string().default("sv_SE").describe("Ad language, ll_CC"),
      audience_expansion: z.boolean().default(false),
      advertiser_confirmed_not_political: z.boolean().default(false)
        .describe("True only after the user has seen and accepted the not-political-advertising statement"),
    },
  }, async (a) => {
    await requireWrite();
    if (!a.advertiser_confirmed_not_political) throw new Error(`Show the user this statement and ask them to confirm it first: ${POLITICAL_NOTICE}`);
    if (!a.targeting.locations?.length) throw new Error("targeting must include 'locations' (LinkedIn requires a location)");
    const acct = await account(a.account_id);
    const [language, country] = a.locale.split("_");
    const resp = await client.send("POST", `/adAccounts/${a.account_id}/adCampaigns`, {
      account: `urn:li:sponsoredAccount:${a.account_id}`,
      campaignGroup: `urn:li:sponsoredCampaignGroup:${a.campaign_group_id}`,
      name: a.name,
      type: "SPONSORED_UPDATES",
      objectiveType: a.objective,
      optimizationTargetType: OBJECTIVE_OPTIMIZATION[a.objective],
      costType: "CPM",
      creativeSelection: "OPTIMIZED",
      dailyBudget: { amount: a.daily_budget.toFixed(2), currencyCode: acct.currency },
      locale: { language, country },
      audienceExpansionEnabled: a.audience_expansion,
      offsiteDeliveryEnabled: false,
      connectedTelevisionOnly: false,
      runSchedule: schedule(a.start_date, a.end_date),
      targetingCriteria: targetingCriteria(a.targeting, a.exclude),
      politicalIntent: "NOT_POLITICAL",
      status: "DRAFT",
    });
    return jsonResult({ id: createdId(resp.headers), name: a.name, objective: a.objective, status: "DRAFT" });
  });

  server.registerTool("create_ad", {
    description:
      "Create a single-image Sponsored Content ad as a DRAFT in a campaign, posted as the ad account's " +
      "company page (a dark post, not shown on the page feed). Give an image (local path, URL or uploaded URN) " +
      "and either a landing page or a Lead Gen Form ID.",
    inputSchema: {
      account_id: z.string(),
      campaign_id: z.string(),
      name: z.string(),
      intro_text: z.string().describe("Text above the image; keep the first ~150 characters punchy"),
      headline: z.string().describe("Text under the image, ~70 characters"),
      image_path: z.string().optional().describe("Local PNG/JPG, 1200x627 or 1080x1080 (local use only)"),
      image_url: z.string().url().optional().describe("Public image URL to fetch and upload"),
      image_urn: z.string().optional().describe("An already uploaded urn:li:image:..."),
      landing_page: z.string().url().optional().describe("Destination URL with UTM parameters"),
      call_to_action: z.enum(CTA_LABELS).default("LEARN_MORE"),
      lead_form_id: z.string().optional().describe("Lead Gen Form ID (from its URL in Campaign Manager)"),
    },
  }, async (a) => {
    await requireWrite();
    const owner: string = (await account(a.account_id)).reference ?? "";
    if (!owner.startsWith("urn:li:organization:")) throw new Error("The ad account is not linked to a company page; link one in Campaign Manager.");

    let image = a.image_urn;
    if (!image) {
      let bytes: Uint8Array;
      if (a.image_url) {
        const r = await fetch(await assertPublicImageUrl(a.image_url), { redirect: "error" });
        if (!r.ok) throw new Error(`Could not fetch image_url (${r.status})`);
        bytes = new Uint8Array(await r.arrayBuffer());
      } else if (a.image_path) {
        if (!allowLocalFiles) throw new Error("image_path is only available when running locally; use image_url");
        bytes = await readFile(a.image_path.replace(/^~/, homedir()));
      } else {
        throw new Error("Give image_path, image_url or image_urn");
      }
      const init = (await client.send("POST", "/images", { initializeUploadRequest: { owner } }, { action: "initializeUpload" })).data.value;
      await client.uploadBinary(init.uploadUrl, bytes);
      image = init.image as string;
    }

    const post: Record<string, unknown> = {
      adContext: { dscAdAccount: `urn:li:sponsoredAccount:${a.account_id}`, dscStatus: "ACTIVE", dscName: a.name },
      author: owner,
      commentary: a.intro_text,
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      content: { media: { title: a.headline, id: image } },
    };
    const creative: Record<string, unknown> = {
      inlineContent: { post },
      campaign: `urn:li:sponsoredCampaign:${a.campaign_id}`,
      intendedStatus: "DRAFT",
      name: a.name,
    };
    if (a.lead_form_id) {
      creative.leadgenCallToAction = { destination: `urn:li:adForm:${a.lead_form_id}`, label: a.call_to_action };
    } else {
      if (!a.landing_page) throw new Error("landing_page is required unless lead_form_id is given");
      post.contentLandingPage = a.landing_page;
      post.contentCallToActionLabel = a.call_to_action;
    }
    const resp = await client.send("POST", `/adAccounts/${a.account_id}/creatives`, { creative }, { action: "createInline" });
    return jsonResult({ id: createdId(resp.headers), name: a.name, image, status: "DRAFT" });
  });

  server.registerTool("delete_draft", {
    description: "Delete a campaign group, campaign or ad — only while it is still a DRAFT.",
    inputSchema: {
      account_id: z.string(),
      kind: z.enum(["campaign_group", "campaign", "ad"]),
      entity_id: z.string(),
    },
  }, async ({ account_id, kind, entity_id }) => {
    await requireWrite();
    const path = {
      campaign_group: `/adAccounts/${account_id}/adCampaignGroups/${entity_id}`,
      campaign: `/adAccounts/${account_id}/adCampaigns/${entity_id}`,
      ad: `/adAccounts/${account_id}/creatives/${enc(`urn:li:sponsoredCreative:${entity_id}`)}`,
    }[kind];
    const current = await client.get(path);
    const status = kind === "ad" ? current.intendedStatus : current.status;
    if (status !== "DRAFT") throw new Error(`Refusing to delete a ${kind} in status ${status}; only DRAFTs can be deleted here.`);
    await client.send("DELETE", path);
    return jsonResult({ deleted: kind, id: entity_id });
  });
}
