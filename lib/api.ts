const API = process.env.NEXT_PUBLIC_API_URL;

export type ItineraryRequest = {
  destination: string;
  start_date: string;
  end_date: string;
  days?: number;
  interests: string[];
  budget: number;
  accessibility: boolean;
  day_offset?: number; // which day of the full trip this chunk starts at
  total_days?: number; // length of the full trip
  day_context?: { base: string; start: string; max_stops: number }[]; // where we sleep each day
};

export async function generateItinerary(body: ItineraryRequest) {
  const res = await fetch(`${API}/api/itinerary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), // fields must match your FastAPI request model
  });
  if (!res.ok) throw new Error("Itinerary failed");
  return res.json();
}

export async function getWeather(city: string) {
  const res = await fetch(`${API}/api/weather?city=${encodeURIComponent(city)}`);
  if (!res.ok) throw new Error("Weather failed");
  return res.json(); // has swap_to_indoor
}

// Returns one URL (or null) per place, in the same order as the input.
export async function getPlaceImages(
  places: { name: string; city: string }[]
): Promise<(string | null)[]> {
  if (places.length === 0) return [];
  try {
    const res = await fetch(`${API}/api/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(places),
    });
    if (!res.ok) return places.map(() => null);
    const data = await res.json();
    return data.images ?? places.map(() => null);
  } catch {
    return places.map(() => null); // images are optional, never break the trip
  }
}

export async function askGuide(body: {
  message: string
  language: string
  city: string
  history: { role: string; content: string }[]
}): Promise<string> {
  const res = await fetch(`${API}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Chat failed");
  const data = await res.json();
  return data.reply;
}

export type DayWeather = {
  rain: boolean;
  rain_prob: number; // 0 to 1
  temp_c: number;
  condition: string;
};

// Forecast per date (YYYY-MM-DD) for roughly the next 5 days. Null if unavailable.
export async function getForecast(city: string): Promise<Record<string, DayWeather> | null> {
  try {
    const res = await fetch(`${API}/api/forecast?city=${encodeURIComponent(city)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.days ?? null;
  } catch {
    return null; // weather is optional, never break the trip
  }
}

export type RerouteRequest = {
  destination: string;
  interests: string[];
  accessibility: boolean;
  budget: number; // this day's share
  reason: string; // "rain"
  avoid: string[]; // places used on other days
  day: any; // one day in the itinerary API shape
};

export async function rerouteDay(body: RerouteRequest): Promise<{ day: any }> {
  const res = await fetch(`${API}/api/reroute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Reroute failed");
  return res.json();
}

// ---------- realistic plan: where we sleep, how we move ----------
export type PlanTransfer = {
  mode: string;
  hours: number; // door to door
  depart: string; // HH:MM
  arrive: string; // HH:MM
  cost_inr: number;
  note: string;
  travel_days: number; // 1 = arrives the next calendar day
};

export type PlanDay = {
  leg: number;
  base: string; // town where we sleep and wake up
  kind: string; // normal | travel | arrival
  start: string; // earliest first stop, HH:MM ("" on a pure travel day)
  max_stops: number;
  transfer: PlanTransfer | null; // set on the first day of each leg
  stay_type: string;
  stay_cost_inr: number; // per night
};

export async function getPlan(body: {
  origin: string;
  destination: string;
  n_days: number;
  budget_inr: number;
  interests: string[];
  accessibility: boolean;
  travel_km?: number;
  travel_mode?: string;
}): Promise<{ days: PlanDay[] } | null> {
  try {
    const res = await fetch(`${API}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // the page falls back to a single base
  }
}

// ---------- stays, medical and transit near a point (OpenStreetMap) ----------
export type NearbyPlace = {
  kind: "stay" | "medical" | "transit";
  sub: string; // Hostel / dorm, Hotel, Hospital, Pharmacy, Bus stop...
  name: string;
  lat: number;
  lng: number;
  dist_m: number; // can be tens of km in remote places: the backend widens the search
  er?: boolean; // hospital with an emergency department
};

export async function getNearby(body: {
  lat: number;
  lng: number;
  radius_m: number;
  kinds: ("stay" | "medical" | "transit")[];
}): Promise<NearbyPlace[]> {
  // one retry: the free Render server may be waking up, or the map data server may hiccup
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API}/api/nearby`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        return data.places ?? [];
      }
    } catch {
      // fall through and retry
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
  }
  return []; // map extras are optional, never break the trip
}
