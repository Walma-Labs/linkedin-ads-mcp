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
        "privacy thresholds and hides small groups)."
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


def _get(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    # Rest.li params are pre-encoded; build the query string by hand so the
    # parentheses and commas reach LinkedIn unescaped.
    url = f"{API}{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    resp = httpx.get(url, timeout=60, headers={
        "Authorization": f"Bearer {auth.access_token()}",
        "LinkedIn-Version": API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
    })
    if resp.status_code >= 400:
        try:
            msg = resp.json().get("message", resp.text)
        except ValueError:
            msg = resp.text
        raise RuntimeError(f"LinkedIn API {resp.status_code} on {path}: {msg}")
    return resp.json()


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
        groups = _paged(f"/adAccounts/{account_id}/adCampaignGroups",
                        {"q": "search", "search": search})
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


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "auth":
        auth.login(sys.argv[2] if len(sys.argv) > 2 else None)
        return
    mcp.run()


if __name__ == "__main__":
    main()
