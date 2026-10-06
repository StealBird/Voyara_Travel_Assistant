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
import math
import os
import re
import time
from datetime import date, datetime, timezone
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
    day_context: list[dict] = []  # per day: base (where we sleep), start time, max_stops


# ---------- 1. itinerary: LLM draft + rule validation ----------
SYSTEM_PROMPT = """You are Voyara's trip planner. Return ONLY valid JSON, no prose, no code fences.
Schema:
{"days":[{"theme":str (3-6 words),
"area":str (main neighbourhood of the day),
"stops":[{"time":"HH:MM","name":str,"category":"Sight|Food|Culture|Nature|Walk|Shopping|Evening|Indoor|Explore",
"description":str (one short line),
"why":str (one short line: why THIS place fits THIS traveller, mention their interest or budget),
"badge":str (2-4 words),
"insights":[str,str,str] (very short, review-style),
"cost_inr":int (per-person cost at this stop in INR, 0 if free),
"transport":{"nearest":str (real nearest metro/train/bus stop),"mode":"Metro|Train|Bus|Tram|Ferry|Taxi|Walk",
"tip":str (very short)}}]}]}
Rules: real places only, never repeat a place, keep every text field short, times ascending and ending by 21:00.
Follow the day plan in the user message: each day has a base (the town where the traveller sleeps), an earliest
start time and a number of stops (4 if not given). Every stop of a day must be within about 15 km of that day's base,
so nobody wakes up far from where they slept. A day with 0 stops returns an empty stops list.
Only name transport stops you are sure exist; if unsure use mode Taxi and nearest "Taxi stand".
All cost_inr values together must stay under 55 percent of the budget (the rest is for stay and local transport)."""


def build_prompt(req: TripRequest, n_days: int) -> str:
    budget = req.budget or req.budget_inr
    p = (
        f"Plan {n_days} days in {req.destination}. Budget: INR {budget}. "
        f"Interests: {', '.join(req.interests)}. "
        f"Accessibility needs: {'YES - prefer step-free venues, avoid steep climbs' if req.accessibility else 'no'}."
    )
    if req.day_context:
        lines = []
        for k, c in enumerate(req.day_context[:n_days]):
            base = clean_text(c.get("base")) or req.destination
            n = to_int(c.get("max_stops", 4))
            if n == 0:
                lines.append(f"Day {k + 1}: base {base}; 0 stops (travel or arrival day)")
            else:
                lines.append(f"Day {k + 1}: base {base}; first stop not before {clean_text(c.get('start')) or '09:00'}; {n} stops")
        p += " Day plan: " + " | ".join(lines) + "."
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


def validate_itinerary(raw: dict, n_days: int, budget: int, contexts: Optional[list] = None) -> dict:
    """Rule layer: never trust the LLM blindly."""
    days = raw.get("days", [])[:n_days]
    if len(days) < n_days:
        raise ValueError(f"Expected {n_days} days, got {len(days)}")
    required = {"time", "name", "category", "description"}
    seen = set()
    for idx, d in enumerate(days):
        ctx = contexts[idx] if contexts and idx < len(contexts) else {}
        max_stops = to_int(ctx.get("max_stops", 4)) if ctx else 4
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
        if ctx and max_stops == 0:
            stops = []  # travel or arrival day: no sightseeing
        elif ctx:
            stops = stops[:max_stops]
        if not stops and not (ctx and max_stops == 0):
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
            result = validate_itinerary(raw, n_days, budget, req.day_context)
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


# ---------- 2b. 5-day forecast, per trip day ----------
WET = {"Rain", "Drizzle", "Thunderstorm", "Snow"}


@app.get("/api/forecast")
def forecast(city: str = Query("Kyoto")):
    """Per-date rain flag for the next ~5 days (OpenWeatherMap free forecast)."""
    key = os.getenv("OPENWEATHER_API_KEY")
    if not key:
        raise HTTPException(503, "OPENWEATHER_API_KEY not set")
    r = httpx.get(
        "https://api.openweathermap.org/data/2.5/forecast",
        params={"q": city, "appid": key, "units": "metric"},
        timeout=10,
    )
    if r.status_code != 200:
        raise HTTPException(502, "Weather provider error")
    j = r.json()
    tz = j.get("city", {}).get("timezone", 0)  # seconds from UTC
    by_day: dict = {}
    for it in j.get("list", []):
        local = datetime.fromtimestamp(it["dt"] + tz, tz=timezone.utc)
        if not 6 <= local.hour <= 21:  # only the hours a tourist is out
            continue
        d = local.date().isoformat()
        cond = it["weather"][0]["main"]
        pop = float(it.get("pop", 0))
        e = by_day.setdefault(d, {"rain": False, "rain_prob": 0.0, "temp_c": -99, "condition": cond})
        wet = cond in WET
        if wet or pop >= 0.6:
            e["rain"] = True
        if wet:
            e["condition"] = cond
        e["rain_prob"] = max(e["rain_prob"], round(pop, 2))
        e["temp_c"] = max(e["temp_c"], round(it["main"]["temp_max"]))
    return {"days": by_day}


# ---------- 2c. reroute one day (rain -> indoor) ----------
class RerouteReq(BaseModel):
    destination: str
    interests: list[str] = []
    accessibility: bool = False
    budget: int = Field(5000, ge=500)  # this day's share of the budget
    reason: str = "rain"
    avoid: list[str] = []  # places already used on other days
    day: dict


REROUTE_PROMPT = """You are Voyara's trip planner. One day of a trip must be re-planned because of REASON.
You get the day as JSON. Return ONLY valid JSON, no prose, no code fences: {"day": <same schema as the input day>}.
Rules: keep the same number of stops and the same times. Keep Food stops and stops that are already indoors unchanged.
Replace outdoor stops (gardens, hikes, viewpoints, walks, open-air sights, parks) with real covered or indoor places
in the same area (museums, galleries, covered markets, arcades, aquariums, indoor halls, workshops, cafes).
For every replaced stop rewrite name, category, description, why (mention it is a rainy-day option), badge, insights,
cost_inr and transport. Update theme and bridge if they no longer fit. Real places only, never use a place
from the avoid list, keep every text field short."""


def groq_complete(system: str, user: str, max_tokens: int = 4000) -> str:
    def run(fast: bool):
        kwargs = dict(
            model=MODEL,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_object"},
            temperature=0.4,
            max_tokens=max_tokens,
        )
        if fast:
            kwargs["extra_body"] = {"reasoning_effort": "low"}
        return get_client().chat.completions.create(**kwargs)

    try:
        resp = run(True)
    except Exception:
        resp = run(False)
    return resp.choices[0].message.content or ""


@app.post("/api/reroute")
def reroute(req: RerouteReq):
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(503, "GROQ_API_KEY not set")
    if not isinstance(req.day.get("stops"), list) or not req.day["stops"]:
        raise HTTPException(400, "Day has no stops")
    user = json.dumps({
        "destination": req.destination,
        "interests": req.interests,
        "accessibility": req.accessibility,
        "avoid": req.avoid[:60],
        "day": req.day,
    })
    system = REROUTE_PROMPT.replace("REASON", req.reason)
    last_error = "unknown"
    started = time.time()
    for attempt in range(2):
        try:
            text = groq_complete(system, user)
            raw = json.loads(text[text.index("{"): text.rindex("}") + 1])
            day = raw.get("day", raw)
            result = validate_itinerary({"days": [day]}, 1, req.budget)
            print(f"[reroute] {req.destination} took {time.time() - started:.1f}s (attempt {attempt + 1})")
            return {"day": result["days"][0]}
        except (ValueError, json.JSONDecodeError) as e:
            last_error = str(e)
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
    raise HTTPException(502, f"Reroute failed after 2 tries: {last_error}")


# ---------- 2d. realistic plan skeleton: where we sleep, how we move ----------
class PlanRequest(BaseModel):
    origin: str
    destination: str
    n_days: int = Field(..., ge=1, le=30)
    budget_inr: int = Field(..., ge=1000)
    interests: list[str] = []
    accessibility: bool = False
    travel_km: Optional[int] = None
    travel_mode: Optional[str] = None


PLAN_PROMPT = """You are Voyara's trip planner. Plan WHERE the traveller sleeps each night and HOW they move between places.
Return ONLY valid JSON, no prose, no code fences:
{"legs":[{"base":str (a real town or city where the traveller sleeps),
"days":int (days spent in this base),
"stay_type":"Hostel/Dorm|Budget hotel|Hotel",
"stay_cost_inr":int (per night, per person),
"transfer":{"mode":str (Flight|Train|Bus|Car|Ferry...),"hours":number (door to door, including airport waiting, connections and transfers),
"depart":"HH:MM" (local time they leave, between 05:00 and 23:00),"cost_inr":int (per person),"note":str (very short)}}]}
Rules: the first leg's transfer goes from the origin to the first base; every later leg's transfer goes from the previous base.
Use as few bases as the trip needs: one base for a single town or a short trip, and change base at most every 2 days.
Never plan a move that is unrealistic: use true travel times for the mode, and a single move must not exceed 20 hours.
The days of all legs add up to n_days. Choose the stay type from the daily budget (tight budget means Hostel/Dorm).
Only use real places. Everyone wakes up in the base they slept in, so a day trip must be possible from that base."""


def hhmm_to_min(v, default: int) -> int:
    try:
        h, m = str(v).split(":")
        return max(0, min(1439, int(h) * 60 + int(m)))
    except (ValueError, TypeError):
        return default


def min_to_hhmm(m: int) -> str:
    m %= 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def validate_plan(raw: dict, n_days: int) -> list:
    legs_in = raw.get("legs")
    if not isinstance(legs_in, list) or not legs_in:
        raise ValueError("plan has no legs")
    legs = []
    for l in legs_in[:8]:
        if not isinstance(l, dict):
            continue
        base = clean_text(l.get("base"))
        if not base:
            continue
        t = l.get("transfer") if isinstance(l.get("transfer"), dict) else {}
        try:
            hours = float(t.get("hours", 1))
        except (TypeError, ValueError):
            hours = 1.0
        hours = max(0.25, min(22.0, hours))
        dep = max(5 * 60, min(23 * 60, hhmm_to_min(t.get("depart"), 9 * 60)))
        arr = dep + int(hours * 60)
        legs.append({
            "base": base,
            "days": max(1, to_int(l.get("days", 1))),
            "stay_type": clean_text(l.get("stay_type")),
            "stay_cost_inr": to_int(l.get("stay_cost_inr")),
            "transfer": {
                "mode": clean_text(t.get("mode")) or "Transit",
                "hours": round(hours, 1),
                "depart": min_to_hhmm(dep),
                "arrive": min_to_hhmm(arr),
                "cost_inr": to_int(t.get("cost_inr")),
                "note": clean_text(t.get("note")),
                "travel_days": arr // 1440,  # 1 means they arrive the next calendar day
            },
        })
    if not legs:
        raise ValueError("plan has no usable legs")
    total = sum(l["days"] for l in legs)
    while total > n_days and legs:  # make the days add up to the trip length
        last = legs[-1]
        cut = min(total - n_days, last["days"] - 1)
        if cut > 0:
            last["days"] -= cut
            total -= cut
        else:
            total -= last["days"]
            legs.pop()
    if not legs:
        raise ValueError("plan does not fit the trip length")
    if total < n_days:
        legs[-1]["days"] += n_days - total
    return legs


def schedule(legs: list) -> list:
    """One entry per trip day: base, earliest start, how many stops fit, and the move (on a leg's first day)."""
    days = []
    for li, leg in enumerate(legs):
        t = leg["transfer"]
        arrive = hhmm_to_min(t["arrive"], 12 * 60)
        real_td = t["travel_days"]
        travel_days = min(real_td, leg["days"] - 1)
        for k in range(leg["days"]):
            kind, start = "normal", 9 * 60
            if k < travel_days:
                kind, start = "travel", None
            elif k == travel_days:
                kind = "arrival"
                if real_td == 0:
                    start = max(arrive + 60, 9 * 60)  # check in first
                else:
                    start = 10 * 60 if arrive < 6 * 60 else arrive + 60
            n = 0 if start is None else max(0, min(4, (21 * 60 - start) // 150))
            days.append({
                "leg": li,
                "base": leg["base"],
                "kind": kind,
                "start": "" if start is None else min_to_hhmm(start),
                "max_stops": n,
                "transfer": t if k == 0 else None,
                "stay_type": leg["stay_type"],
                "stay_cost_inr": leg["stay_cost_inr"],
            })
    if days:
        days[-1]["stay_cost_inr"] = 0  # no night after the last day
    return days


@app.post("/api/plan")
def plan(req: PlanRequest):
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(503, "GROQ_API_KEY not set")
    user = json.dumps({
        "origin": req.origin,
        "destination": req.destination,
        "n_days": req.n_days,
        "budget_per_day_inr": req.budget_inr // req.n_days,
        "interests": req.interests,
        "accessibility": req.accessibility,
        "distance_km": req.travel_km,
        "suggested_mode": req.travel_mode,
    })
    last_error = "unknown"
    started = time.time()
    for attempt in range(2):
        try:
            text = groq_complete(PLAN_PROMPT, user, max_tokens=1500)
            raw = json.loads(text[text.index("{"): text.rindex("}") + 1])
            legs = validate_plan(raw, req.n_days)
            print(f"[plan] {req.origin} -> {req.destination} took {time.time() - started:.1f}s (attempt {attempt + 1})")
            return {"legs": legs, "days": schedule(legs)}
        except (ValueError, json.JSONDecodeError) as e:
            last_error = str(e)
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
    raise HTTPException(502, f"Plan failed after 2 tries: {last_error}")


# ---------- 2e. stays, medical and transit near a point (OpenStreetMap, no key) ----------
class NearbyReq(BaseModel):
    lat: float
    lng: float
    radius_m: int = Field(1500, ge=200, le=5000)
    kinds: list[str] = ["stay", "medical"]


OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
KIND_FILTERS = {
    "stay": ['["tourism"~"^(hotel|hostel|guest_house|motel|apartment|chalet)$"]'],
    "medical": ['["amenity"~"^(hospital|clinic|pharmacy|doctors)$"]'],
    "transit": [
        '["railway"~"^(station|halt|tram_stop|subway_entrance)$"]',
        '["highway"="bus_stop"]',
        '["amenity"="bus_station"]',
    ],
}
KIND_LIMIT = {"stay": 30, "medical": 20, "transit": 12}
STAY_SUB = {"hostel": "Hostel / dorm", "hotel": "Hotel", "guest_house": "Guesthouse",
            "motel": "Motel", "apartment": "Apartment", "chalet": "Chalet"}
_nearby_cache: dict = {}


def haversine_m(lat1, lng1, lat2, lng2) -> int:
    r = math.pi / 180
    a = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lng2 - lng1) * r / 2) ** 2
    return int(2 * 6371000 * math.asin(math.sqrt(a)))


def classify(tags: dict):
    t, a, rw, hw = tags.get("tourism"), tags.get("amenity"), tags.get("railway"), tags.get("highway")
    if t in STAY_SUB:
        return "stay", STAY_SUB[t], False
    if a == "hospital":
        return "medical", "Hospital", tags.get("emergency") == "yes"
    if a in ("clinic", "doctors"):
        return "medical", "Clinic", False
    if a == "pharmacy":
        return "medical", "Pharmacy", False
    if rw in ("station", "halt"):
        return "transit", ("Metro station" if tags.get("station") == "subway" else "Train station"), False
    if rw == "tram_stop":
        return "transit", "Tram stop", False
    if rw == "subway_entrance":
        return "transit", "Metro entrance", False
    if hw == "bus_stop":
        return "transit", "Bus stop", False
    if a == "bus_station":
        return "transit", "Bus station", False
    return None


def overpass_query(lat: float, lng: float, radius: int, kinds: list) -> list:
    parts = []
    for k in kinds:
        for f in KIND_FILTERS.get(k, []):
            parts.append(f"nwr(around:{radius},{lat},{lng}){f};")
    q = "[out:json][timeout:20];(" + "".join(parts) + ");out center tags 250;"
    last = None
    for url in OVERPASS:
        try:
            r = httpx.post(url, data={"data": q}, headers=WIKI_HEADERS, timeout=25)
            if r.status_code == 200:
                return r.json().get("elements", [])
            last = f"{url} -> {r.status_code}"
        except Exception as e:
            last = f"{url} -> {type(e).__name__}"
    raise HTTPException(502, f"Map data unavailable ({last})")


def collect(elements: list, lat: float, lng: float, kinds: list) -> list:
    seen, out = set(), []
    for el in elements:
        tags = el.get("tags") or {}
        name = tags.get("name") or tags.get("name:en")
        c = classify(tags)
        if not name or not c or c[0] not in kinds:
            continue
        la = el.get("lat") if "lat" in el else (el.get("center") or {}).get("lat")
        lo = el.get("lon") if "lon" in el else (el.get("center") or {}).get("lon")
        if la is None or lo is None or (name, c[0]) in seen:
            continue
        seen.add((name, c[0]))
        out.append({"kind": c[0], "sub": c[1], "name": name, "lat": la, "lng": lo,
                    "dist_m": haversine_m(lat, lng, la, lo), "er": c[2]})
    out.sort(key=lambda p: p["dist_m"])
    counts: dict = {}
    limited = []
    for p in out:
        counts[p["kind"]] = counts.get(p["kind"], 0) + 1
        if counts[p["kind"]] <= KIND_LIMIT[p["kind"]]:
            limited.append(p)
    return limited


@app.post("/api/nearby")
def nearby(req: NearbyReq):
    kinds = [k for k in req.kinds if k in KIND_FILTERS]
    if not kinds:
        raise HTTPException(400, "kinds must be stay, medical or transit")
    key = (round(req.lat, 3), round(req.lng, 3), req.radius_m, tuple(sorted(kinds)))
    if key in _nearby_cache:
        return _nearby_cache[key]
    places = collect(overpass_query(req.lat, req.lng, req.radius_m, kinds), req.lat, req.lng, kinds)
    wide = req.radius_m * 3
    # a thin result (small town, or a stop with no stop nearby): look a little wider once
    if wide <= 5000 and any(sum(1 for p in places if p["kind"] == k) < 4 for k in kinds):
        places = collect(overpass_query(req.lat, req.lng, wide, kinds), req.lat, req.lng, kinds)
    result = {"places": places}
    _nearby_cache[key] = result
    return result


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