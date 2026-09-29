"""Voyara backend (FastAPI).

Endpoints
  GET  /health
  POST /api/itinerary   -> Groq LLM drafts the plan, rule layer validates it
  GET  /api/weather     -> OpenWeatherMap + "swap to indoor?" rule
"""
import json
import os
from datetime import date

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
load_dotenv()

MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
app = FastAPI(title="Voyara API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # add your Vercel URL later
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- request / response shapes ----------
class TripRequest(BaseModel):
    destination: str = "Kyoto, Japan"
    start_date: date
    end_date: date
    budget_inr: int = Field(75000, ge=5000)
    interests: list[str] = ["Culture", "Food"]
    accessibility: bool = False


# ---------- 1. itinerary: LLM draft + rule validation ----------
SYSTEM_PROMPT = """You are Voyara's trip planner. Return ONLY valid JSON, no prose, no code fences.
Schema:
{"days":[{"stops":[{"time":"HH:MM","name":str,"category":"Sight|Food|Culture|Nature|Walk|Shopping|Evening|Indoor|Explore",
"description":str (one line),"badge":str (2-4 words, e.g. 'Rain-safe alternative available'),
"insights":[str,str,str] (short, review-style, e.g. 'Quiet in mornings'),
"travel":str (e.g. '12 min by taxi'),"indoor":bool,"step_free":bool}]}]}
Rules: 4 stops per day, times ascending between 08:00 and 21:00, realistic travel times,
real places only, total spend within the budget."""


def build_prompt(req: TripRequest, n_days: int) -> str:
    return (
        f"Plan {n_days} days in {req.destination}. Budget: INR {req.budget_inr}. "
        f"Interests: {', '.join(req.interests)}. "
        f"Accessibility needs: {'YES - prefer step-free venues, avoid steep climbs' if req.accessibility else 'no'}."
    )


def validate_itinerary(raw: dict, req: TripRequest, n_days: int) -> dict:
    """Rule layer: never trust the LLM blindly."""
    days = raw.get("days", [])[:n_days]
    if len(days) < n_days:
        raise ValueError(f"Expected {n_days} days, got {len(days)}")
    required = {"time", "name", "category", "description"}
    for d in days:
        stops = [s for s in d.get("stops", []) if required <= s.keys()]
        stops.sort(key=lambda s: s["time"])
        if not stops:
            raise ValueError("A day came back with no valid stops")
        d["stops"] = stops
    return {"days": days}


@app.post("/api/itinerary")
def generate_itinerary(req: TripRequest):
    n_days = (req.end_date - req.start_date).days + 1
    if not 1 <= n_days <= 7:
        raise HTTPException(400, "Trip must be 1-7 days")
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(503, "GROQ_API_KEY not set")
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    last_error = "unknown"
    for attempt in range(2):  # small models slip sometimes: retry once
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_prompt(req, n_days)},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
            max_tokens=4000,
        )
        text = resp.choices[0].message.content or ""
        try:
            raw = json.loads(text[text.index("{"): text.rindex("}") + 1])
            return validate_itinerary(raw, req, n_days)
        except (ValueError, json.JSONDecodeError) as e:
            last_error = str(e)
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


@app.get("/health")
def health():
    return {"ok": True}
