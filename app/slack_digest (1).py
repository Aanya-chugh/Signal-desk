"""
Daily Slack digest for media buyers.

Posts, once a day, to a Slack channel:
  - "Today's Top 5"  : highest-virality stories from the last ~28 hours
  - "Still trending this week" : stories first seen 2-7 days ago, still active (recurring)

Each story shows its matched niche(s) and has generate buttons. The buttons are
handled by the /api/slack endpoint on Vercel.

Run by GitHub Actions on a daily schedule.
Env needed: SUPABASE_URL, SUPABASE_SERVICE_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID.
"""
from __future__ import annotations
import json, os, sys, time, urllib.request
from datetime import datetime, timezone

AD_NICHES = ["Home Insurance", "Medicare", "Refinance", "Memory Loss Supplements",
             "Weight Loss Supplements", "Bathroom Services", "Gun Permits",
             "Bizops", "Window Services", "Auto Insurance"]


def _req(url, headers=None, data=None, method="GET"):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "ignore")


def _ts(v):
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        return None


def _primary_niche(matched: str) -> str:
    first = (matched or "").split(", ")[0].strip()
    return first if first in AD_NICHES else "Home Insurance"


def _niche_select(primary: str) -> dict:
    opts = [{"text": {"type": "plain_text", "text": n}, "value": n} for n in AD_NICHES]
    init = next((o for o in opts if o["value"] == primary), opts[0])
    return {"type": "static_select", "action_id": "niche",
            "placeholder": {"type": "plain_text", "text": "Pick niche"},
            "initial_option": init, "options": opts}


def _btn(action_id: str, label: str, value: str) -> dict:
    return {"type": "button", "action_id": action_id,
            "text": {"type": "plain_text", "text": label, "emoji": True}, "value": value}


def story_blocks(r: dict, prefix: str = "") -> list:
    title = (r.get("title") or "").strip() or "(untitled)"
    url = r.get("url") or ""
    src = r.get("source") or r.get("domain") or "—"
    score = int(round(r.get("virality_score") or 0))
    matched = r.get("matched_niche") or "General (bridge needed)"
    link = f"<{url}|{title}>" if url else title
    head = f"*{prefix}{link}*\n`VIR {score}`  ·  {src}  ·  🎯 {matched}"

    sid = str(r.get("id") or "")
    value = json.dumps({
        "t": title[:280], "s": src[:80],
        "d": r.get("domain") or "", "c": r.get("category") or "",
        "x": bool(r.get("sensitive")), "n": _primary_niche(matched),
    })[:1900]

    return [
        {"type": "section", "text": {"type": "mrkdwn", "text": head}},
        {"type": "actions", "block_id": "sd_" + sid, "elements": [
            _niche_select(_primary_niche(matched)),
            _btn("gen_copy", "✍️ Copy", value),
            _btn("gen_image", "🖼 Image", value),
            _btn("gen_imagead", "📸 Image Ad", value),
            _btn("gen_script", "🎬 Video", value),
        ]},
    ]


def select_stories(rows: list):
    """Return (top5, recurring) with an _age (days) attached to recurring items."""
    now = datetime.now(timezone.utc)

    def hours_since(r, field):
        t = _ts(r.get(field))
        return (now - t).total_seconds() / 3600 if t else 1e9

    def recency_h(r):
        return min(hours_since(r, "published"), hours_since(r, "first_seen"))

    def age_d(r):
        t = _ts(r.get("first_seen")) or _ts(r.get("published"))
        return (now - t).total_seconds() / 86400 if t else 999

    today = sorted([r for r in rows if recency_h(r) <= 28],
                   key=lambda r: r.get("virality_score") or 0, reverse=True)
    top5 = today[:5]
    seen = {r.get("id") for r in top5}
    recurring = sorted([r for r in rows if 2 <= age_d(r) <= 7 and r.get("id") not in seen],
                       key=lambda r: r.get("virality_score") or 0, reverse=True)[:3]
    for r in recurring:
        r["_age"] = int(age_d(r))
    return top5, recurring


def _post(token: str, channel: str, blocks: list, text: str) -> dict:
    body = json.dumps({"channel": channel, "blocks": blocks, "text": text,
                       "unfurl_links": False}).encode()
    resp = _req("https://slack.com/api/chat.postMessage",
                headers={"Authorization": "Bearer " + token,
                         "Content-Type": "application/json; charset=utf-8"},
                data=body, method="POST")
    out = json.loads(resp or "{}")
    if not out.get("ok"):
        print("Slack error: " + json.dumps(out), file=sys.stderr)
    return out


def run() -> dict:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]
    token = os.environ["SLACK_BOT_TOKEN"]
    channel = os.environ["SLACK_CHANNEL_ID"]

    raw = _req(base + "/rest/v1/articles?select=*&order=virality_score.desc&limit=400",
               headers={"apikey": key, "Authorization": "Bearer " + key})
    rows = json.loads(raw or "[]")
    top5, recurring = select_stories(rows if isinstance(rows, list) else [])

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%a %b %-d") if os.name != "nt" else now.strftime("%a %b %d")

    # 1) header message
    head = _post(token, channel, [
        {"type": "header", "text": {"type": "plain_text", "text": "📰 Signal Desk — Today's Top 5", "emoji": True}},
        {"type": "context", "elements": [{"type": "mrkdwn",
            "text": f"{date_str} · biggest US stories to newsjack today · pick a niche on a story, then tap a button"}]},
    ], "Signal Desk — Today's Top 5")
    if not head.get("ok"):
        sys.exit(1)  # if we can't even post the header, fail loudly

    posted = 0
    # 2) one message per top story
    if not top5:
        _post(token, channel, [{"type": "section", "text": {"type": "mrkdwn",
              "text": "_No fresh stories in the last day._"}}], "No fresh stories")
    for i, r in enumerate(top5, 1):
        time.sleep(0.5)
        if _post(token, channel, story_blocks(r, f"{i}. "), (r.get("title") or "Story")[:120]).get("ok"):
            posted += 1

    # 3) recurring section: its own header, then one message per story
    if recurring:
        time.sleep(0.5)
        _post(token, channel, [
            {"type": "header", "text": {"type": "plain_text", "text": "🔁 Still trending this week", "emoji": True}},
        ], "Still trending this week")
        for r in recurring:
            time.sleep(0.5)
            b = story_blocks(r, "")
            b[0]["text"]["text"] += f"   _· trending {r.get('_age', 0)}d_"
            if _post(token, channel, b, (r.get("title") or "Story")[:120]).get("ok"):
                posted += 1

    return {"posted": True, "stories": posted}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
