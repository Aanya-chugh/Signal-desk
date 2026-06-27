"""
Daily Slack digest for media buyers — DM broadcast version.

Instead of posting to a single channel, this DMs the digest to EVERY member of the
workspace, so the Signal Desk bot appears in each person's sidebar and the message
lands directly for them. Each person receives:
  - "Today's Top 5"            : highest-virality stories from the last ~28 hours
  - "Still trending this week" : stories first seen 2-7 days ago, still active

Each story shows its matched niche(s) and has generate buttons. The buttons are
handled by the /api/slack endpoint on Vercel (unchanged).

Run by GitHub Actions on a daily schedule.

Env needed:
  SUPABASE_URL, SUPABASE_SERVICE_KEY   — data
  SLACK_BOT_TOKEN                      — must be re-issued AFTER adding the scopes
                                         users:read and im:write, then reinstalling.
Optional env:
  DIGEST_TEST_USER     — DM only this one person first (Slack ID like U0..., or an
                         @handle / email). Great for a safe test before the full blast.
  DIGEST_INCLUDE_GUESTS— "true" to also DM single/multi-channel guests (default: skip).
  DIGEST_MAX_USERS     — integer cap on how many people to DM (safety throttle).
  SLACK_CHANNEL_ID     — no longer required (delivery is DM-only).
"""
from __future__ import annotations
import json, os, sys, time, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timezone

AD_NICHES = ["Home Insurance", "Medicare", "Refinance", "Memory Loss Supplements",
             "Weight Loss Supplements", "Bathroom Services", "Gun Permits",
             "Bizops", "Window Services", "Auto Insurance"]


def _req(url, headers=None, data=None, method="GET", _tries=3):
    """HTTP request with basic 429/transient retry. Returns "" on failure (never raises)."""
    last = ""
    for attempt in range(_tries):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = e.headers.get("Retry-After", "2")
                try:
                    wait = int(wait)
                except Exception:
                    wait = 2
                time.sleep(min(wait, 30) + 1)
                last = "429 rate-limited"
                continue
            last = "HTTP %s: %s" % (e.code, e.read().decode("utf-8", "ignore")[:200])
        except Exception as e:
            last = str(e)
        time.sleep(1.5 * (attempt + 1))
    print("Request failed (%s): %s" % (url.split("?")[0], last), file=sys.stderr)
    return ""


def _ts(v):
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        return None


def _primary_niche(matched: str) -> str:
    """First genuinely-matched niche, or '' when the story is General (no real match)."""
    first = (matched or "").split(", ")[0].strip()
    return first if first in AD_NICHES else ""


def _niche_select(primary: str) -> dict:
    opts = [{"text": {"type": "plain_text", "text": n}, "value": n} for n in AD_NICHES]
    sel = {"type": "static_select", "action_id": "niche",
           "placeholder": {"type": "plain_text", "text": "Select niche"},
           "options": opts}
    init = next((o for o in opts if o["value"] == primary), None)
    if init:                       # only pre-select when there's a real matched niche
        sel["initial_option"] = init
    return sel


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
            _btn("gen_all", "⚡ Generate all", value),
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
        print("Slack postMessage error: " + json.dumps(out), file=sys.stderr)
    return out


# ---------- member enumeration + DM opening (new) ----------
def list_all_members(token: str, include_guests: bool = False) -> list:
    """All real, active humans in the workspace (paginated). Needs scope users:read."""
    users, cursor = [], ""
    while True:
        params = {"limit": 200}
        if cursor:
            params["cursor"] = cursor
        out = json.loads(_req("https://slack.com/api/users.list?" + urllib.parse.urlencode(params),
                              headers={"Authorization": "Bearer " + token}) or "{}")
        if not out.get("ok"):
            print("users.list error: " + json.dumps(out), file=sys.stderr)
            break
        for u in out.get("members", []):
            if u.get("is_bot") or u.get("deleted"):
                continue
            if u.get("id") == "USLACKBOT":
                continue
            if not include_guests and (u.get("is_restricted") or u.get("is_ultra_restricted")):
                continue
            users.append(u)
        cursor = (out.get("response_metadata") or {}).get("next_cursor") or ""
        if not cursor:
            break
        time.sleep(0.4)
    return users


def open_dm(token: str, user_id: str):
    """Open (or reuse) the bot's DM with a user; returns the DM channel id. Needs im:write."""
    body = json.dumps({"users": user_id}).encode()
    out = json.loads(_req("https://slack.com/api/conversations.open",
                          headers={"Authorization": "Bearer " + token,
                                   "Content-Type": "application/json; charset=utf-8"},
                          data=body, method="POST") or "{}")
    if out.get("ok"):
        return (out.get("channel") or {}).get("id")
    print("conversations.open error for %s: %s" % (user_id, json.dumps(out)), file=sys.stderr)
    return None


def _match_test_user(users: list, needle: str):
    """Find one member by Slack ID, @username, email, or display name (no extra scope needed)."""
    needle = needle.strip().lstrip("@").lower()
    for u in users:
        prof = u.get("profile") or {}
        cand = {str(u.get("id", "")).lower(), str(u.get("name", "")).lower(),
                str(prof.get("email", "")).lower(), str(prof.get("display_name", "")).lower()}
        if needle in cand:
            return u
    return None


# ---------- the digest itself, posted to ONE target channel/DM ----------
def post_digest_to(token: str, channel: str, top5: list, recurring: list, date_str: str):
    """Post the full digest into a single channel id (a DM here). Returns posts made, or None if it couldn't even post the header."""
    head = _post(token, channel, [
        {"type": "header", "text": {"type": "plain_text", "text": "📰 Signal Desk — Today's Top 5", "emoji": True}},
        {"type": "context", "elements": [{"type": "mrkdwn",
            "text": f"{date_str} · biggest US stories to newsjack today · pick a niche on a story, then tap a button"}]},
    ], "Signal Desk — Today's Top 5")
    if not head.get("ok"):
        return None

    posted = 0
    if not top5:
        _post(token, channel, [{"type": "section", "text": {"type": "mrkdwn",
              "text": "_No fresh stories in the last day._"}}], "No fresh stories")
    for i, r in enumerate(top5, 1):
        time.sleep(0.4)
        if _post(token, channel, story_blocks(r, f"{i}. "), (r.get("title") or "Story")[:120]).get("ok"):
            posted += 1

    if recurring:
        time.sleep(0.4)
        _post(token, channel, [
            {"type": "header", "text": {"type": "plain_text", "text": "🔁 Still trending this week", "emoji": True}},
        ], "Still trending this week")
        for r in recurring:
            time.sleep(0.4)
            b = story_blocks(r, "")
            b[0]["text"]["text"] += f"   _· trending {r.get('_age', 0)}d_"
            if _post(token, channel, b, (r.get("title") or "Story")[:120]).get("ok"):
                posted += 1
    return posted


def run() -> dict:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]
    token = os.environ["SLACK_BOT_TOKEN"]

    include_guests = os.environ.get("DIGEST_INCLUDE_GUESTS", "").strip().lower() in ("1", "true", "yes")
    test_user = os.environ.get("DIGEST_TEST_USER", "").strip()
    try:
        max_users = int(os.environ.get("DIGEST_MAX_USERS", "0") or "0")
    except Exception:
        max_users = 0

    # 1) fetch + select stories (same as before)
    raw = _req(base + "/rest/v1/articles?select=*&order=virality_score.desc&limit=400",
               headers={"apikey": key, "Authorization": "Bearer " + key})
    rows = json.loads(raw or "[]")
    top5, recurring = select_stories(rows if isinstance(rows, list) else [])

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%a %b %-d") if os.name != "nt" else now.strftime("%a %b %d")

    # 2) resolve who to DM
    members = list_all_members(token, include_guests=include_guests)
    if not members:
        print("No members resolved. Check that the bot token has the users:read scope "
              "(you must reinstall the app after adding scopes).", file=sys.stderr)
        sys.exit(1)

    if test_user:
        m = _match_test_user(members, test_user)
        if not m:
            print("DIGEST_TEST_USER '%s' not found among workspace members." % test_user, file=sys.stderr)
            sys.exit(1)
        prof = m.get("profile") or {}
        print("TEST MODE — DMing only %s (%s)" % (m.get("id"), prof.get("real_name") or m.get("name")), file=sys.stderr)
        members = [m]

    if max_users > 0:
        members = members[:max_users]

    # 3) DM the digest to each person
    delivered, failed, total_posts = 0, 0, 0
    for idx, u in enumerate(members, 1):
        dm = open_dm(token, u.get("id"))
        if not dm:
            failed += 1
            continue
        posted = post_digest_to(token, dm, top5, recurring, date_str)
        if posted is None:
            failed += 1
        else:
            delivered += 1
            total_posts += posted
        time.sleep(0.4)  # gentle pacing between people
        if idx % 25 == 0:
            print("…%d/%d DMs sent" % (idx, len(members)), file=sys.stderr)

    return {"delivered_to": delivered, "failed": failed,
            "messages_posted": total_posts, "members_targeted": len(members)}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
