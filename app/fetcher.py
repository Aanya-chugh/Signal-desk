"""
News fetcher — MULTIPLE free, no-key sources.

Sources (each is fail-safe: if one is blocked/down, it's skipped and the rest
still load, so the dashboard always fills):
  1. Google News RSS   - broad, US-localised, topic feeds + niche queries
  2. GDELT DOC 2.0 API - open global news wire, no key
  3. Direct outlet RSS - BBC, CBS, NPR, The Guardian, NYT, Yahoo (standard RSS)

All return the SAME shape, are de-duplicated across sources by title, and keep
their real publisher + section so the dashboard shows where each story came from.

LICENSING (you're commercial): these are fine for building. Direct outlet RSS is
generally OK to read; before a commercial launch, confirm each outlet's terms or
move to a licensed aggregator (Mediastack allows commercial use; GDELT is open).
Key-based providers (GNews/NewsData/Mediastack) can be added the same way.
"""
from __future__ import annotations
import urllib.request, ssl, html, re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

_CTX = ssl.create_default_context(); _CTX.check_hostname = False; _CTX.verify_mode = ssl.CERT_NONE
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_HDRS = {"User-Agent": _UA, "Accept": "application/rss+xml, application/xml, text/xml, application/json, */*"}
_TAG = re.compile(r"<[^>]+>")


def _get(url: str, timeout: int = 15) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=_HDRS), timeout=timeout, context=_CTX).read()


def _clean(s: str) -> str:
    return html.unescape(_TAG.sub("", s or "")).strip()


def _iso_rfc822(d: str | None) -> str | None:
    if not d:
        return None
    try:
        return parsedate_to_datetime(d).astimezone(timezone.utc).isoformat()
    except Exception:
        return None

# ---------------------------------------------------------------------------
# 1) Google News RSS
# ---------------------------------------------------------------------------
GOOGLE_FEEDS = {
    "Top Stories": "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
    "Business":    "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
    "Technology":  "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en",
    "Nation":      "https://news.google.com/rss/headlines/section/topic/NATION?hl=en-US&gl=US&ceid=US:en",
    "Housing/Mortgage": "https://news.google.com/rss/search?q=mortgage%20OR%20%22home%20insurance%22%20OR%20refinance%20OR%20housing&hl=en-US&gl=US&ceid=US:en",
    "Weather/Disaster": "https://news.google.com/rss/search?q=hurricane%20OR%20wildfire%20OR%20flood%20OR%20storm%20damage&hl=en-US&gl=US&ceid=US:en",
}


def fetch_google(max_per_feed: int = 22) -> list[dict]:
    out = []
    for category, url in GOOGLE_FEEDS.items():
        try:
            root = ET.fromstring(_get(url))
        except Exception:
            continue
        for it in root.findall(".//item")[:max_per_feed]:
            title = _clean(it.findtext("title", ""))
            src = it.find("{http://news.google.com/}source")
            domain = ""
            if src is not None and src.get("url"):
                domain = src.get("url").split("//")[-1].split("/")[0]
            m = re.match(r"^(.*) - ([^-]+)$", title)
            clean_title = m.group(1).strip() if m else title
            out.append({
                "title": clean_title, "summary": _clean(it.findtext("description", "")),
                "url": (it.findtext("link", "") or "").strip(),
                "domain": domain.replace("www.", ""),
                "source": _clean(src.text) if src is not None else "Google News",
                "published": _iso_rfc822(it.findtext("pubDate")), "category": category,
                "origin": "Google News",
            })
    return out

# ---------------------------------------------------------------------------
# 2) GDELT DOC 2.0 API
# ---------------------------------------------------------------------------
GDELT_QUERIES = {
    "Wire · US": "sourcecountry:US",
}


def _iso_gdelt(d: str | None) -> str | None:
    if not d:
        return None
    try:  # format 20260603T120000Z
        return datetime.strptime(d, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat()
    except Exception:
        return None


def fetch_gdelt(max_per_query: int = 45) -> list[dict]:
    import json
    out = []
    for category, q in GDELT_QUERIES.items():
        url = ("https://api.gdeltproject.org/api/v2/doc/doc?query=" + urllib.parse.quote(q) +
               f"&mode=ArtList&maxrecords={max_per_query}&format=json&sort=DateDesc")
        try:  # single fast attempt; GDELT is slow, so don't let it stall startup
            data = json.loads(_get(url, timeout=11))
            for a in data.get("articles", []):
                dom = (a.get("domain") or "").replace("www.", "")
                out.append({
                    "title": _clean(a.get("title", "")), "summary": "",
                    "url": a.get("url", ""), "domain": dom,
                    "source": dom.split(".")[0].upper() if dom else "GDELT",
                    "published": _iso_gdelt(a.get("seendate")), "category": category,
                    "origin": "GDELT",
                })
        except Exception:
            pass
    return out

# ---------------------------------------------------------------------------
# 3) Direct outlet RSS  (fail-safe; some may 403 from datacenter IPs)
# ---------------------------------------------------------------------------
RSS_FEEDS = [
    ("BBC News",     "bbc.com",        "World",    "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("BBC News",     "bbc.com",        "Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("CBS News",     "cbsnews.com",    "Money",    "https://www.cbsnews.com/latest/rss/moneywatch"),
    ("NPR",          "npr.org",        "News",     "https://feeds.npr.org/1001/rss.xml"),
    ("NPR",          "npr.org",        "Business", "https://feeds.npr.org/1006/rss.xml"),
    ("The Guardian", "theguardian.com","US News",  "https://www.theguardian.com/us-news/rss"),
    ("The Guardian", "theguardian.com","Money",    "https://www.theguardian.com/money/rss"),
    ("NYT",          "nytimes.com",    "Business", "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"),
    ("NYT",          "nytimes.com",    "RealEstate","https://rss.nytimes.com/services/xml/rss/nyt/RealEstate.xml"),
    ("Yahoo News",   "yahoo.com",      "News",     "https://www.yahoo.com/news/rss"),
]


def fetch_rss_feeds(max_per_feed: int = 18) -> list[dict]:
    out = []
    for source, domain, category, url in RSS_FEEDS:
        try:
            root = ET.fromstring(_get(url))
        except Exception:
            continue  # blocked/down -> skip, keep going
        items = root.findall(".//item")
        if not items:  # Atom fallback
            items = root.findall(".//{http://www.w3.org/2005/Atom}entry")
        for it in items[:max_per_feed]:
            title = _clean(it.findtext("title") or it.findtext("{http://www.w3.org/2005/Atom}title", ""))
            if not title:
                continue
            desc = it.findtext("description") or it.findtext("{http://www.w3.org/2005/Atom}summary", "")
            pub = it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date")
            out.append({
                "title": title, "summary": _clean(desc)[:300],
                "url": (it.findtext("link", "") or "").strip(),
                "domain": domain, "source": source,
                "published": _iso_rfc822(pub), "category": f"{source} · {category}",
                "origin": source,
            })
    return out

# ---------------------------------------------------------------------------
import urllib.parse  # (used by gdelt; imported late to keep top tidy)


def dedupe(articles: list[dict]) -> list[dict]:
    seen, out = set(), []
    for a in articles:
        key = re.sub(r"[^a-z0-9]", "", (a.get("title") or "").lower())[:55]
        if key and key not in seen:
            seen.add(key); out.append(a)
    return out


def fetch_all() -> list[dict]:
    """Pull every source IN PARALLEL, fail-safe, de-duplicated across sources.
    Total time ~= the slowest single source (not the sum)."""
    from concurrent.futures import ThreadPoolExecutor
    rows = []
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = [ex.submit(fn) for fn in (fetch_google, fetch_gdelt, fetch_rss_feeds)]
        for f in futures:
            try:
                rows += f.result(timeout=25)
            except Exception:
                continue
    return dedupe(rows)


if __name__ == "__main__":
    from collections import Counter
    arts = fetch_all()
    print("fetched", len(arts), "unique articles")
    by = Counter(a["origin"] for a in arts)
    for src, n in by.most_common():
        print(f"  {n:3}  {src}")
