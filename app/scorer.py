"""
Virality scoring engine
------------------------
A transparent, explainable feature-based scorer. NOT an LLM and NOT a black box.
It measures the signals that research (e.g. Berger & Milkman, "What Makes Online
Content Viral?") associates with sharing: high-arousal emotion, curiosity gaps,
controversy, timeliness, practical utility, concreteness, source reach.

Every article gets:
  - virality_score (0-100)  : general shareability
  - breakdown               : per-signal contribution (so a score is defensible)
  - niche_fit (0-100)       : how easily the story bridges to your ad niches
  - matched_niche           : which niche it maps to (for newsjacking)

Weights live in WEIGHTS and are meant to be tuned. When you later collect your
own outcome data (which picked news actually produced ads that performed), you
swap this for a model trained on those labels — same interface, better numbers.
"""

from __future__ import annotations
import re
import math
from datetime import datetime, timezone

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    _VADER = SentimentIntensityAnalyzer()
except Exception:  # pragma: no cover - vader optional
    _VADER = None

# ---------------------------------------------------------------------------
# Lexicons  (lowercase, matched as whole words)
# ---------------------------------------------------------------------------
HIGH_AROUSAL_POS = {
    "amazing", "incredible", "stunning", "shocking", "unbelievable", "breakthrough",
    "soar", "soars", "soaring", "surge", "surges", "explode", "explodes", "exploding",
    "record", "historic", "massive", "huge", "boom", "skyrocket", "skyrockets",
    "thrilling", "wild", "epic", "viral", "jaw-dropping", "game-changer", "stunned",
}
HIGH_AROUSAL_NEG = {
    "outrage", "outraged", "fury", "furious", "slams", "slam", "blasts", "blast",
    "crisis", "panic", "fear", "fears", "alarm", "warning", "warns", "threat",
    "danger", "dangerous", "scandal", "scam", "fraud", "disaster", "catastrophe",
    "collapse", "collapses", "crash", "crashes", "plunge", "plunges", "chaos",
    "nightmare", "terrifying", "deadly", "devastating", "shock", "horror", "backlash",
}
LOW_AROUSAL = {  # sadness / contentment -> dampen sharing
    "sad", "sadly", "calm", "quiet", "relaxed", "content", "gentle", "mundane",
    "boring", "routine", "ordinary",
}
CURIOSITY = {  # information-gap / clickbait structures
    "this", "secret", "reason", "reasons", "why", "how", "what", "truth", "reveals",
    "revealed", "finally", "actually", "really", "nobody", "everyone", "should",
    "before", "happens", "happened", "trick", "hack", "hacks", "surprising",
}
CONTROVERSY = {
    "vs", "versus", "battle", "fight", "fights", "clash", "feud", "dispute", "debate",
    "controversy", "controversial", "ban", "banned", "lawsuit", "sue", "sues",
    "accuses", "accused", "row", "divide", "divided", "split", "rejects", "blocked",
}
UTILITY = {
    "how", "tips", "guide", "ways", "save", "saving", "cut", "avoid", "best", "worst",
    "should", "need", "checklist", "steps", "mistakes", "cheaper", "free", "lower",
}
SUPERLATIVE = {
    "best", "worst", "biggest", "largest", "smallest", "first", "last", "only",
    "most", "least", "top", "ultimate", "fastest", "cheapest", "richest",
}
TIMELINESS = {
    "breaking", "just", "now", "today", "tonight", "live", "update", "alert", "new",
    "latest", "this week", "this morning",
}

# Brand-safety: stories you should NOT newsjack for an ad (tragedy/violence/etc).
# The score still computes, but the dashboard flags these so a human steps in.
SENSITIVE = {
    "death", "dead", "dies", "died", "killed", "kills", "murder", "murdered",
    "shooting", "shot", "stabbed", "stabbing", "victim", "victims", "fatal",
    "suicide", "terror", "terrorist", "war", "assault", "abuse", "rape", "crash",
    "wounded", "injured", "massacre", "bombing", "kidnap", "missing", "obituary",
    "cancer", "funeral", "mourns", "grief",
}

# Niche keyword sets — must match the AD_NICHES labels in cloud/index.html exactly.
NICHES = {
    "Home Insurance": {
        "home insurance", "homeowners insurance", "homeowner", "homeowners",
        "premium", "premiums", "policy", "coverage", "claim", "claims",
        "deductible", "insurer", "insurers", "flood insurance", "wildfire",
        "wildfires", "hurricane", "storm", "storms", "hailstorm", "hail",
        "natural disaster", "catastrophe", "flood", "flooding", "tornado",
        "tornadoes", "damage", "damages", "homes", "rebuild", "destroyed",
    },
    "Auto Insurance": {
        "auto insurance", "car insurance", "vehicle", "vehicles", "car crash",
        "collision", "accident", "accidents", "driver", "drivers", "driving",
        "traffic", "dui", "recall", "automaker", "totaled", "pile-up",
        "car", "cars", "highway", "road safety",
    },
    "Medicare": {
        "medicare", "medicaid", "senior", "seniors", "retiree", "retirees",
        "retirement", "social security", "prescription", "drug prices",
        "open enrollment", "part b", "advantage plan", "aca", "obamacare",
        "medical bills", "elderly", "65",
    },
    "Refinance": {
        "refinance", "refi", "mortgage", "mortgages", "interest rate",
        "interest rates", "rate cut", "fed", "federal reserve", "home loan",
        "lending", "heloc", "equity", "apr", "30-year", "fixed rate",
        "housing market", "home prices", "lender", "lenders",
    },
    "Weight Loss Supplements": {
        "weight loss", "obesity", "diet", "dieting", "ozempic", "wegovy",
        "semaglutide", "metabolism", "calories", "appetite", "bmi",
        "overweight", "fat loss", "slimming",
    },
    "Memory Loss Supplements": {
        "memory", "alzheimer", "alzheimer's", "dementia", "cognitive",
        "cognition", "brain health", "brain", "focus", "mental decline",
        "forgetfulness", "nootropic", "aging brain",
    },
    "Gun Permits": {
        "gun", "guns", "firearm", "firearms", "concealed carry", "ccw",
        "second amendment", "pistol", "handgun", "rifle", "gun permit",
        "background check", "nra", "gun law", "gun control", "self-defense",
        "shooting range",
    },
    "Bathroom Services": {
        "bathroom", "shower", "bathtub", "walk-in shower", "remodel",
        "renovation", "plumbing", "tile", "grab bar", "bathroom remodel",
        "wet room",
    },
    "Window Services": {
        "window", "windows", "replacement window", "energy efficient",
        "insulation", "double-pane", "drafty", "weatherization",
        "curb appeal", "home improvement",
    },
    "Bizops": {
        "side hustle", "work from home", "remote work", "business opportunity",
        "entrepreneur", "entrepreneurs", "startup", "make money",
        "passive income", "side income", "freelance", "gig economy",
        "layoffs", "unemployment", "self-employed", "small business",
    },
}

WORD_RE = re.compile(r"[a-z0-9][a-z0-9'\-]*")


def _tokens(text: str):
    return WORD_RE.findall(text.lower())


def _hits(tokens, lexicon):
    """Count lexicon hits (supports single + multi-word phrases)."""
    text = " " + " ".join(tokens) + " "
    n = 0
    for term in lexicon:
        if " " in term:
            n += text.count(" " + term + " ")
        elif term in tokens:
            n += tokens.count(term)
    return n


def _sat(count, k=2.0):
    """Diminishing-returns saturation -> 0..1 (one hit already counts a lot)."""
    return 1.0 - math.exp(-count / k)


# Each signal returns 0..1. Weights are relative and normalised to sum=1.
WEIGHTS = {
    "emotion":      0.24,   # high-arousal emotion (the strongest sharing driver)
    "curiosity":    0.15,   # information-gap pull
    "controversy":  0.12,   # conflict / debate
    "timeliness":   0.13,   # freshness + "breaking/now"
    "utility":      0.09,   # practically useful
    "concreteness": 0.08,   # numbers, $ amounts, specifics
    "sentiment":    0.07,   # strength of sentiment either direction
    "reach":        0.07,   # source authority/reach
    "structure":    0.05,   # length sweet-spot + superlatives
}

# Tiered source reach (extend freely). Unknown domains get a neutral baseline.
SOURCE_TIER = {
    "reuters.com": 1.0, "apnews.com": 1.0, "bbc.com": 1.0, "bbc.co.uk": 1.0,
    "nytimes.com": 0.95, "washingtonpost.com": 0.95, "wsj.com": 0.95,
    "cnn.com": 0.9, "cnbc.com": 0.9, "forbes.com": 0.85, "bloomberg.com": 0.95,
    "theguardian.com": 0.9, "usatoday.com": 0.85, "foxnews.com": 0.85,
    "businessinsider.com": 0.8, "yahoo.com": 0.75, "marketwatch.com": 0.8,
    "nbcnews.com": 0.85, "abcnews.go.com": 0.85,
}


def _age_hours(published_iso: str | None) -> float:
    if not published_iso:
        return 24.0
    try:
        s = published_iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0)
    except Exception:
        return 24.0


def score_article(title: str, summary: str = "", domain: str = "",
                  published: str | None = None) -> dict:
    title = title or ""
    text = f"{title} {summary}".strip()
    toks = _tokens(text)
    ttoks = _tokens(title)

    # --- signals (0..1) ---
    emo_pos = _hits(toks, HIGH_AROUSAL_POS)
    emo_neg = _hits(toks, HIGH_AROUSAL_NEG)
    emo_low = _hits(toks, LOW_AROUSAL)
    emotion = _sat(emo_pos + emo_neg, k=1.5) * (0.7 if emo_low and not (emo_pos + emo_neg) else 1.0)

    curiosity = _sat(_hits(ttoks, CURIOSITY), k=2.0)
    controversy = _sat(_hits(toks, CONTROVERSY), k=1.5)
    utility = _sat(_hits(toks, UTILITY), k=2.0)

    age = _age_hours(published)
    timeliness = 0.5 * math.exp(-age / 18.0) + 0.5 * _sat(_hits(toks, TIMELINESS), k=1.0)

    has_num = 1 if re.search(r"\d", title) else 0
    has_money = 1 if re.search(r"[\$£€]|\d+\s?%|\bpercent\b", text.lower()) else 0
    concreteness = min(1.0, 0.55 * has_num + 0.45 * has_money + 0.2 * _sat(
        len(re.findall(r"\b[A-Z][a-zA-Z]+\b", title)), k=4))

    sentiment = 0.0
    if _VADER and title:
        sentiment = abs(_VADER.polarity_scores(title)["compound"])  # intensity, any sign

    reach = SOURCE_TIER.get(domain.lower().replace("www.", ""), 0.55)

    n_words = len(ttoks)
    length_fit = math.exp(-((n_words - 11) ** 2) / (2 * 5.0 ** 2))  # peak ~8-14 words
    structure = min(1.0, 0.6 * length_fit + 0.4 * _sat(_hits(ttoks, SUPERLATIVE), k=1.0))

    signals = {
        "emotion": emotion, "curiosity": curiosity, "controversy": controversy,
        "timeliness": timeliness, "utility": utility, "concreteness": concreteness,
        "sentiment": sentiment, "reach": reach, "structure": structure,
    }
    wsum = sum(WEIGHTS.values())
    raw = sum(signals[k] * WEIGHTS[k] for k in WEIGHTS) / wsum

    # Calibration fit to a real fetched sample (median raw ~0.21): median -> 50,
    # top decile -> low 90s, weak stories -> 20s-30s. Re-fit on your own data.
    CENTER, SCALE = 0.21, 0.11
    score = round(100 / (1 + math.exp(-(raw - CENTER) / SCALE)), 1)

    breakdown = {k: round(100 * signals[k], 0) for k in signals}

    # --- niche fit (for newsjacking selection) --- title-based for precision
    best_niche, best_n = None, 0
    niche_counts = {}
    for niche, kws in NICHES.items():
        c = _hits(ttoks, kws)
        niche_counts[niche] = c
        if c > best_n:
            best_n, best_niche = c, niche
    niche_fit = round(100 * _sat(best_n, k=1.0), 0) if best_n else 0
    if not best_niche:
        best_niche = "General (bridge needed)"

    sensitive = _hits(ttoks, SENSITIVE) > 0

    return {
        "virality_score": score,
        "breakdown": breakdown,
        "niche_fit": niche_fit,
        "matched_niche": best_niche,
        "niche_counts": niche_counts,
        "sensitive": sensitive,
    }


if __name__ == "__main__":
    samples = [
        ("Home insurance premiums soar as wildfire risk explodes across California",
         "", "wsj.com", None),
        ("Fed signals surprise rate cut — what it means for refinancing your mortgage",
         "", "cnbc.com", None),
        ("Local council holds routine meeting on parking", "", "example.com", None),
        ("5 cheap home repairs that could save you thousands before winter",
         "", "forbes.com", None),
    ]
    for t, s, d, p in samples:
        r = score_article(t, s, d, p)
        print(f"{r['virality_score']:5} | {r['matched_niche']:22} | fit {r['niche_fit']:>3} | {t[:55]}")
