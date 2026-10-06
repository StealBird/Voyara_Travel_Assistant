"""Voyara backend (FastAPI).

Endpoints
  GET  /health
  POST /api/itinerary   -> Groq LLM drafts the plan, rule layer validates it
  GET  /api/weather     -> OpenWeatherMap + "swap to indoor?" rule
  POST /api/images      -> per-place photos (Wikipedia -> Commons -> city fallback)
  POST /api/chat        -> multilingual local-guide chat
"""
import asyncio
import json
import os
import time
from datetime import date
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from pydantic import BaseModel, Field

load_dotenv()

MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
MAX_CHUNK_DAYS = 7
# Stop costs (tickets + meals) may use at most this share of the budget.
# The rest is kept for the stay and local transport.
SPEND_SHARE = 0.55

# Wikimedia blocks generic User-Agents. Put your real email here.
WIKI_HEADERS = {
    "User-Agent": "VoyaraHackathonApp/1.0 (student project; contact: kunalpmahajan333@gmail.com)"
}

app = FastAPI(title="Voyara API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_methods=["*"],
    allow_headers=["*"],
)

_client: Optional[Groq] = None
_cache: dict = {}  # itinerary cache: same request twice -> instant answer
_image_cache: dict = {}  # image cache: "place|city" -> url


def get_client() -> Groq:
    global _client
    if _client is None:
        _client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    return _client


# ---------- request shape ----------
class TripRequest(BaseModel):
    destination: str = "Kyoto, Japan"
    start_date: date
    end_date: date
    budget_inr: int = Field(75000, ge=1000)
    budget: Optional[int] = None  # the frontend sends this name
    interests: list[str] = ["Culture", "Food"]
    accessibility: bool = False
    day_offset: int = 0  # which day of the full trip this chunk starts at
    total_days: Optional[int] = None  # length of the full trip


# ---------- 1. itinerary: LLM draft + rule validation ----------
SYSTEM_PROMPT = """You are Voyara's trip planner. Return ONLY valid JSON, no prose, no code fences.
Schema:
{"days":[{"theme":str (3-6 words),
"area":str (main neighbourhood of the day),
"overnight":str (neighbourhood to sleep in tonight, normally where the last stop is),
"bridge":str (one short line: how tomorrow starts from where today ends),
"stops":[{"time":"HH:MM","name":str,"category":"Sight|Food|Culture|Nature|Walk|Shopping|Evening|Indoor|Explore",
"description":str (one short line),
"why":str (one short line: why THIS place fits THIS traveller, mention their interest or budget),
"badge":str (2-4 words),
"insights":[str,str,str] (very short, review-style),
"cost_inr":int (per-person cost at this stop in INR, 0 if free),
"travel":str (from the previous stop, e.g. '12 min by taxi'),
"transport":{"nearest":str (real nearest metro/train/bus stop),"mode":"Metro|Train|Bus|Tram|Ferry|Taxi|Walk",
"distance":str (e.g. '400 m walk'),"tip":str (very short)}}]}]}
Rules: 4 stops per day, times ascending between 08:00 and 21:00, real places only,
never repeat a place, keep every text field short.
Group each day's stops in one or two nearby areas. Day N+1 must start in or next to the
overnight area of day N, so the days connect.
Only name transport stops you are sure exist; if unsure use mode Taxi and nearest "Taxi stand".
All cost_inr values together must stay under 55 percent of the budget (the rest is for stay and local transport)."""


def build_prompt(req: TripRequest, n_days: int) -> str:
    budget = req.budget or req.budget_inr
    p = (
        f"Plan {n_days} days in {req.destination}. Budget: INR {budget}. "
        f"Interests: {', '.join(req.interests)}. "
        f"Accessibility needs: {'YES - prefer step-free venues, avoid steep climbs' if req.accessibility else 'no'}."
    )
    is_last_chunk = not req.total_days or req.day_offset + n_days >= req.total_days
    if req.total_days and req.total_days > n_days:
        first = req.day_offset + 1
        last = req.day_offset + n_days
        p += f" These are days {first}-{last} of a {req.total_days}-day trip."
        if req.day_offset > 0:
            p += (
                " Other days already cover the most famous landmarks, so pick different neighbourhoods"
                " and lesser-known real places. Start day 1 of this batch near the city centre or main transport hub."
            )
    if is_last_chunk:
        p += " The final day's bridge must be an empty string."
    else:
        p += " The final day's bridge should say tomorrow starts near the city centre."
    return p


def to_int(v) -> int:
    try:
        return max(0, int(float(str(v).replace(",", "").replace("₹", "").strip())))
    except (ValueError, TypeError):
        return 0


def clean_text(v) -> str:
    return str(v).strip() if v is not None else ""


def clean_transport(t) -> Optional[dict]:
    if not isinstance(t, dict):
        return None
    nearest = clean_text(t.get("nearest"))
    if not nearest:
        return None
    return {
        "nearest": nearest,
        "mode": clean_text(t.get("mode")) or "Transit",
        "distance": clean_text(t.get("distance")),
        "tip": clean_text(t.get("tip")),
    }


def validate_itinerary(raw: dict, n_days: int, budget: int) -> dict:
    """Rule layer: never trust the LLM blindly."""
    days = raw.get("days", [])[:n_days]
    if len(days) < n_days:
        raise ValueError(f"Expected {n_days} days, got {len(days)}")
    required = {"time", "name", "category", "description"}
    seen = set()
    for d in days:
        stops = []
        for s in d.get("stops", []):
            key = str(s.get("name", "")).strip().lower()
            if required <= s.keys() and key not in seen:
                seen.add(key)
                s["why"] = clean_text(s.get("why"))
                s["cost_inr"] = to_int(s.get("cost_inr", s.get("cost", 0)))
                s["transport"] = clean_transport(s.get("transport"))
                stops.append(s)
        stops.sort(key=lambda s: s["time"])
        if not stops:
            raise ValueError("A day came back with no valid stops")
        d["stops"] = stops
        d["theme"] = clean_text(d.get("theme"))
        d["area"] = clean_text(d.get("area"))
        d["overnight"] = clean_text(d.get("overnight"))
        d["bridge"] = clean_text(d.get("bridge"))

    # budget rule: stop costs must leave room for the stay
    cap = int(budget * SPEND_SHARE)
    total = sum(s["cost_inr"] for d in days for s in d["stops"])
    if total > cap > 0:
        factor = cap / total
        for d in days:
            for s in d["stops"]:
                s["cost_inr"] = int(round(s["cost_inr"] * factor / 50) * 50)
        print(f"[itinerary] costs scaled by {factor:.2f} to fit the budget")
    return {"days": days}


def call_groq(req: TripRequest, n_days: int) -> str:
    def run(fast: bool):
        kwargs = dict(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_prompt(req, n_days)},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
            max_tokens=6000,
        )
        if fast:
            kwargs["extra_body"] = {"reasoning_effort": "low"}  # far less thinking = much faster
        return get_client().chat.completions.create(**kwargs)

    try:
        resp = run(True)
    except Exception:
        resp = run(False)  # if the model rejects the fast option
    return resp.choices[0].message.content or ""


@app.post("/api/itinerary")
def generate_itinerary(req: TripRequest):
    n_days = (req.end_date - req.start_date).days + 1
    if not 1 <= n_days <= MAX_CHUNK_DAYS:
        raise HTTPException(400, f"Each request must be 1-{MAX_CHUNK_DAYS} days")
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(503, "GROQ_API_KEY not set")

    cache_key = str(req)
    if cache_key in _cache:
        return _cache[cache_key]

    budget = req.budget or req.budget_inr
    started = time.time()
    last_error = "unknown"
    for attempt in range(2):  # small models slip sometimes: retry once
        try:
            text = call_groq(req, n_days)
            raw = json.loads(text[text.index("{"): text.rindex("}") + 1])
            result = validate_itinerary(raw, n_days, budget)
            _cache[cache_key] = result
            print(f"[itinerary] {req.destination} {n_days}d took {time.time() - started:.1f}s (attempt {attempt + 1})")
            return result
        except (ValueError, json.JSONDecodeError) as e:
            last_error = str(e)
        except Exception as e:  # rate limit, network, etc.
            last_error = f"{type(e).__name__}: {e}"
    raise HTTPException(502, f"Bad itinerary from model after 2 tries: {last_error}")


# ---------- 2. weather + swap rule ----------
@app.get("/api/weather")
def weather(city: str = Query("Kyoto")):
    key = os.getenv("OPENWEATHER_API_KEY")
    if not key:
        raise HTTPException(503, "OPENWEATHER_API_KEY not set")
    r = httpx.get(
        "https://api.openweathermap.org/data/2.5/weather",
        params={"q": city, "appid": key, "units": "metric"},
        timeout=10,
    )
    if r.status_code != 200:
        raise HTTPException(502, "Weather provider error")
    j = r.json()
    condition = j["weather"][0]["main"]
    return {
        "temp_c": round(j["main"]["temp"]),
        "condition": condition,
        "swap_to_indoor": condition in {"Rain", "Drizzle", "Thunderstorm", "Snow"},
    }


# ---------- 3. per-place images (no API key needed) ----------
class PlaceReq(BaseModel):
    name: str
    city: str


async def wiki_image(client: httpx.AsyncClient, q: str) -> Optional[str]:
    r = await client.get("https://en.wikipedia.org/w/api.php", params={
        "action": "query", "generator": "search", "gsrsearch": q,
        "gsrlimit": 3, "prop": "pageimages", "piprop": "thumbnail",
        "pithumbsize": 800, "format": "json"})
    r.raise_for_status()
    pages = r.json().get("query", {}).get("pages", {})
    for p in sorted(pages.values(), key=lambda x: x.get("index", 99)):
        if "thumbnail" in p:
            return p["thumbnail"]["source"]
    return None


async def commons_image(client: httpx.AsyncClient, q: str) -> Optional[str]:
    r = await client.get("https://commons.wikimedia.org/w/api.php", params={
        "action": "query", "generator": "search", "gsrnamespace": 6,
        "gsrsearch": q, "gsrlimit": 5, "prop": "imageinfo",
        "iiprop": "url|mime", "iiurlwidth": 800, "format": "json"})
    r.raise_for_status()
    pages = r.json().get("query", {}).get("pages", {})
    for p in sorted(pages.values(), key=lambda x: x.get("index", 99)):
        info = (p.get("imageinfo") or [{}])[0]
        if info.get("mime") == "image/jpeg":
            return info.get("thumburl")
    return None


async def find_image(client: httpx.AsyncClient, name: str, city: str) -> Optional[str]:
    key = f"{name}|{city}".lower()
    if key in _image_cache:
        return _image_cache[key]
    url = None
    for label, lookup in (
        ("wiki", lambda: wiki_image(client, f"{name} {city}")),
        ("commons", lambda: commons_image(client, f"{name} {city}")),
        ("wiki-city", lambda: wiki_image(client, city)),
    ):
        try:
            url = await lookup()
        except Exception as e:  # one source failing must not stop the next
            print(f"[image] {label} failed for '{name}': {type(e).__name__}: {e}")
            url = None
        if url:
            break
    if url:  # don't cache misses, so a retry can succeed
        _image_cache[key] = url
    return url


@app.post("/api/images")
async def images(places: list[PlaceReq]):
    async with httpx.AsyncClient(
        timeout=8, follow_redirects=True, headers=WIKI_HEADERS
    ) as c:
        urls = await asyncio.gather(*[find_image(c, p.name, p.city) for p in places])
    return {"images": urls}


# ---------- 4. multilingual local-guide chat ----------
class ChatMsg(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatReq(BaseModel):
    message: str = Field(..., min_length=1, max_length=1000)
    language: str = "English"
    city: str = "Kyoto"
    history: list[ChatMsg] = []


def chat_system_prompt(city: str, language: str) -> str:
    return (
        f"You are Voyara's friendly local guide for {city}. "
        f"Always reply in {language}. Keep answers short: 2-4 sentences, practical and warm. "
        "Give tips on transport, food, etiquette, timing and safety. "
        "Never invent exact prices, opening hours or phone numbers; if unsure, say so and suggest checking locally."
    )


@app.post("/api/chat")
def chat(req: ChatReq):
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(503, "GROQ_API_KEY not set")
    history = [{"role": m.role, "content": m.content[:1000]}
               for m in req.history[-8:] if m.role in ("user", "assistant")]
    messages = [{"role": "system", "content": chat_system_prompt(req.city, req.language)},
                *history, {"role": "user", "content": req.message}]

    def run(fast: bool):
        kwargs = dict(model=MODEL, messages=messages, temperature=0.5, max_tokens=800)
        if fast:
            kwargs["extra_body"] = {"reasoning_effort": "low"}
        return get_client().chat.completions.create(**kwargs)

    try:
        try:
            resp = run(True)
        except Exception:
            resp = run(False)
        return {"reply": (resp.choices[0].message.content or "").strip()}
    except Exception as e:
        print(f"[chat] failed: {type(e).__name__}: {e}")
        raise HTTPException(502, "Guide is unavailable right now")


@app.get("/health")
def health():
    return {"ok": True}