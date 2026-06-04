"""
Ad-copy generation (production).

This is the headline + description generator that runs ONLY for the article a
user selects on the dashboard — never on the whole feed (keeps it free/cheap).

It calls Groq's free API (fast, OpenAI-compatible, generous free tier). Set
GROQ_API_KEY in the environment. To use Gemini instead, swap the URL/payload —
the function contract (news in -> {headline, description} out) stays the same.

The in-browser dashboard demo calls the in-app model directly; this file is what
your deployed backend / serverless route uses with a free provider.
"""
from __future__ import annotations
import os, json, urllib.request

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
NICHES = ("Home Insurance", "Refinance", "Home Services")


def _prompt(article: dict, niche: str) -> str:
    sens = article.get("sensitive")
    extra = (" NOTE: this story is sensitive/tragic, so be respectful, lead with "
             "empathy, and do not trivialize it." if sens else "")
    return (
        f'You are a senior US direct-response copywriter for a {niche} brand.\n'
        f'Trending story:\nTITLE: "{article.get("title","")}"\n'
        f'SOURCE: {article.get("source") or article.get("domain","")}\n'
        f'TOPIC: {article.get("category","")}\n\n'
        f'Write ONE scroll-stopping social ad that newsjacks this story to promote '
        f'{niche} to a US audience. The bridge must feel natural and tasteful, never '
        f'forced or exploitative.{extra}\n'
        'Return ONLY valid JSON, no markdown:\n'
        '{"headline":"<=8 words, punchy","description":"1-2 sentences, <=30 words, '
        'ends with a soft CTA"}'
    )


def generate_ad(article: dict, niche: str | None = None) -> dict:
    niche = niche if niche in NICHES else NICHES[0]
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("Set GROQ_API_KEY (free at console.groq.com).")
    payload = {
        "model": GROQ_MODEL,
        "messages": [{"role": "user", "content": _prompt(article, niche)}],
        "temperature": 0.9, "max_tokens": 300,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        GROQ_URL, data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    resp = json.load(urllib.request.urlopen(req, timeout=40))
    text = resp["choices"][0]["message"]["content"]
    ad = json.loads(text)
    return {"niche": niche, "headline": ad.get("headline", ""),
            "description": ad.get("description", "")}


if __name__ == "__main__":
    demo = {"title": "Fed signals surprise rate cut amid cooling inflation",
            "source": "CNBC", "category": "Business", "sensitive": False}
    try:
        print(generate_ad(demo, "Refinance"))
    except Exception as e:
        print("(needs GROQ_API_KEY)", e)
