const API = process.env.NEXT_PUBLIC_API_URL;

export async function generateItinerary(body: any) {
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