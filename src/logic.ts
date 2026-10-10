// Pure helpers: Rest.li encoding, date handling, derived metrics, demographic
// labels and targeting criteria. No I/O, so everything here is unit-tested
// directly and shared by the server and anyone importing the package.

export const PIVOTS = [
  "ACCOUNT", "CAMPAIGN_GROUP", "CAMPAIGN", "CREATIVE", "CONVERSION",
  "MEMBER_JOB_FUNCTION", "MEMBER_SENIORITY", "MEMBER_INDUSTRY", "MEMBER_COMPANY",
  "MEMBER_COMPANY_SIZE", "MEMBER_COUNTRY_V2", "MEMBER_REGION_V2", "MEMBER_JOB_TITLE",
] as const;
export type Pivot = typeof PIVOTS[number];

export const GRANULARITIES = ["ALL", "DAILY", "MONTHLY", "YEARLY"] as const;
export type Granularity = typeof GRANULARITIES[number];

export const DEFAULT_METRICS = [
  "impressions", "clicks", "costInLocalCurrency", "landingPageClicks",
  "externalWebsiteConversions", "oneClickLeads", "totalEngagements", "videoViews",
];

/** Campaign statuses shown by default. Most accounts are mostly COMPLETED, so
 * leaving it out makes them look empty. */
export const DEFAULT_CAMPAIGN_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "DRAFT"];

// Stable LinkedIn standardized taxonomies, so demographic rows are readable
// without an extra API round-trip. Other pivots come back as URNs.
export const FUNCTIONS: Record<number, string> = {
  1: "Accounting", 2: "Administrative", 3: "Arts and Design", 4: "Business Development",
  5: "Community and Social Services", 6: "Consulting", 7: "Education", 8: "Engineering",
  9: "Entrepreneurship", 10: "Finance", 11: "Healthcare Services", 12: "Human Resources",
  13: "Information Technology", 14: "Legal", 15: "Marketing", 16: "Media and Communication",
  17: "Military and Protective Services", 18: "Operations", 19: "Product Management",
  20: "Program and Project Management", 21: "Purchasing", 22: "Quality Assurance",
  23: "Real Estate", 24: "Research", 25: "Sales", 26: "Support",
};
export const SENIORITIES: Record<number, string> = {
  1: "Unpaid", 2: "Training", 3: "Entry", 4: "Senior", 5: "Manager",
  6: "Director", 7: "VP", 8: "CXO", 9: "Partner", 10: "Owner",
};

/** Encode a value inside a Rest.li structure (URNs need their colons escaped). */
export function enc(v: string | number): string {
  return encodeURIComponent(String(v));
}

export function restliList(values: Array<string | number>): string {
  return `List(${values.map(enc).join(",")})`;
}

export function restliDate(d: string): string {
  const [y, m, dd] = d.split("-").map(Number);
  return `(year:${y},month:${m},day:${dd})`;
}

/** Last segment of a URN: urn:li:sponsoredCampaign:123 → 123. */
export function idOf(urn: string | number | undefined): string {
  return String(urn ?? "").split(":").pop() ?? "";
}

export function money(m: { amount: string; currencyCode?: string } | undefined | null): string | null {
  return m ? `${m.amount} ${m.currencyCode ?? ""}`.trim() : null;
}

/** Last `days` days ending yesterday (UTC). */
export function defaultRange(days = 28, today = new Date()): { start: string; end: string } {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** YYYY-MM-DD (UTC midnight) → epoch milliseconds, LinkedIn's runSchedule unit. */
export function epochMs(d: string): number {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y!, m! - 1, dd!);
}

export function label(urn: string, names: Record<string, string> = {}): string {
  if (names[urn]) return names[urn]!;
  const num = urn.split(":").pop() ?? "";
  if (/^\d+$/.test(num)) {
    if (urn.includes(":function:")) return FUNCTIONS[Number(num)] ?? urn;
    if (urn.includes(":seniority:")) return SENIORITIES[Number(num)] ?? urn;
  }
  return urn;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** Add CTR, CPC, CPM and cost per conversion/lead to a metrics row. */
export function derive<T extends Record<string, any>>(row: T): T & Record<string, any> {
  const out: Record<string, any> = { ...row };
  const imps = Number(row.impressions ?? 0);
  const clicks = Number(row.clicks ?? 0);
  const cost = Number(row.costInLocalCurrency ?? 0);
  out.costInLocalCurrency = round(cost, 2);
  out.ctr = imps ? round(clicks / imps, 4) : 0;
  out.cpc = clicks ? round(cost / clicks, 2) : null;
  out.cpm = imps ? round((cost / imps) * 1000, 2) : null;
  const conv = Number(row.externalWebsiteConversions ?? 0) + Number(row.oneClickLeads ?? 0);
  if (conv) out.costPerConversionOrLead = round(cost / conv, 2);
  return out as T & Record<string, any>;
}

export function sumMetrics(rows: Array<Record<string, any>>, metrics: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of metrics) out[m] = rows.reduce((s, r) => s + Number(r[m] ?? 0), 0);
  return out;
}

// ─── Targeting (draft tools) ──────────────────────────────────────────────

export const FACETS = [
  "locations", "titles", "seniorities", "jobFunctions", "industries", "staffCountRanges",
  "employers", "skills", "interfaceLocales", "audienceMatchingSegments",
  "dynamicSegments", "degrees", "fieldsOfStudy", "groups", "memberBehaviors",
] as const;

/** Facet → URNs, ANDed across facets and ORed within one. */
export function targetingCriteria(
  include: Record<string, string[]>,
  exclude?: Record<string, string[]>,
): Record<string, unknown> {
  for (const f of [...Object.keys(include), ...Object.keys(exclude ?? {})]) {
    if (!(FACETS as readonly string[]).includes(f)) {
      throw new Error(`Unknown targeting facet '${f}'. Use one of: ${FACETS.join(", ")}`);
    }
  }
  const facetUrn = (f: string) => `urn:li:adTargetingFacet:${f}`;
  const out: Record<string, unknown> = {
    include: {
      and: Object.entries(include)
        .filter(([, urns]) => urns.length)
        .map(([f, urns]) => ({ or: { [facetUrn(f)]: urns } })),
    },
  };
  const ex = Object.entries(exclude ?? {}).filter(([, urns]) => urns.length);
  if (ex.length) out.exclude = { or: Object.fromEntries(ex.map(([f, urns]) => [facetUrn(f), urns])) };
  return out;
}

export const OBJECTIVE_OPTIMIZATION = {
  LEAD_GENERATION: "MAX_LEAD",
  WEBSITE_VISIT: "MAX_CLICK",
  WEBSITE_CONVERSIONS: "MAX_CONVERSION",
  BRAND_AWARENESS: "MAX_IMPRESSION",
} as const;
export type Objective = keyof typeof OBJECTIVE_OPTIMIZATION;

export const CTA_LABELS = [
  "APPLY", "DOWNLOAD", "VIEW_QUOTE", "LEARN_MORE", "SIGN_UP", "SUBSCRIBE",
  "REGISTER", "JOIN", "ATTEND", "REQUEST_DEMO", "SEE_MORE", "BUY_NOW", "SHOP_NOW",
] as const;

/** LinkedIn requires partner apps to show this to the advertiser and pass their
 * answer back in `politicalIntent` (EU political advertising rules). */
export const POLITICAL_NOTICE =
  "I confirm this is not political advertising. None of my ads qualify as political " +
  "advertising under the law of the targeted countries, including EU law for ads " +
  "targeted to the EU. Advertisers must comply with LinkedIn's policies and regulatory " +
  "requirements. https://www.linkedin.com/legal/ads-policy";
