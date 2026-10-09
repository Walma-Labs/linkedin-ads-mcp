"""LinkedIn Ads MCP server.

Auth: 3-legged OAuth. Set LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET and run
`linkedin-ads-mcp auth` once; tokens refresh automatically after that.
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from typing import Any
from urllib.parse import quote

import httpx
from mcp.server.fastmcp import FastMCP

from . import auth

API = "https://api.linkedin.com/rest"
# LinkedIn sunsets each monthly version after ~1 year; bump this when it does.
API_VERSION = os.environ.get("LINKEDIN_API_VERSION", "202609")

PIVOTS = {
    "ACCOUNT", "CAMPAIGN_GROUP", "CAMPAIGN", "CREATIVE", "CONVERSION",
    "MEMBER_JOB_FUNCTION", "MEMBER_SENIORITY", "MEMBER_INDUSTRY", "MEMBER_COMPANY",
    "MEMBER_COMPANY_SIZE", "MEMBER_COUNTRY_V2", "MEMBER_REGION_V2", "MEMBER_JOB_TITLE",
}
GRANULARITIES = {"ALL", "DAILY", "MONTHLY", "YEARLY"}
DEFAULT_METRICS = [
    "impressions", "clicks", "costInLocalCurrency", "landingPageClicks",
    "externalWebsiteConversions", "oneClickLeads", "totalEngagements", "videoViews",
]
# Stable LinkedIn standardized taxonomies, so demographic rows are readable without
# an extra API round-trip. Other pivots come back as URNs.
FUNCTIONS = {
    1: "Accounting", 2: "Administrative", 3: "Arts and Design", 4: "Business Development",
    5: "Community and Social Services", 6: "Consulting", 7: "Education", 8: "Engineering",
    9: "Entrepreneurship", 10: "Finance", 11: "Healthcare Services", 12: "Human Resources",
    13: "Information Technology", 14: "Legal", 15: "Marketing", 16: "Media and Communication",
    17: "Military and Protective Services", 18: "Operations", 19: "Product Management",
    20: "Program and Project Management", 21: "Purchasing", 22: "Quality Assurance",
    23: "Real Estate", 24: "Research", 25: "Sales", 26: "Support",
}
SENIORITIES = {
    1: "Unpaid", 2: "Training", 3: "Entry", 4: "Senior", 5: "Manager",
    6: "Director", 7: "VP", 8: "CXO", 9: "Partner", 10: "Owner",
}

mcp = FastMCP(
    "linkedin-ads",
    instructions=(
        "LinkedIn Campaign Manager data via the Marketing API. Call list_ad_accounts "
        "first to get account IDs. Costs are in the account's currency. Reporting data "
        "can lag a few hours and demographic pivots are approximate (LinkedIn applies "
        "privacy thresholds and hides small groups). With the rw_ads scope it can also create "
        "campaign groups, campaigns and ads, always as DRAFTs: a person launches them in "
        "Campaign Manager. Use search_targeting to find targeting URNs first."
    ),
)


# --- Rest.li helpers -------------------------------------------------------

def _enc(v: str | int) -> str:
    """Encode a value inside a Rest.li structure (URNs need their colons escaped)."""
    return quote(str(v), safe="")


def _list(values: list[str | int]) -> str:
    return "List(" + ",".join(_enc(v) for v in values) + ")"


def _date(d: str) -> str:
    y, m, dd = (int(x) for x in d.split("-"))
    return f"(year:{y},month:{m},day:{dd})"


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {auth.access_token()}",
        "LinkedIn-Version": API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
    }


def _raise_for(resp: httpx.Response, path: str) -> None:
    if resp.status_code < 400:
        return
    try:
        body = resp.json()
        msg = body.get("message", resp.text)
        # Validation errors carry the useful part (which field, why) in errorDetails.
        if body.get("errorDetails"):
            msg += f" — {body['errorDetails']}"
    except ValueError:
        msg = resp.text
    raise RuntimeError(f"LinkedIn API {resp.status_code} on {path}: {msg}")


def _url(path: str, params: dict[str, str] | None) -> str:
    # Rest.li params are pre-encoded; build the query string by hand so the
    # parentheses and commas reach LinkedIn unescaped.
    url = f"{API}{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    return url


def _get(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    resp = httpx.get(_url(path, params), timeout=60, headers=_headers())
    _raise_for(resp, path)
    return resp.json()


def _write(method: str, path: str, body: dict[str, Any] | None = None,
           params: dict[str, str] | None = None) -> httpx.Response:
    resp = httpx.request(method, _url(path, params), json=body, timeout=60,
                         headers={**_headers(), "Content-Type": "application/json"})
    _raise_for(resp, path)
    return resp


def _created_id(resp: httpx.Response) -> str:
    """New entity ID from a 201: x-restli-id (sometimes a URN) or x-linkedin-id."""
    rid = resp.headers.get("x-restli-id") or resp.headers.get("x-linkedin-id") or ""
    return _id(rid) if rid else ""


def _paged(path: str, params: dict[str, str], limit: int = 1000) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    params = {**params, "pageSize": "100"}
    while len(out) < limit:
        data = _get(path, params)
        out.extend(data.get("elements", []))
        token = data.get("metadata", {}).get("nextPageToken")
        if not token:
            break
        params["pageToken"] = _enc(token)
    return out[:limit]


def _id(urn: str) -> str:
    return urn.rsplit(":", 1)[-1]


def _money(m: dict[str, Any] | None) -> str | None:
    return f"{m['amount']} {m.get('currencyCode', '')}".strip() if m else None


def _default_range(days: int = 28) -> tuple[str, str]:
    end = date.today() - timedelta(days=1)
    return (end - timedelta(days=days - 1)).isoformat(), end.isoformat()


def _label(urn: str, names: dict[str, str]) -> str:
    if urn in names:
        return names[urn]
    kind, _, num = urn.rpartition(":")
    if num.isdigit():
        if kind.endswith(":function"):
            return FUNCTIONS.get(int(num), urn)
        if kind.endswith(":seniority"):
            return SENIORITIES.get(int(num), urn)
    return urn


def _derive(row: dict[str, Any]) -> dict[str, Any]:
    imps, clicks = row.get("impressions", 0), row.get("clicks", 0)
    cost = float(row.get("costInLocalCurrency") or 0)
    row["costInLocalCurrency"] = round(cost, 2)
    row["ctr"] = round(clicks / imps, 4) if imps else 0.0
    row["cpc"] = round(cost / clicks, 2) if clicks else None
    row["cpm"] = round(cost / imps * 1000, 2) if imps else None
    conv = row.get("externalWebsiteConversions", 0) + row.get("oneClickLeads", 0)
    if conv:
        row["costPerConversionOrLead"] = round(cost / conv, 2)
    return row


def _campaign_names(account_id: str) -> dict[str, str]:
    rows = _paged(f"/adAccounts/{account_id}/adCampaigns", {"q": "search"})
    return {f"urn:li:sponsoredCampaign:{c['id']}": c.get("name", "") for c in rows}


def _group_names(account_id: str) -> dict[str, str]:
    rows = _paged(f"/adAccounts/{account_id}/adCampaignGroups", {"q": "search"})
    return {f"urn:li:sponsoredCampaignGroup:{g['id']}": g.get("name", "") for g in rows}


def _analytics(
    account_id: str, start_date: str, end_date: str, pivot: str,
    granularity: str, metrics: list[str], campaign_ids: list[str] | None,
) -> list[dict[str, Any]]:
    params = {
        "q": "analytics",
        "pivot": pivot,
        "timeGranularity": granularity,
        "dateRange": f"(start:{_date(start_date)},end:{_date(end_date)})",
        "fields": ",".join(dict.fromkeys([*metrics, "dateRange", "pivotValues"])),
    }
    if campaign_ids:
        params["campaigns"] = _list([f"urn:li:sponsoredCampaign:{c}" for c in campaign_ids])
    else:
        params["accounts"] = _list([f"urn:li:sponsoredAccount:{account_id}"])
    return _get("/adAnalytics", params).get("elements", [])


def _rows(
    account_id: str, elements: list[dict[str, Any]], pivot: str, granularity: str,
) -> list[dict[str, Any]]:
    names: dict[str, str] = {}
    if pivot == "CAMPAIGN":
        names = _campaign_names(account_id)
    elif pivot == "CAMPAIGN_GROUP":
        names = _group_names(account_id)
    out = []
    for el in elements:
        urn = (el.pop("pivotValues", None) or [""])[0]
        dr = el.pop("dateRange", {})
        row: dict[str, Any] = {"pivot": _label(urn, names), "urn": urn}
        if granularity != "ALL" and dr.get("start"):
            s = dr["start"]
            row["date"] = f"{s['year']:04d}-{s['month']:02d}-{s['day']:02d}"
        row.update(el)
        out.append(_derive(row))
    return out


# --- Tools -----------------------------------------------------------------

@mcp.tool()
def list_ad_accounts() -> list[dict[str, Any]]:
    """List ad accounts the signed-in LinkedIn user has a role on, with name,
    currency, status and the user's role."""
    users = _get("/adAccountUsers", {"q": "authenticatedUser"}).get("elements", [])
    out = []
    for u in users:
        acc_id = _id(u["account"])
        acc = _get(f"/adAccounts/{acc_id}")
        out.append({
            "id": acc_id, "name": acc.get("name"), "currency": acc.get("currency"),
            "status": acc.get("status"), "type": acc.get("type"), "role": u.get("role"),
        })
    return out


@mcp.tool()
def list_campaigns(
    account_id: str,
    statuses: list[str] | None = None,
    include_groups: bool = True,
) -> dict[str, Any]:
    """List campaigns (and campaign groups) in an ad account.

    Args:
        account_id: Numeric ad account ID from list_ad_accounts.
        statuses: Filter, any of ACTIVE, PAUSED, DRAFT, COMPLETED, CANCELED, ARCHIVED.
            Defaults to everything except ARCHIVED and CANCELED, so finished
            campaigns still show up (most accounts are mostly COMPLETED).
        include_groups: Also return campaign groups with their budgets.
    """
    statuses = statuses or ["ACTIVE", "PAUSED", "COMPLETED", "DRAFT"]
    search = f"(status:(values:{_list(statuses)}))"
    camps = _paged(f"/adAccounts/{account_id}/adCampaigns", {"q": "search", "search": search})
    result: dict[str, Any] = {"campaigns": [{
        "id": c["id"], "name": c.get("name"), "status": c.get("status"),
        "type": c.get("type"), "objective": c.get("objectiveType"),
        "costType": c.get("costType"), "dailyBudget": _money(c.get("dailyBudget")),
        "totalBudget": _money(c.get("totalBudget")), "bid": _money(c.get("unitCost")),
        "group": _id(c.get("campaignGroup", "")), "runSchedule": c.get("runSchedule"),
    } for c in camps]}
    if include_groups:
        # Campaign groups have no COMPLETED status; LinkedIn rejects the whole
        # search (400 Invalid param) if it is included.
        group_statuses = [st for st in statuses if st != "COMPLETED"] or ["ACTIVE"]
        groups = _paged(f"/adAccounts/{account_id}/adCampaignGroups",
                        {"q": "search", "search": f"(status:(values:{_list(group_statuses)}))"})
        result["groups"] = [{
            "id": g["id"], "name": g.get("name"), "status": g.get("status"),
            "totalBudget": _money(g.get("totalBudget")), "runSchedule": g.get("runSchedule"),
        } for g in groups]
    return result


@mcp.tool()
def get_performance(
    account_id: str,
    start_date: str | None = None,
    end_date: str | None = None,
    pivot: str = "CAMPAIGN",
    granularity: str = "ALL",
    campaign_ids: list[str] | None = None,
    metrics: list[str] | None = None,
) -> dict[str, Any]:
    """Performance metrics from adAnalytics, with CTR, CPC, CPM and cost per
    conversion/lead computed.

    Args:
        account_id: Numeric ad account ID.
        start_date / end_date: YYYY-MM-DD. Defaults to the last 28 days ending yesterday.
        pivot: What each row is. ACCOUNT, CAMPAIGN_GROUP, CAMPAIGN (default), CREATIVE,
            CONVERSION, or a demographic pivot: MEMBER_JOB_FUNCTION, MEMBER_SENIORITY,
            MEMBER_INDUSTRY, MEMBER_COMPANY, MEMBER_COMPANY_SIZE, MEMBER_COUNTRY_V2,
            MEMBER_REGION_V2, MEMBER_JOB_TITLE. Demographic numbers are approximate.
        granularity: ALL (one row per pivot value, default), DAILY, MONTHLY or YEARLY.
        campaign_ids: Restrict to these campaigns instead of the whole account.
        metrics: adAnalytics field names (max ~18). Defaults to impressions, clicks,
            cost, landing page clicks, website conversions, leads, engagements, video views.
    """
    pivot, granularity = pivot.upper(), granularity.upper()
    if pivot not in PIVOTS:
        raise ValueError(f"Unknown pivot {pivot!r}. Allowed: {sorted(PIVOTS)}")
    if granularity not in GRANULARITIES:
        raise ValueError(f"Unknown granularity {granularity!r}. Allowed: {sorted(GRANULARITIES)}")
    if not start_date or not end_date:
        start_date, end_date = _default_range()
    metrics = metrics or DEFAULT_METRICS
    els = _analytics(account_id, start_date, end_date, pivot, granularity, metrics, campaign_ids)
    rows = _rows(account_id, els, pivot, granularity)
    rows.sort(key=lambda r: (r.get("date", ""), -r.get("costInLocalCurrency", 0)))
    totals = _derive({m: sum(float(r.get(m) or 0) for r in rows) for m in metrics})
    return {"accountId": account_id, "startDate": start_date, "endDate": end_date,
            "pivot": pivot, "granularity": granularity, "rowCount": len(rows),
            "totals": totals, "rows": rows}


@mcp.tool()
def compare_periods(
    account_id: str,
    current_start: str,
    current_end: str,
    previous_start: str,
    previous_end: str,
    pivot: str = "CAMPAIGN",
    row_limit: int = 50,
) -> dict[str, Any]:
    """Compare two date ranges side by side with deltas, account-wide and per pivot
    value (campaign by default). Rows present in only one period get zeros for the
    other."""
    pivot = pivot.upper()
    if pivot not in PIVOTS:
        raise ValueError(f"Unknown pivot {pivot!r}. Allowed: {sorted(PIVOTS)}")
    fields = ["impressions", "clicks", "costInLocalCurrency",
              "externalWebsiteConversions", "oneClickLeads"]

    def run(s: str, e: str) -> dict[str, dict[str, Any]]:
        els = _analytics(account_id, s, e, pivot, "ALL", fields, None)
        return {r["urn"]: r for r in _rows(account_id, els, pivot, "ALL")}

    cur, prev = run(current_start, current_end), run(previous_start, previous_end)

    def total(rows: dict[str, dict[str, Any]]) -> dict[str, Any]:
        return _derive({f: sum(r.get(f, 0) or 0 for r in rows.values()) for f in fields})

    def delta(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k in (*fields, "ctr"):
            out[k] = round((a.get(k) or 0) - (b.get(k) or 0), 4)
        for k in ("clicks", "costInLocalCurrency"):
            out[f"{k}_pct"] = round((a[k] - b[k]) / b[k] * 100, 1) if b.get(k) else None
        return out

    c_tot, p_tot = total(cur), total(prev)
    zero = _derive({f: 0 for f in fields})
    keys = sorted(set(cur) | set(prev),
                  key=lambda k: cur.get(k, {}).get("costInLocalCurrency", 0), reverse=True)
    rows = []
    for k in keys[:row_limit]:
        c, p = cur.get(k, zero), prev.get(k, zero)
        rows.append({"pivot": c.get("pivot") or p.get("pivot") or k, "urn": k,
                     "current": c, "previous": p, "delta": delta(c, p)})
    return {
        "accountId": account_id, "pivot": pivot,
        "current": {"startDate": current_start, "endDate": current_end, **c_tot},
        "previous": {"startDate": previous_start, "endDate": previous_end, **p_tot},
        "delta": delta(c_tot, p_tot),
        "rows": rows,
    }


@mcp.tool()
def list_creatives(account_id: str, campaign_ids: list[str] | None = None) -> list[dict[str, Any]]:
    """List creatives (ads) in an account, optionally only for some campaigns, with
    status and the campaign they belong to. Combine with get_performance(pivot=
    'CREATIVE') for results per ad."""
    params = {"q": "criteria"}
    if campaign_ids:
        params["campaigns"] = _list([f"urn:li:sponsoredCampaign:{c}" for c in campaign_ids])
    rows = _paged(f"/adAccounts/{account_id}/creatives", params)
    return [{
        "id": _id(str(c.get("id", ""))), "name": c.get("name"),
        "status": c.get("intendedStatus"), "review": (c.get("review") or {}).get("status"),
        "campaign": _id(c.get("campaign", "")), "content": c.get("content"),
        "createdAt": c.get("createdAt"),
    } for c in rows]


# --- Write tools: drafts only ---------------------------------------------
#
# Everything below creates entities in DRAFT and nothing can activate them:
# there is deliberately no tool that sets a status to ACTIVE. A person reviews
# the drafts in Campaign Manager and launches them there, so no money can be
# spent from a conversation. Requires the `rw_ads` scope (see README).

FACETS = {
    "locations", "titles", "seniorities", "jobFunctions", "industries", "staffCountRanges",
    "employers", "skills", "interfaceLocales", "audienceMatchingSegments",
    "dynamicSegments", "degrees", "fieldsOfStudy", "groups", "memberBehaviors",
}
OBJECTIVE_OPTIMIZATION = {
    "LEAD_GENERATION": "MAX_LEAD",
    "WEBSITE_VISIT": "MAX_CLICK",
    "WEBSITE_CONVERSIONS": "MAX_CONVERSION",
    "BRAND_AWARENESS": "MAX_IMPRESSION",
}
CTA_LABELS = {
    "APPLY", "DOWNLOAD", "VIEW_QUOTE", "LEARN_MORE", "SIGN_UP", "SUBSCRIBE",
    "REGISTER", "JOIN", "ATTEND", "REQUEST_DEMO", "SEE_MORE", "BUY_NOW", "SHOP_NOW",
}


def _require_write() -> None:
    if "rw_ads" not in auth.granted_scopes():
        raise RuntimeError(
            "The stored LinkedIn token is read-only. Re-run the login with write access: "
            "LINKEDIN_SCOPES='r_ads r_ads_reporting rw_ads' linkedin-ads-mcp auth"
        )


def _ms(d: str) -> int:
    """YYYY-MM-DD (UTC midnight) to epoch milliseconds."""
    y, m, dd = (int(x) for x in d.split("-"))
    from datetime import datetime, timezone
    return int(datetime(y, m, dd, tzinfo=timezone.utc).timestamp() * 1000)


def _account(account_id: str) -> dict[str, Any]:
    return _get(f"/adAccounts/{account_id}")


def _targeting(include: dict[str, list[str]], exclude: dict[str, list[str]] | None) -> dict[str, Any]:
    for facet in [*include, *(exclude or {})]:
        if facet not in FACETS:
            raise ValueError(f"Unknown targeting facet '{facet}'. Use one of: {sorted(FACETS)}")
    facet_urn = "urn:li:adTargetingFacet:{}".format
    out: dict[str, Any] = {"include": {"and": [
        {"or": {facet_urn(f): urns}} for f, urns in include.items() if urns
    ]}}
    if exclude:
        out["exclude"] = {"or": {facet_urn(f): urns for f, urns in exclude.items() if urns}}
    return out


@mcp.tool()
def search_targeting(facet: str, query: str = "", limit: int = 15) -> list[dict[str, str]]:
    """Look up targeting values (URNs) for create_campaign.

    Args:
        facet: One of locations, titles, seniorities, jobFunctions, industries,
            staffCountRanges, employers, skills, interfaceLocales, ...
        query: Free text for typeahead facets (e.g. 'CTO', 'Sweden'). Leave empty
            for small fixed lists (seniorities, staffCountRanges, jobFunctions).
    """
    if facet not in FACETS:
        raise ValueError(f"Unknown facet '{facet}'. Use one of: {sorted(FACETS)}")
    params = {"facet": _enc(f"urn:li:adTargetingFacet:{facet}"), "queryVersion": "QUERY_USES_URNS"}
    if query:
        params.update({"q": "typeahead", "query": _enc(query)})
    else:
        params["q"] = "adTargetingFacet"
    rows = _get("/adTargetingEntities", params).get("elements", [])
    return [{"urn": e.get("urn", ""), "name": e.get("name", "")} for e in rows[:limit]]


@mcp.tool()
def create_campaign_group(
    account_id: str, name: str, start_date: str, end_date: str | None = None,
    total_budget: float | None = None,
) -> dict[str, Any]:
    """Create a campaign group as a DRAFT. Nothing runs until someone launches it in
    Campaign Manager.

    Args:
        start_date / end_date: YYYY-MM-DD. end_date is required with total_budget.
        total_budget: Optional cap in the account currency.
    """
    _require_write()
    acct = _account(account_id)
    body: dict[str, Any] = {
        "account": f"urn:li:sponsoredAccount:{account_id}",
        "name": name,
        "status": "DRAFT",
        "runSchedule": {"start": _ms(start_date), **({"end": _ms(end_date)} if end_date else {})},
    }
    if total_budget is not None:
        if not end_date:
            raise ValueError("end_date is required when total_budget is set")
        body["totalBudget"] = {"amount": f"{total_budget:.2f}", "currencyCode": acct["currency"]}
    resp = _write("POST", f"/adAccounts/{account_id}/adCampaignGroups", body)
    return {"id": _created_id(resp), "name": name, "status": "DRAFT"}


@mcp.tool()
def create_campaign(
    account_id: str,
    campaign_group_id: str,
    name: str,
    objective: str,
    daily_budget: float,
    targeting: dict[str, list[str]],
    start_date: str,
    end_date: str | None = None,
    exclude: dict[str, list[str]] | None = None,
    locale: str = "sv_SE",
    audience_expansion: bool = False,
) -> dict[str, Any]:
    """Create a Sponsored Content campaign as a DRAFT, with automated bidding for the
    objective. Nothing runs until someone launches it in Campaign Manager.

    Args:
        objective: LEAD_GENERATION, WEBSITE_VISIT, WEBSITE_CONVERSIONS or BRAND_AWARENESS.
        daily_budget: In the account currency.
        targeting: Facet -> URNs from search_targeting, ANDed across facets and ORed
            within one, e.g. {"locations": ["urn:li:geo:105117694"],
            "titles": ["urn:li:title:153"], "staffCountRanges": ["urn:li:staffCountRange:(201,500)"]}.
        exclude: Same shape, members matching any of these are excluded.
        locale: Ad language as ll_CC; also sets the campaign locale.
    """
    _require_write()
    if objective not in OBJECTIVE_OPTIMIZATION:
        raise ValueError(f"objective must be one of {sorted(OBJECTIVE_OPTIMIZATION)}")
    if "locations" not in targeting:
        raise ValueError("targeting must include 'locations' (LinkedIn requires a location)")
    acct = _account(account_id)
    language, country = locale.split("_")
    body = {
        "account": f"urn:li:sponsoredAccount:{account_id}",
        "campaignGroup": f"urn:li:sponsoredCampaignGroup:{campaign_group_id}",
        "name": name,
        "type": "SPONSORED_UPDATES",
        "objectiveType": objective,
        "optimizationTargetType": OBJECTIVE_OPTIMIZATION[objective],
        "costType": "CPM",
        "creativeSelection": "OPTIMIZED",
        "dailyBudget": {"amount": f"{daily_budget:.2f}", "currencyCode": acct["currency"]},
        "locale": {"language": language, "country": country},
        "audienceExpansionEnabled": audience_expansion,
        "offsiteDeliveryEnabled": False,
        "connectedTelevisionOnly": False,
        "runSchedule": {"start": _ms(start_date), **({"end": _ms(end_date)} if end_date else {})},
        "targetingCriteria": _targeting(targeting, exclude),
        "status": "DRAFT",
    }
    resp = _write("POST", f"/adAccounts/{account_id}/adCampaigns", body)
    return {"id": _created_id(resp), "name": name, "objective": objective, "status": "DRAFT"}


def _upload_image(owner: str, path: str) -> str:
    """Upload a local image for `owner` (organization URN); returns its image URN."""
    from pathlib import Path
    data = Path(path).expanduser().read_bytes()
    init = _write("POST", "/images", {"initializeUploadRequest": {"owner": owner}},
                  params={"action": "initializeUpload"}).json()["value"]
    put = httpx.put(init["uploadUrl"], content=data, timeout=120,
                    headers={"Authorization": f"Bearer {auth.access_token()}"})
    if put.status_code >= 400:
        raise RuntimeError(f"Image upload failed ({put.status_code}): {put.text[:300]}")
    return init["image"]


@mcp.tool()
def create_ad(
    account_id: str,
    campaign_id: str,
    name: str,
    intro_text: str,
    headline: str,
    image_path: str | None = None,
    image_urn: str | None = None,
    landing_page: str | None = None,
    call_to_action: str = "LEARN_MORE",
    lead_form_id: str | None = None,
) -> dict[str, Any]:
    """Create a single-image Sponsored Content ad as a DRAFT in a campaign, posted as
    the ad account's company page (a "dark" post, not shown on the page feed).

    Args:
        intro_text: The text above the image (keep the first ~150 characters punchy).
        headline: Text under the image (~70 characters).
        image_path: Local PNG/JPG (1200x627 or 1080x1080), uploaded for you.
        image_urn: Or an already uploaded urn:li:image:...
        landing_page: Destination URL (website objectives). Add UTM parameters.
        call_to_action: Button label, e.g. LEARN_MORE, REQUEST_DEMO, DOWNLOAD, SIGN_UP.
        lead_form_id: Lead Gen Form ID for LEAD_GENERATION campaigns (from the form's
            URL in Campaign Manager). Then landing_page is not used.
    """
    _require_write()
    if call_to_action not in CTA_LABELS:
        raise ValueError(f"call_to_action must be one of {sorted(CTA_LABELS)}")
    owner = _account(account_id).get("reference", "")
    if not owner.startswith("urn:li:organization:"):
        raise RuntimeError("The ad account is not linked to a company page; link one in Campaign Manager.")
    if not image_urn:
        if not image_path:
            raise ValueError("Give image_path or image_urn")
        image_urn = _upload_image(owner, image_path)

    post: dict[str, Any] = {
        "adContext": {"dscAdAccount": f"urn:li:sponsoredAccount:{account_id}", "dscStatus": "ACTIVE", "dscName": name},
        "author": owner,
        "commentary": intro_text,
        "visibility": "PUBLIC",
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
        "content": {"media": {"title": headline, "id": image_urn}},
    }
    creative: dict[str, Any] = {
        "inlineContent": {"post": post},
        "campaign": f"urn:li:sponsoredCampaign:{campaign_id}",
        "intendedStatus": "DRAFT",
        "name": name,
    }
    if lead_form_id:
        creative["leadgenCallToAction"] = {"destination": f"urn:li:adForm:{lead_form_id}", "label": call_to_action}
    else:
        if not landing_page:
            raise ValueError("landing_page is required unless lead_form_id is given")
        post["contentLandingPage"] = landing_page
        post["contentCallToActionLabel"] = call_to_action
    resp = _write("POST", f"/adAccounts/{account_id}/creatives", {"creative": creative},
                  params={"action": "createInline"})
    return {"id": _created_id(resp), "name": name, "image": image_urn, "status": "DRAFT"}


@mcp.tool()
def delete_draft(account_id: str, kind: str, entity_id: str) -> dict[str, Any]:
    """Delete something this MCP created, but only while it is still a DRAFT.

    Args:
        kind: campaign_group, campaign or ad.
    """
    _require_write()
    paths = {
        "campaign_group": f"/adAccounts/{account_id}/adCampaignGroups/{entity_id}",
        "campaign": f"/adAccounts/{account_id}/adCampaigns/{entity_id}",
        "ad": f"/adAccounts/{account_id}/creatives/{_enc(f'urn:li:sponsoredCreative:{entity_id}')}",
    }
    if kind not in paths:
        raise ValueError("kind must be campaign_group, campaign or ad")
    current = _get(paths[kind])
    status = current.get("intendedStatus" if kind == "ad" else "status")
    if status != "DRAFT":
        raise RuntimeError(f"Refusing to delete a {kind} in status {status}; only DRAFTs can be deleted here.")
    _write("DELETE", paths[kind])
    return {"deleted": kind, "id": entity_id}


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "auth":
        auth.login(sys.argv[2] if len(sys.argv) > 2 else None)
        return
    mcp.run()


if __name__ == "__main__":
    main()
