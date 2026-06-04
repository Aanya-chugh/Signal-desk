"""
Local live server.

Run:  python -m app.serve
Then open http://localhost:5000

What it does:
  - Runs the fetch->score->store sync ONCE on startup (so there's data fast),
    then automatically every 30 minutes in a background thread. New stories are
    ADDED to the database; the dashboard reads from the DB, so it grows/updates
    on its own (it polls the API every 60s, no reload needed).
  - Serves the live dashboard at /  (reads /api/news, not a static snapshot).
  - /api/generate calls the free Groq LLM for ad copy IF GROQ_API_KEY is set.

This is the same backend you later deploy to the cloud (Supabase + Vercel);
locally it just keeps everything in news.db.
"""
from __future__ import annotations
import os, threading, time, traceback
from datetime import datetime, timezone
from flask import Flask, jsonify, request, send_from_directory

from app.sync import run as run_sync
from app.store import get_articles
from app import adgen

SYNC_EVERY = int(os.environ.get("SYNC_SECONDS", 1800))  # 30 min
HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)

_status = {"last_sync": None, "fetched": 0, "next_sync": None, "running": False}
_lock = threading.Lock()


def _sync_once():
    if _lock.locked():
        return
    with _lock:
        _status["running"] = True
        try:
            res = run_sync()
            _status["last_sync"] = res["ran_at"]
            _status["fetched"] = res["stored"]
        except Exception:
            traceback.print_exc()
        finally:
            _status["running"] = False
            _status["next_sync"] = datetime.now(timezone.utc).timestamp() + SYNC_EVERY


def _scheduler():
    _sync_once()                      # immediate first fill
    while True:
        time.sleep(SYNC_EVERY)
        print(f"[{datetime.now():%H:%M:%S}] running scheduled sync…")
        _sync_once()


@app.route("/")
def home():
    return send_from_directory(HERE, "dashboard_live.html")


@app.route("/api/news")
def api_news():
    rows = get_articles(
        limit=int(request.args.get("limit", 500)),
        niche=request.args.get("niche") or None,
        min_score=float(request.args.get("min_score", 0)),
        hide_sensitive=request.args.get("hide_sensitive") == "1",
    )
    return jsonify(rows)


@app.route("/api/status")
def api_status():
    return jsonify({**_status, "sync_every": SYNC_EVERY,
                    "has_key": bool(os.environ.get("GROQ_API_KEY"))})


@app.route("/api/sync", methods=["POST"])
def api_sync():
    threading.Thread(target=_sync_once, daemon=True).start()
    return jsonify({"ok": True})


@app.route("/api/generate", methods=["POST"])
def api_generate():
    body = request.get_json(force=True)
    try:
        ad = adgen.generate_ad(body.get("article", {}), body.get("niche"))
        return jsonify(ad)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


if __name__ == "__main__":
    threading.Thread(target=_scheduler, daemon=True).start()
    print("Signal Desk live at http://localhost:5000  (first sync running…)")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)),
            debug=False, use_reloader=False)
