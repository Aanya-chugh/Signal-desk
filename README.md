# Signal Desk — news virality → niche ad pipeline

Fetches live US news every 30 min, scores each story for **virality** and
**niche fit** (home insurance / refinance / home services), stores it, and shows
it on a dashboard. When you pick a story, it generates an ad **headline +
description** that newsjacks it — only for the picked story.

## Pipeline
```
GitHub Actions cron (every 30m)
   └─ app.sync ─ fetch (Google News RSS, no key)
              ─ score  (app.scorer — virality 0-100, niche fit, brand-safety flag)
              ─ store  (app.store — SQLite now / Supabase Postgres in prod)
Dashboard (this dashboard.html now / Next.js on Vercel in prod)
   └─ reads stored news, you pick one ─ app.adgen (free Groq LLM) ─ headline + description
```

## News sources (all free, no key, fail-safe + parallel)
`app/fetcher.py` pulls from several sources at once and de-duplicates across them:
- **Google News RSS** — broad US coverage, topic feeds + niche queries
- **GDELT DOC 2.0** — open global news wire
- **Direct outlet RSS** — BBC, CBS, NPR, The Guardian, NYT, Yahoo

Each source is wrapped so a blocked/slow one is skipped without breaking the run, and they're fetched in parallel (total time ≈ the slowest single source). Some outlet feeds may be blocked from datacenter IPs but work from a normal home connection. To add a key-based provider (GNews/NewsData/Mediastack), add one function returning the same shape.

## The virality score (transparent, not an LLM, not a black box)
Weighted blend of signals research links to sharing, each 0–1, then a monotonic
logistic calibration onto 0–100 (median story ≈ 50). Weights live in
`scorer.WEIGHTS` and are meant to be tuned:

| signal | weight | what it captures |
|---|---|---|
| emotion | 0.24 | high-arousal words (awe, outrage, shock) — the strongest driver |
| curiosity | 0.15 | information-gap / "why / how / this" headline pull |
| timeliness | 0.13 | freshness decay + "breaking / now / today" |
| controversy | 0.12 | conflict, dispute, lawsuit, "slams" |
| utility | 0.09 | practically useful ("how to", "save", "tips") |
| concreteness | 0.08 | numbers, $ / % amounts, named entities |
| sentiment | 0.07 | strength of sentiment (VADER), either direction |
| reach | 0.07 | source authority tier |
| structure | 0.05 | headline length sweet-spot + superlatives |

Also returns **niche_fit** (0–100, which of your 3 niches the story bridges to)
and a **sensitive** flag (tragedy/violence/loss → warns you not to newsjack it).

> This is the *starting* scorer: works on all news today, free, explainable.
> The upgrade is to train a real model on **your own** logged outcomes (which
> picked stories produced ads that actually performed) — same interface, better
> numbers. Do that once you have data, not before.

## Run it locally
```bash
pip install -r requirements.txt
python -m app.sync          # fetch + score + store into news.db
python app/scorer.py        # see the scorer on sample headlines
open dashboard.html         # the dashboard (uses a static snapshot of scored news)
```

## Go to production (all free tiers)
1. **Storage** — create a free Supabase project; point `app/store.py` at its
   Postgres. The dashboard reads the same table.
2. **Scheduler** — push to GitHub; the included workflow runs `app.sync` every
   30 min. (Vercel free cron is daily-only, hence GitHub Actions.)
3. **Ad copy** — get a free `GROQ_API_KEY` (console.groq.com); `app/adgen.py`
   uses it. The dashboard demo here uses the in-app model in the browser.
4. **Frontend** — deploy a Next.js dashboard on Vercel (free) that reads Supabase
   and calls a serverless route → `adgen`. `dashboard.html` is the working UI
   reference to port.

## Licensing note (you're commercial)
Google News RSS is fine for building but a grey area for commercial production.
Before going live, swap the fetcher's primary source for a commercial-permitted
provider (e.g. Mediastack allows commercial use; GDELT is open data). The fetch
functions return the same shape, so it's a one-function change.

## See the live site on your own machine (no cloud needed)
```bash
pip install -r requirements.txt
# optional: enable ad generation with a free key from console.groq.com
set GROQ_API_KEY=your_key        # PowerShell: $env:GROQ_API_KEY="your_key"
python -m app.serve
```
Open http://localhost:5000 . The server fetches + scores + stores news on
startup and then every 30 minutes automatically, ADDING new stories to the
database. The dashboard reads from the DB (not a static file), polls every 60s,
and badges newly-added stories with a green "new" dot. The header shows the last
sync time and a countdown to the next. Click the "Live" dot to sync on demand.

## Run it 24/7 with no machine on
See **DEPLOY.md** — deploys to GitHub Actions (the 30-min fetch) + GitHub Pages
(the always-on dashboard), free, no computer required.
