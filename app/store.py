"""
Storage layer.

MVP uses SQLite (zero setup, runs anywhere). For production with a Vercel
dashboard, point this at Supabase/Postgres so the web app can read the same
table — the upsert_articles() / get_articles() interface stays identical, you
just swap the connection. (Supabase gives you a free Postgres + an auto REST
API the Next.js dashboard can read directly.)
"""
from __future__ import annotations
import sqlite3, json, hashlib, os
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", "news.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles(
  id TEXT PRIMARY KEY,
  title TEXT, summary TEXT, url TEXT, domain TEXT, source TEXT,
  published TEXT, category TEXT,
  virality_score REAL, niche_fit REAL, matched_niche TEXT,
  sensitive INTEGER, breakdown TEXT,
  first_seen TEXT, last_scored TEXT
);
CREATE INDEX IF NOT EXISTS idx_vir ON articles(virality_score DESC);
"""


def _id(a: dict) -> str:
    return hashlib.sha1((a.get("title", "") + a.get("domain", "")).encode()).hexdigest()[:16]


def init():
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    con.commit()
    con.close()


def _supabase_upsert(rows: list[dict]) -> int:
    """Cloud path: upsert into Supabase Postgres via its REST API (no extra deps).
    Active when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (e.g. in GitHub Actions).
    Note: 'first_seen' is intentionally omitted so the DB default keeps it stable on
    updates; only new rows get a fresh first_seen."""
    import urllib.request
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]
    now = datetime.now(timezone.utc).isoformat()
    payload = [{
        "id": _id(a), "title": a.get("title"), "summary": a.get("summary"),
        "url": a.get("url"), "domain": a.get("domain"), "source": a.get("source"),
        "published": a.get("published"), "category": a.get("category"),
        "virality_score": a.get("virality_score"), "niche_fit": a.get("niche_fit"),
        "matched_niche": a.get("matched_niche"), "sensitive": bool(a.get("sensitive")),
        "breakdown": a.get("breakdown", {}), "last_scored": now,
    } for a in rows]
    req = urllib.request.Request(
        base + "/rest/v1/articles?on_conflict=id",
        data=json.dumps(payload).encode(), method="POST",
        headers={"apikey": key, "Authorization": "Bearer " + key,
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    urllib.request.urlopen(req, timeout=40)
    return len(payload)


def upsert_articles(rows: list[dict]) -> int:
    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_KEY"):
        return _supabase_upsert(rows)   # cloud
    init()                              # local SQLite
    now = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(DB_PATH)
    n = 0
    for a in rows:
        aid = _id(a)
        exists = con.execute("SELECT 1 FROM articles WHERE id=?", (aid,)).fetchone()
        con.execute("""
            INSERT INTO articles(id,title,summary,url,domain,source,published,category,
              virality_score,niche_fit,matched_niche,sensitive,breakdown,first_seen,last_scored)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              virality_score=excluded.virality_score, niche_fit=excluded.niche_fit,
              matched_niche=excluded.matched_niche, sensitive=excluded.sensitive,
              breakdown=excluded.breakdown, last_scored=excluded.last_scored
        """, (aid, a.get("title"), a.get("summary"), a.get("url"), a.get("domain"),
              a.get("source"), a.get("published"), a.get("category"),
              a.get("virality_score"), a.get("niche_fit"), a.get("matched_niche"),
              1 if a.get("sensitive") else 0, json.dumps(a.get("breakdown", {})),
              now if not exists else None, now))
        # keep first_seen stable
        if not exists:
            con.execute("UPDATE articles SET first_seen=? WHERE id=? AND first_seen IS NULL", (now, aid))
        n += 1
    con.commit()
    con.close()
    return n


def get_articles(limit: int = 200, niche: str | None = None,
                 min_score: float = 0, hide_sensitive: bool = False) -> list[dict]:
    init()
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    q = "SELECT * FROM articles WHERE virality_score>=?"
    p: list = [min_score]
    if niche:
        q += " AND matched_niche=?"; p.append(niche)
    if hide_sensitive:
        q += " AND sensitive=0"
    q += " ORDER BY virality_score DESC LIMIT ?"; p.append(limit)
    rows = [dict(r) for r in con.execute(q, p).fetchall()]
    con.close()
    for r in rows:
        r["breakdown"] = json.loads(r["breakdown"] or "{}")
        r["sensitive"] = bool(r["sensitive"])
    return rows
