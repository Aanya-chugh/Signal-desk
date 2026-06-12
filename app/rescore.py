"""
One-time re-score of EVERY stored article with the current scorer.

The normal 30-min sync only re-scores the fresh news it pulls each run, so older
stories keep whatever niche label they had when they were first scored. After
changing scorer.py (e.g. adding niches), run this once to re-score the whole
backlog so every story gets the new logic immediately.

Run it from GitHub: Actions -> "rescore-backlog" -> Run workflow.
Needs the same secrets as the sync: SUPABASE_URL + SUPABASE_SERVICE_KEY.
"""
from __future__ import annotations
import json, os, sys, urllib.request
from app.scorer import score_article
from app.store import upsert_articles

PAGE = 1000


def fetch_all() -> list[dict]:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]
    headers = {"apikey": key, "Authorization": "Bearer " + key}
    out: list[dict] = []
    offset = 0
    while True:
        url = (base + "/rest/v1/articles?select=*&order=first_seen.desc"
               + "&limit=" + str(PAGE) + "&offset=" + str(offset))
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            rows = json.loads(r.read().decode("utf-8", "ignore") or "[]")
        if not isinstance(rows, list) or not rows:
            break
        out.extend(rows)
        if len(rows) < PAGE:
            break
        offset += PAGE
    return out


def run() -> dict:
    rows = fetch_all()
    for a in rows:
        a.update(score_article(a.get("title", ""), a.get("summary", ""),
                               a.get("domain", ""), a.get("published")))
    saved = 0
    for i in range(0, len(rows), 200):
        saved += upsert_articles(rows[i:i + 200])
    return {"fetched": len(rows), "rescored": saved}


if __name__ == "__main__":
    out = run()
    print(json.dumps(out, indent=2))
    sys.exit(0)
