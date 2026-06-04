"""
The sync job — runs every 30 minutes.

Pipeline:  fetch live news  ->  score virality + niche fit + safety  ->  store.
Ad copy is NOT generated here; that happens on demand when a user selects a
story on the dashboard.

Trigger this with GitHub Actions cron (see .github/workflows/sync.yml). Vercel's
free tier can't run a sub-daily cron, so an external scheduler hits this instead.
Run locally:  python -m app.sync
"""
from __future__ import annotations
import json, os, sys, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta
from app.fetcher import fetch_all
from app.scorer import score_article
from app.store import upsert_articles


# How many days of news to keep. Stories first seen longer ago than this get
# deleted on every sync, so the dashboard stays fresh for newsjacking and the
# database stays small. Change this ONE number to keep more or less (e.g. 7).
PRUNE_DAYS = 14


def prune_old(days: int = PRUNE_DAYS) -> int:
    """Delete articles first seen more than `days` days ago (cloud / Supabase).
    Keeps the live database fresh and bounded. No-op on a local run."""
    base = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not (base and key):
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = base.rstrip("/") + "/rest/v1/articles?first_seen=lt." + urllib.parse.quote(cutoff)
    req = urllib.request.Request(url, method="DELETE", headers={
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Accept": "application/json",
        "Prefer": "return=representation",
    })
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read().decode("utf-8", "ignore") or "[]")
        return len(data) if isinstance(data, list) else 0
    except Exception as e:
        print("prune skipped: " + str(e), file=sys.stderr)
        return 0


def run() -> dict:
    started = datetime.now(timezone.utc)
    articles = fetch_all()
    for a in articles:
        a.update(score_article(a.get("title", ""), a.get("summary", ""),
                               a.get("domain", ""), a.get("published")))
    saved = upsert_articles(articles)
    pruned = prune_old()
    top = sorted(articles, key=lambda r: r["virality_score"], reverse=True)[:5]
    summary = {
        "ran_at": started.isoformat(),
        "fetched": len(articles),
        "stored": saved,
        "pruned": pruned,
        "top": [{"score": t["virality_score"], "niche": t["matched_niche"],
                 "title": t["title"][:70]} for t in top],
    }
    return summary


if __name__ == "__main__":
    out = run()
    print(json.dumps(out, indent=2))
    sys.exit(0)
