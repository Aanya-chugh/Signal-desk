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
import json, sys
from datetime import datetime, timezone
from app.fetcher import fetch_all
from app.scorer import score_article
from app.store import upsert_articles


def run() -> dict:
    started = datetime.now(timezone.utc)
    articles = fetch_all()
    for a in articles:
        a.update(score_article(a.get("title", ""), a.get("summary", ""),
                               a.get("domain", ""), a.get("published")))
    saved = upsert_articles(articles)
    top = sorted(articles, key=lambda r: r["virality_score"], reverse=True)[:5]
    summary = {
        "ran_at": started.isoformat(),
        "fetched": len(articles),
        "stored": saved,
        "top": [{"score": t["virality_score"], "niche": t["matched_niche"],
                 "title": t["title"][:70]} for t in top],
    }
    return summary


if __name__ == "__main__":
    out = run()
    print(json.dumps(out, indent=2))
    sys.exit(0)
