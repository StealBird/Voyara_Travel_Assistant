'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import dynamic from 'next/dynamic'
import type { LucideIcon } from 'lucide-react'
import {
  Accessibility,
  ArrowRight,
  BedDouble,
  Check,
  Clock3,
  CloudRain,
  Compass,
  ExternalLink,
  Footprints,
  Globe2,
  Landmark,
  MapPin,
  MessageCircle,
  Moon,
  Mountain,
  Plane,
  Plus,
  Sparkles,
  TrainFront,
  Utensils,
  Wallet,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MapPoint, Journey } from '@/components/trip-map'
import { generateItinerary, getForecast, rerouteDay, getPlan, getNearby, getPlaceImages, askGuide } from '@/lib/api'
import type { DayWeather, NearbyPlace, PlanDay, PlanTransfer } from '@/lib/api'

const TripMap = dynamic(() => import('@/components/trip-map'), {
  ssr: false,
  loading: () => <div className="map-skeleton" />,
})

type Transport = { nearest: string; mode: string; distance: string; tip: string }
type Stop = { kind?: 'place' | 'transfer' | 'rest'; time: string; name: string; category: string; icon: LucideIcon; image: string; description: string; why: string; cost: number; transport: Transport | null; badge: string; insights: string[]; travel: string; lat?: number; lng?: number }
type Day = { id: number; label: string; date: string; iso: string; base: string; from: string; legIdx: number; transfer: PlanTransfer | null; stayType: string; stayCost: number; theme: string; area: string; overnight: string; bridge: string; stops: Stop[] }
type TravelInfo = { km: number; intl: boolean; mode: string; mid: number; lo: number; hi: number }
type Trip = { destination: string; origin: string; travel: TravelInfo | null; startDate: string; endDate: string; budget: number; interests: string[] }
type PageId = 'plan' | 'explore' | 'trip' | 'profile'
type LL = { lat: number; lng: number }
type Status = 'want' | 'visited' | 'skip'
type Nearby = { center: LL; places: NearbyPlace[] }

const ICONS = [Compass, Utensils, Mountain, Moon]
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  food: Utensils,
  nature: Mountain,
  culture: Landmark,
  walk: Footprints,
  nightlife: Moon,
  adventure: Mountain,
  sight: Compass,
}
const iconFor = (category: string, j: number): LucideIcon => CATEGORY_ICONS[category.toLowerCase()] ?? ICONS[j % ICONS.length]

const NAV: [PageId, string][] = [['plan', 'Plan'], ['explore', 'Explore'], ['trip', 'My Trips'], ['profile', 'Profile']]
// label shown on the tile, Wikipedia article whose lead photo we use
const WORLD = [
  { label: 'Santorini', title: 'Santorini' },
  { label: 'Kyoto', title: 'Fushimi Inari-taisha' },
  { label: 'Bali', title: 'Pura Ulun Danu Bratan' },
  { label: 'Paris', title: 'Eiffel Tower' },
  { label: 'Maldives', title: 'Maldives' },
  { label: 'Ladakh', title: 'Pangong Tso' },
  { label: 'Cappadocia', title: 'Göreme National Park' },
  { label: 'Amalfi Coast', title: 'Positano' },
  { label: 'Machu Picchu', title: 'Machu Picchu' },
  { label: 'Iceland', title: 'Skógafoss' },
  { label: 'Swiss Alps', title: 'Matterhorn' },
  { label: 'Dubai', title: 'Burj Khalifa' },
]
const MAX_DAYS = 30
const CHUNK = 5
const BAD_IMG = /(^|[^a-z])(map|maps|flag|logo|seal|locator|location|diagram|icon|emblem|symbol|blank|outline|banner|chart|coat[_ ]of[_ ]arms)([^a-z]|$)|\.svg/i

const titleCase = (s: string) => s.trim().replace(/\b\w/g, (c) => c.toUpperCase())
const num = (v: any): number | undefined => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v))
const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')
const costLabel = (n: number) => (n > 0 ? inr(n) : 'Free')
const fmtKm = (d: number) => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`)
const mapsLink = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
const latLngLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
const fmtHours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`)
// walk / taxi estimate from the straight-line distance between two real places (x1.3 for streets)
const travelText = (straightKm: number) => {
  const road = straightKm * 1.3
  if (road < 0.15) return 'about the same spot'
  const walk = Math.max(1, Math.round((road / 4.5) * 60))
  const drive = Math.max(3, Math.round((road / (road > 8 ? 45 : 25)) * 60))
  if (road <= 1.5) return `about ${fmtKm(road)}, ${walk} min walk`
  if (road <= 3.5) return `about ${fmtKm(road)}, ${walk} min walk or ${drive} min by taxi`
  return `about ${fmtKm(road)}, ${drive} min by taxi or local transit`
}
const isPlace = (s: Stop) => (s.kind ?? 'place') === 'place'
const skey = (iso: string, name: string) => `${iso}|${name}`
const firstPlace = (d?: Day) => (d?.transfer ? d.stops.find((s) => s.kind === 'transfer')?.name : undefined) ?? d?.stops.find(isPlace)?.name ?? d?.stops[0]?.name ?? ''
const lastPlace = (d?: Day) => [...(d?.stops ?? [])].reverse().find(isPlace)
const daySpend = (d?: Day, st: Record<string, Status> = {}) => (d ? d.stops.reduce((n, s) => n + (st[skey(d.iso, s.name)] === 'skip' ? 0 : s.cost), 0) : 0)

// fetch JSON with a timeout so one slow service can never freeze the app
async function fetchJson(url: string, ms = 6000): Promise<any | null> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s) } catch { return s }
}

// real, wide photos only: no flags, maps, logos or tall portraits
const goodThumb = (t: any) =>
  !!t?.source && !BAD_IMG.test(safeDecode(t.source)) && (!t.width || !t.height || (t.width >= 640 && t.width >= t.height * 1.05))

// One batched Wikipedia call per 50 titles. Returns { originalTitle: imageUrl }.
async function wikiImages(titles: string[], width: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const uniq = [...new Set(titles.map((t) => t.trim()).filter(Boolean))]
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50)
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=${width}&titles=${encodeURIComponent(batch.join('|'))}`
    const q = (await fetchJson(url))?.query
    if (!q) continue
    const byTitle: Record<string, string> = {}
    ;(Object.values(q.pages ?? {}) as any[]).forEach((p) => { if (goodThumb(p.thumbnail)) byTitle[p.title] = p.thumbnail.source })
    batch.forEach((t) => {
      const n = (q.normalized ?? []).find((x: any) => x.from === t)?.to ?? t
      const r = (q.redirects ?? []).find((x: any) => x.from === n)?.to ?? n
      if (byTitle[r]) out[t] = byTitle[r]
    })
  }
  return out
}

// several real photos related to a destination (lead images of related Wikipedia articles)
async function destinationPhotos(dest: string): Promise<string[]> {
  const run = async (q: string) => {
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=0&gsrlimit=14&prop=pageimages&piprop=thumbnail&pithumbsize=1600`
    const pages = Object.values((await fetchJson(url))?.query?.pages ?? {}) as any[]
    return pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).filter((p) => goodThumb(p.thumbnail)).map((p) => p.thumbnail.source as string)
  }
  const [a, b] = await Promise.all([run(`${dest} tourism`), run(`${dest} landmark`)])
  return [...new Set([...a, ...b])].slice(0, 10)
}

// ---------- geocoding (free, no key, with timeouts) ----------
function km(a: LL, b: LL) {
  const R = 6371
  const r = Math.PI / 180
  const dLat = (b.lat - a.lat) * r
  const dLng = (b.lng - a.lng) * r
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

async function photon(q: string, bias?: LL): Promise<LL | null> {
  const j = await fetchJson(`https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(q)}${bias ? `&lat=${bias.lat}&lon=${bias.lng}` : ''}`)
  const c = j?.features?.[0]?.geometry?.coordinates
  return c ? { lat: Number(c[1]), lng: Number(c[0]) } : null
}

async function nominatim(q: string): Promise<LL | null> {
  const j = await fetchJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, 8000)
  return j?.[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null
}

// a city/place plus its country code (to tell domestic from international)
async function locate(q: string): Promise<(LL & { cc?: string }) | null> {
  const j = await fetchJson(`https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(q)}`)
  const f = j?.features?.[0]
  if (f?.geometry?.coordinates) {
    return { lat: Number(f.geometry.coordinates[1]), lng: Number(f.geometry.coordinates[0]), cc: f.properties?.countrycode }
  }
  const n = await fetchJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`, 8000)
  if (n?.[0]) return { lat: Number(n[0].lat), lng: Number(n[0].lon), cc: n[0].address?.country_code?.toUpperCase() }
  return null
}

async function geocodeStop(name: string, city: string, bias?: LL): Promise<LL | null> {
  const clean = name.replace(/\(.*?\)/g, '').trim()
  for (const q of [`${name}, ${city}`, `${clean} ${city}`, clean]) {
    const hit = await photon(q, bias)
    if (hit && (!bias || km(hit, bias) < 3500)) return hit
  }
  const n = await nominatim(`${clean}, ${city}`)
  await new Promise((r) => setTimeout(r, 1100)) // be polite to the free service
  if (n && (!bias || km(n, bias) < 3500)) return n
  return null
}

// ---------- rough travel cost + budget check (estimate, not live prices) ----------
function estimateTravel(distKm: number, intl: boolean): Omit<TravelInfo, 'km' | 'intl'> {
  let mode = 'Bus / train'
  let mid = distKm * 3.2
  if (intl) { mode = 'Flight'; mid = 9000 + 6.5 * distKm }
  else if (distKm >= 350) { mode = 'Train or flight'; mid = 3000 + 4 * distKm }
  const r = (n: number) => Math.round(n / 500) * 500
  return { mode, mid: r(mid), lo: r(mid * 0.75), hi: r(mid * 1.35) }
}

function verdict(budget: number, days: number, t: TravelInfo) {
  const lean = t.intl ? 5000 : 2500
  const comfy = t.intl ? 9000 : 4500
  const left = budget - t.mid
  const perDay = days > 0 ? Math.floor(left / days) : 0
  const level: 'good' | 'tight' | 'low' = perDay >= comfy ? 'good' : perDay >= lean ? 'tight' : 'low'
  return { left, perDay, level, need: t.mid + lean * Math.max(days, 1) }
}

function SafeImg({ src, alt, className, fill }: { src?: string; alt: string; className?: string; fill?: boolean }) {
  const [bad, setBad] = useState(false)
  useEffect(() => setBad(false), [src])
  if (bad || !src) return <div className={className} style={fill ? { position: 'absolute', inset: 0, background: '#E7E4DE' } : { background: '#E7E4DE' }} />
  return <img src={src} alt={alt} className={className} onError={() => setBad(true)} />
}

function addDays(date: string, n: number) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function countDays(start: string, end: string) {
  if (!start || !end) return 0
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1
}
function fmt(date: string, add = 0) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + add)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function toDays(plan: any, startDate: string): Day[] {
  return (plan?.days ?? []).map((d: any, i: number) => ({
    id: i + 1,
    label: `Day ${i + 1}`,
    date: fmt(startDate, i),
    iso: addDays(startDate, i),
    base: '',
    from: '',
    legIdx: 0,
    transfer: null,
    stayType: '',
    stayCost: 0,
    theme: d.theme ?? '',
    area: d.area ?? '',
    overnight: d.overnight ?? '',
    bridge: d.bridge ?? '',
    stops: (d.stops ?? d.activities ?? []).map((s: any, j: number) => {
      const category = s.category ?? 'Sight'
      const t = s.transport
      return {
        kind: 'place' as const,
        time: s.time ?? '',
        name: s.name ?? s.title ?? 'Stop',
        category,
        icon: iconFor(category, j),
        image: '',
        description: s.description ?? '',
        why: s.why ?? '',
        cost: Math.max(0, Math.round(Number(s.cost_inr ?? s.cost ?? 0)) || 0),
        transport: t && t.nearest ? { nearest: String(t.nearest), mode: String(t.mode ?? 'Transit'), distance: String(t.distance ?? ''), tip: String(t.tip ?? '') } : null,
        badge: s.badge ?? '',
        insights: s.insights ?? ['Popular with travelers', 'Check opening hours', 'Matches your interests'],
        travel: s.travel ?? '',
        lat: num(s.lat ?? s.latitude),
        lng: num(s.lng ?? s.lon ?? s.longitude),
      }
    }),
  }))
}

function Logo() {
  return <div className="flex items-center gap-2.5"><div className="flex size-8 items-center justify-center rounded-xl bg-brand text-white"><Compass className="size-4" strokeWidth={2.2} /></div><span className="font-semibold tracking-[-0.03em] text-white">Voyara</span></div>
}

// full-screen vivid photo background that crossfades whenever `src` changes
function Backdrop({ src, mode }: { src: string; mode: 'hero' | 'trip' }) {
  const [layers, setLayers] = useState<{ id: number; src: string }[]>([])
  const idRef = useRef(0)
  useEffect(() => {
    if (!src) return
    let dead = false
    const img = new Image()
    img.onload = () => {
      if (dead) return
      setLayers((prev) => (prev.length && prev[prev.length - 1].src === src ? prev : [...prev.slice(-1), { id: ++idRef.current, src }]))
    }
    img.src = src
    return () => { dead = true }
  }, [src])
  return <div className={`backdrop ${mode === 'trip' ? 'backdrop-trip' : ''}`} aria-hidden="true">{layers.map((l) => <div key={l.id} className="backdrop-slide" style={{ backgroundImage: `url("${l.src}")` }} />)}<div className="backdrop-wash" /></div>
}

function Discover({ items, active, onPick }: { items: { label: string; image: string }[]; active: number; onPick: (label: string) => void }) {
  if (!items.length) return null
  return <section className="discover">
    <p className="eyebrow-light">Dream destinations</p>
    <div className="discover-row">{items.map((it, i) => <button key={it.label} type="button" onClick={() => onPick(it.label)} className={`discover-tile ${i === active ? 'discover-tile-active' : ''}`}><img src={it.image} alt={it.label} loading="lazy" /><span>{it.label}</span></button>)}</div>
  </section>
}

function TravelCheck({ origin, destination, days, budget, travel, busy }: { origin: string; destination: string; days: number; budget: number; travel: TravelInfo | null; busy: boolean }) {
  if (!travel) return busy ? <p className="text-xs text-muted-foreground md:col-span-2">Checking travel from {origin}…</p> : null
  const v = verdict(budget, days, travel)
  const title = v.level === 'good' ? 'Looks comfortable' : v.level === 'tight' ? 'Doable, but tight' : 'Probably not enough'
  let detail = ''
  if (days < 1) detail = 'Pick your dates to see what is left per day.'
  else if (v.level === 'good') detail = `After about ${inr(travel.mid)} for getting there, you would have roughly ${inr(v.perDay)} per day for stay, food and activities.`
  else if (v.level === 'tight') detail = `After about ${inr(travel.mid)} for travel, that leaves roughly ${inr(v.perDay)} per day. Budget stays and free sights will keep it comfortable.`
  else if (v.left <= 0) detail = `Getting there alone could use your whole budget. For ${days} days, around ${inr(v.need)} would feel realistic, or try a closer place.`
  else detail = `That leaves only about ${inr(v.perDay)} per day. For ${days} days, around ${inr(v.need)} would feel realistic, or try fewer days or a closer place.`
  return <div className={`travel-check travel-check-${v.level} md:col-span-2`}>
    <div className="flex items-center gap-2 text-sm font-semibold text-foreground"><Plane className="size-4" />{origin} → {destination}</div>
    <p className="mt-1 text-xs text-muted-foreground">About {travel.km.toLocaleString('en-IN')} km · {travel.intl ? 'International' : 'Domestic'} · {travel.mode} · round trip roughly {inr(travel.lo)}–{inr(travel.hi)}</p>
    <p className="mt-2 text-sm text-foreground"><strong>{title}.</strong> {detail}</p>
    <p className="mt-2 text-xs text-muted-foreground">Rough estimate for 1 traveller. Real prices vary by season and how early you book.</p>
  </div>
}

type PanelProps = {
  accessibility: boolean; setAccessibility: (v: boolean) => void
  generating: boolean; canGenerate: boolean; onGenerate: () => void
  budget: number; setBudget: (v: number) => void
  interests: string[]; setInterests: (v: string[]) => void
  origin: string; setOrigin: (v: string) => void
  destination: string; setDestination: (v: string) => void
  startDate: string; setStartDate: (v: string) => void
  endDate: string; setEndDate: (v: string) => void
  tripLength: number
  travel: TravelInfo | null; travelBusy: boolean
}

function PlanningPanel(p: PanelProps) {
  const choices = ['Culture', 'Food', 'Nature', 'Nightlife', 'Adventure']
  const today = new Date().toISOString().slice(0, 10)
  const tooLong = p.tripLength > MAX_DAYS
  const badRange = p.startDate !== '' && p.endDate !== '' && p.tripLength < 1
  return <section className="mx-auto flex w-full max-w-3xl flex-col gap-7 rounded-[16px] border border-border bg-card p-6 sm:p-8">
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <label className="field-label">Travelling from<span className="field-value mt-2"><Plane className="size-4 shrink-0 text-brand" /><input value={p.origin} onChange={(e) => p.setOrigin(e.target.value)} placeholder="Your city" className="w-full bg-transparent outline-none" /></span></label>
      </div>
      <div>
        <label className="field-label">Destination<span className="field-value mt-2"><MapPin className="size-4 shrink-0 text-brand" /><input value={p.destination} onChange={(e) => p.setDestination(e.target.value)} placeholder="Where to?" className="w-full bg-transparent outline-none" /></span></label>
      </div>
      <div>
        <label className="field-label">Dates<span className="field-value mt-2"><Clock3 className="size-4 shrink-0 text-brand" /><input type="date" min={today} value={p.startDate} onChange={(e) => { p.setStartDate(e.target.value); if (p.endDate && e.target.value > p.endDate) p.setEndDate(e.target.value) }} className="min-w-0 bg-transparent text-sm outline-none" /><span>–</span><input type="date" min={p.startDate || today} value={p.endDate} onChange={(e) => p.setEndDate(e.target.value)} className="min-w-0 bg-transparent text-sm outline-none" /></span></label>
        <p className={`mt-2 text-xs ${tooLong || badRange ? 'text-destructive' : 'text-muted-foreground'}`}>{tooLong ? `Maximum ${MAX_DAYS} days` : badRange ? 'End date must be after start date' : p.tripLength > 0 ? `${p.tripLength} day${p.tripLength > 1 ? 's' : ''}` : `Up to ${MAX_DAYS} days`}</p>
      </div>
      <div>
        <label className="field-label">Budget (₹)<span className="field-value mt-2"><span className="text-brand">₹</span><input type="number" min={1000} step={1000} value={p.budget || ''} onChange={(e) => p.setBudget(Number(e.target.value))} placeholder="Enter your budget" className="w-full bg-transparent outline-none" /></span></label>
        <input aria-label="Trip budget" type="range" min={10000} max={500000} step={5000} value={Math.min(Math.max(p.budget, 10000), 500000)} onChange={(e) => p.setBudget(Number(e.target.value))} style={{ accentColor: 'var(--brand)', width: '100%', height: 8, marginTop: 16, cursor: 'pointer' }} />
        <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>₹10k</span><span>Slide or type any amount</span><span>₹5L+</span></div>
      </div>
      <div className="md:col-span-2"><p className="field-label">Interests</p><div className="mt-3 flex flex-wrap gap-2">{choices.map((choice) => { const selected = p.interests.includes(choice); return <button key={choice} type="button" onClick={() => p.setInterests(selected ? p.interests.filter((i) => i !== choice) : [...p.interests, choice])} className={`interest-chip ${selected ? 'interest-chip-active' : ''}`}>{selected && <Check className="size-3" />}{choice}</button> })}</div></div>
      <TravelCheck origin={p.origin.trim()} destination={p.destination.trim()} days={Math.max(p.tripLength, 0)} budget={p.budget} travel={p.travel} busy={p.travelBusy} />
    </div>
    <div className={`accessibility-control ${p.accessibility ? 'accessibility-on' : ''}`}><div className="flex items-start gap-3"><div className="icon-well"><Accessibility className="size-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">Accessibility needs</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Wheelchair access, medical proximity, low-mobility routing.</p>{p.accessibility && <p className="mt-2 text-xs font-medium text-success">Your route will prioritize step-free options.</p>}</div><button type="button" aria-label="Toggle accessibility needs" aria-pressed={p.accessibility} onClick={() => p.setAccessibility(!p.accessibility)} className={`toggle ${p.accessibility ? 'toggle-on' : ''}`}><span /></button></div></div>
    <div>
      <Button onClick={p.onGenerate} disabled={p.generating || !p.canGenerate} className="h-12 w-full">{p.generating ? <><span className="loading-dot" />Building your itinerary…</> : <>Generate Itinerary <ArrowRight data-icon="inline-end" /></>}</Button>
      <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">{p.canGenerate ? 'Your preferences are used to build a thoughtful first draft.' : 'Pick where you are travelling from, a destination, dates and budget to get started.'}</p>
    </div>
  </section>
}

function Connector({ flip }: { flip: boolean }) {
  return <svg className="journey-link" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true"><path d={flip ? 'M 86 0 C 86 34, 14 26, 14 60' : 'M 14 0 C 14 34, 86 26, 86 60'} /></svg>
}

function Timeline({ stops, selected, setSelected, accessible, dest, iso, status, setStatus, transit, gapKm }: { stops: Stop[]; selected: string; setSelected: (name: string) => void; accessible?: boolean; dest: string; iso: string; status: Record<string, Status>; setStatus: (key: string, v: Status) => void; transit: (stop: Stop) => NearbyPlace[] | undefined; gapKm: (a?: Stop, b?: Stop) => number | null }) {
  const visibleStops = accessible ? [...stops].sort((a, b) => (a.name.includes('Station') ? -1 : b.name.includes('Station') ? 1 : 0)) : stops
  // running total of the day (skipped places are not counted), in the plan's own order
  const cum = stops.reduce<number[]>((acc, s, i) => [...acc, (acc[i - 1] ?? 0) + (status[skey(iso, s.name)] === 'skip' ? 0 : s.cost)], [])
  const STATUS: [Status, string][] = [['want', 'Want to go'], ['visited', 'Visited'], ['skip', 'Skip']]
  return <div className="journey">{visibleStops.map((stop, index) => {
    const Icon = stop.icon
    const place = isPlace(stop)
    const isSelected = selected === stop.name
    const at = stops.indexOf(stop)
    const n = place ? stops.slice(0, at + 1).filter(isPlace).length : 0
    const key = skey(iso, stop.name)
    const st: Status = status[key] ?? 'want'
    const why = stop.why || (place ? stop.insights[0] : '') || ''
    const near = isSelected && place ? transit(stop) : undefined
    const prevP = place ? stops.slice(0, at).reverse().find(isPlace) : undefined
    const hop = prevP ? gapKm(prevP, stop) : null
    return <div key={stop.name + index}>
      {index > 0 && <Connector flip={index % 2 === 0} />}
      <article
        role="button"
        tabIndex={0}
        onClick={() => setSelected(stop.name)}
        onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(stop.name) } }}
        className={`stop-card ${isSelected ? 'stop-card-selected' : ''} ${st === 'skip' ? 'opacity-60' : ''}`}
      >
        <div className="stop-media">
          <SafeImg src={stop.image} alt={stop.name} className="stop-img" />
          {n > 0 && <span className="stop-num">{n}</span>}
          {stop.time && <span className="stop-time"><Clock3 className="size-3.5" />{stop.time}</span>}
        </div>
        <div className="stop-body">
          <span className="category-label inline-flex items-center gap-1.5"><Icon className="size-3.5" />{stop.category}{st === 'visited' && <span className="ml-2 inline-flex items-center gap-1 text-success"><Check className="size-3.5" />Visited</span>}</span>
          <h3 className={`mt-1 font-serif text-2xl font-normal leading-tight text-foreground ${st === 'skip' ? 'line-through' : ''}`}>{stop.name}</h3>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{stop.description}</p>

          {why && <p className="mt-3 flex gap-2 rounded-xl bg-brand-soft px-3 py-2 text-sm leading-5 text-foreground"><Sparkles className="mt-0.5 size-4 shrink-0 text-brand" /><span><strong className="font-semibold">Why this place: </strong>{why}</span></p>}

          {(place || stop.cost > 0) && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-1 font-medium text-foreground"><Wallet className="size-3.5" />{costLabel(stop.cost)}</span>
            <span className="text-muted-foreground">Day so far {inr(cum[at] ?? 0)}</span>
          </div>}

          {place && prevP && hop !== null && <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><ArrowRight className="size-3.5 shrink-0" />From {prevP.name}: {travelText(hop)}</div>}

          {place && (near && near.length > 0
            ? <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
              <TrainFront className="mt-0.5 size-3.5 shrink-0" />
              <span>Real stops nearby: {near.slice(0, 3).map((p) => `${p.name} (${p.sub}, ${p.dist_m} m)`).join(' · ')}{' '}
                <a href={latLngLink(near[0].lat, near[0].lng)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">Open in Maps<ExternalLink className="size-3" /></a>
              </span>
            </div>
            : stop.transport && <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
              <TrainFront className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Nearest transport: <span className="font-medium text-foreground">{stop.transport.nearest}</span> · {stop.transport.mode}{stop.transport.distance ? ` · ${stop.transport.distance}` : ''}{stop.transport.tip ? `. ${stop.transport.tip}` : ''}{' '}
                <a href={mapsLink(`${stop.transport.nearest} ${dest}`)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">Open in Maps<ExternalLink className="size-3" /></a>
              </span>
            </div>)}

          {place && <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={`Plan status for ${stop.name}`}>
            {STATUS.map(([v, label]) => <button key={v} type="button" aria-pressed={st === v} onClick={(e) => { e.stopPropagation(); setStatus(key, v) }} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${st === v ? (v === 'visited' ? 'border-success text-success' : v === 'skip' ? 'border-destructive text-destructive' : 'border-brand bg-brand-soft text-foreground') : 'border-border text-muted-foreground'}`}>{st === v && v === 'visited' ? '✓ ' : ''}{label}</button>)}
          </div>}
        </div>
      </article>
    </div>
  })}</div>
}

// note at the top of a day: how the morning goes
function DayFrom({ prev, cur, first, dist }: { prev: Day; cur: Day; first?: Stop; dist: number | null }) {
  const t = cur.transfer
  let body: ReactNode
  if (t && prev.base !== cur.base) {
    body = <>Wake up in <strong>{prev.base}</strong>, pack your bag and check out. Then travel to <strong>{cur.base}</strong> by {t.mode.toLowerCase()} (about {fmtHours(t.hours)}), leaving around {t.depart} and arriving about {t.arrive}{t.travel_days ? ' the next day' : ''}.</>
  } else if (prev.transfer && prev.transfer.travel_days >= 1 && prev.base === cur.base) {
    body = <>You arrived in <strong>{cur.base}</strong> around {prev.transfer.arrive}. Check in and settle first{first ? <>, then start with <strong>{first.name}</strong></> : ''}.</>
  } else {
    body = <>Wake up at your stay in <strong>{cur.base}</strong>{first ? <>. First stop is <strong>{first.name}</strong>{dist !== null ? `, ${fmtKm(dist)} from where yesterday ended` : ''}.</> : '.'}</>
  }
  return <div className="mb-6 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground">{body}</div>
}

// card at the bottom of a day: tonight and tomorrow, with a button to jump
function DayNext({ cur, next, dist, stay, onGo }: { cur: Day; next: Day; dist: number | null; stay?: NearbyPlace; onGo: () => void }) {
  const t = next.transfer
  const nt = cur.transfer
  const firstNext = next.stops.find(isPlace)
  const onTheWay = !!nt && nt.travel_days >= 1 && cur.stops.every((s) => !isPlace(s))
  return <div className="rounded-2xl border border-border bg-card p-4">
    <p className="eyebrow">Tonight and tomorrow</p>
    <div className="mt-3 flex flex-col gap-2 text-sm text-foreground">
      <p className="flex items-start gap-2"><BedDouble className="mt-0.5 size-4 shrink-0 text-brand" /><span>{onTheWay ? <>Tonight you are still on the way to <strong>{next.base}</strong>.</> : <>Tonight you sleep in <strong>{cur.base}</strong>{stay ? <> at <strong>{stay.name}</strong></> : ''}.</>}</span></p>
      {t && next.base !== cur.base
        ? <p className="flex items-start gap-2"><Plane className="mt-0.5 size-4 shrink-0 text-brand" /><span>Tomorrow: wake up, pack and check out, then travel to <strong>{next.base}</strong> by {t.mode.toLowerCase()} (about {fmtHours(t.hours)}). You should arrive around {t.arrive}{t.travel_days ? ' the next day' : ''}.</span></p>
        : <p className="flex items-start gap-2"><ArrowRight className="mt-0.5 size-4 shrink-0 text-brand" /><span>{next.label} {onTheWay ? <>you arrive in <strong>{next.base}</strong> around {nt?.arrive}.</> : <>starts in <strong>{next.base}</strong>{firstNext ? <> with <strong>{firstNext.name}</strong>{dist !== null ? ` (${fmtKm(dist)} from where today ends)` : ''}</> : ''}.</>}</span></p>}
    </div>
    <Button size="sm" onClick={onGo} className="mt-4">Go to {next.label} <ArrowRight data-icon="inline-end" /></Button>
  </div>
}

// real stays near the day's base (OpenStreetMap) so you know where to go
function StayPanel({ base, type, cost, data, loading, picked, onPick }: { base: string; type: string; cost: number; data?: Nearby; loading: boolean; picked?: NearbyPlace; onPick: (p: NearbyPlace) => void }) {
  const groups: [string, string[]][] = [['Hostels and dorms', ['Hostel / dorm']], ['Guesthouses', ['Guesthouse']], ['Hotels', ['Hotel']], ['Other stays', ['Motel', 'Apartment', 'Chalet']]]
  const stays = (data?.places ?? []).filter((p) => p.kind === 'stay')
  return <details open className="rounded-2xl border border-border bg-card p-4">
    <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-foreground"><BedDouble className="size-4 text-brand" />Where to stay in {base}</summary>
    {type && <p className="mt-2 text-xs text-muted-foreground">Suggested for your budget: {type}{cost > 0 ? `, about ${inr(cost)} per night` : ''}.</p>}
    {picked && <p className="mt-2 text-xs font-medium text-success">Your stay: {picked.name}</p>}
    {loading && <p className="mt-2 text-xs text-muted-foreground">Finding places to stay…</p>}
    {!loading && stays.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No stays found on the map for {base}. <a href={mapsLink(`hostels and hotels in ${base}`)} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">Search in Maps</a></p>}
    {groups.map(([title, subs]) => {
      const list = stays.filter((p) => subs.includes(p.sub)).slice(0, 4)
      if (!list.length) return null
      return <div key={title} className="mt-3">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        <ul className="mt-1 flex flex-col gap-1.5">{list.map((p) => {
          const chosen = picked?.name === p.name && picked.lat === p.lat
          return <li key={p.name + p.lat} className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0"><span className="font-medium text-foreground">{p.name}</span><span className="text-muted-foreground"> · {fmtKm(p.dist_m / 1000)} from centre · <a href={latLngLink(p.lat, p.lng)} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">Maps</a></span></span>
            <button type="button" onClick={() => onPick(p)} className={`shrink-0 rounded-full border px-2.5 py-1 font-medium ${chosen ? 'border-success text-success' : 'border-border text-muted-foreground'}`}>{chosen ? '✓ Your stay' : 'Choose'}</button>
          </li>
        })}</ul>
      </div>
    })}
    <p className="mt-3 text-xs leading-5 text-muted-foreground">From OpenStreetMap, so it can be incomplete. Check prices and availability before you book.</p>
  </details>
}

// hospitals, clinics and pharmacies near the day's base
function MedicalPanel({ base, data, loading }: { base: string; data?: Nearby; loading: boolean }) {
  const groups: [string, string][] = [['Hospitals', 'Hospital'], ['Clinics and doctors', 'Clinic'], ['Pharmacies', 'Pharmacy']]
  const med = (data?.places ?? []).filter((p) => p.kind === 'medical')
  return <details className="rounded-2xl border border-border bg-card p-4">
    <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-foreground"><Plus className="size-4 text-destructive" />Medical and emergency near {base}</summary>
    {loading && <p className="mt-2 text-xs text-muted-foreground">Finding hospitals and pharmacies…</p>}
    {!loading && med.length === 0 && <p className="mt-2 text-xs text-muted-foreground">Nothing found on the map for {base}. <a href={mapsLink(`hospital near ${base}`)} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">Search in Maps</a></p>}
    {groups.map(([title, sub]) => {
      const list = med.filter((p) => p.sub === sub).slice(0, 3)
      if (!list.length) return null
      return <div key={title} className="mt-3">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        <ul className="mt-1 flex flex-col gap-1.5">{list.map((p) => <li key={p.name + p.lat} className="text-xs">
          <span className="font-medium text-foreground">{p.name}</span>{p.er && <span className="ml-1.5 rounded-full border border-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive">Emergency</span>}
          <span className="text-muted-foreground"> · {fmtKm(p.dist_m / 1000)} from centre · <a href={latLngLink(p.lat, p.lng)} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">Maps</a></span>
        </li>)}</ul>
      </div>
    })}
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Save the local emergency number before you travel. Map data can be incomplete, so confirm opening hours.</p>
  </details>
}

// spending so far against the trip budget (stops, stay estimate and getting there)
function SpendCard({ days, day, budget, travelCost, status }: { days: Day[]; day: number; budget: number; travelCost: number; status: Record<string, Status> }) {
  const today = daySpend(days[day], status)
  const stopsTotal = days.reduce((n, d) => n + daySpend(d, status), 0)
  const stayTotal = days.reduce((n, d) => n + d.stayCost, 0)
  const used = travelCost + stopsTotal + stayTotal
  const left = budget - used
  const over = left < 0
  const pct = Math.min(100, Math.round((used / Math.max(budget, 1)) * 100))
  const row = (label: string, value: string, strong = false, bad = false) => <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className={`${strong ? 'font-semibold' : 'font-medium'} ${bad ? 'text-destructive' : 'text-foreground'}`}>{value}</dd></div>
  return <div className="rounded-2xl border border-border bg-card p-4">
    <div className="flex items-center justify-between">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground"><Wallet className="size-4 text-brand" />Spending tracker</p>
      <span className="text-xs text-muted-foreground">Budget {inr(budget)}</span>
    </div>
    <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used"><div className={`h-full rounded-full ${over ? 'bg-destructive' : 'bg-brand'}`} style={{ width: `${pct}%` }} /></div>
    <dl className="mt-3 flex flex-col gap-1.5 text-xs">
      {row(`${days[day]?.label ?? 'Today'} stops`, inr(today))}
      {row(`All ${days.length} days, stops`, inr(stopsTotal))}
      {row('Stay (estimate)', stayTotal > 0 ? inr(stayTotal) : 'Not estimated')}
      {row('Getting there', travelCost > 0 ? inr(travelCost) : 'Not estimated')}
      {row(over ? 'Over budget by' : 'Left for meals and extras', inr(Math.abs(left)), true, over)}
    </dl>
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Stop costs are per person and skipped places are not counted. Stay is an estimate for the suggested type of place. Local transport is not counted.</p>
  </div>
}

// rain note for one day, with a button to swap outdoor stops for indoor ones
function WeatherNote({ info, rerouted, busy, onReroute, onUndo }: { info?: DayWeather; rerouted: boolean; busy: boolean; onReroute: () => void; onUndo: () => void }) {
  if (!rerouted && !info?.rain) return null
  return <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground">
    <CloudRain className="size-4 shrink-0 text-brand" />
    <span className="min-w-0 flex-1">{rerouted ? 'Rerouted for rain: outdoor stops were swapped for indoor ones.' : `Rain likely${info ? ` (${Math.round(info.rain_prob * 100)}% chance, up to ${info.temp_c}°C)` : ''}. Swap outdoor stops for indoor ones?`}</span>
    {rerouted ? <Button size="sm" variant="outline" onClick={onUndo}>Undo</Button> : <Button size="sm" onClick={onReroute} disabled={busy}>{busy ? 'Rerouting…' : 'Reroute day'}</Button>}
  </div>
}

function MapCard({ stop }: { stop?: Stop }) {
  if (!stop) return null
  return <div className="map-card">
    <SafeImg src={stop.image} alt={stop.name} className="map-card-img" />
    <div className="min-w-0">
      <p className="category-label">{stop.category} · {costLabel(stop.cost)}</p>
      <h3 className="mt-0.5 font-serif text-xl font-normal leading-tight text-foreground">{stop.name}</h3>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{stop.why || stop.insights[0]}</p>
    </div>
  </div>
}

function GuideChat({ open, setOpen, city }: { open: boolean; setOpen: (value: boolean) => void; city: string }) {
  const [language, setLanguage] = useState('English')
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])

  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    const history = messages
    setMessages([...history, { role: 'user', content: text }])
    setInput('')
    setLoading(true)
    try {
      const reply = await askGuide({ message: text, language, city: city || 'your destination', history })
      setMessages((m) => [...m, { role: 'assistant', content: reply }])
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Sorry, I could not reply right now. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }

  return <div className="guide-wrap">{open && <section className="guide-panel" aria-label="Local guide chat">
    <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="text-sm font-semibold text-foreground">Ask your local guide</p><p className="mt-1 text-xs text-muted-foreground">{city ? `Local tips for ${city}` : 'Ask anything about your trip'}</p></div><button type="button" onClick={() => setOpen(false)} aria-label="Close guide"><X className="size-4 text-muted-foreground" /></button></div>
    <div className="flex flex-col gap-3 p-5">
      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto pr-1">
        {messages.length === 0 && <div className="rounded-2xl rounded-bl-md bg-secondary px-3.5 py-3 text-sm leading-6 text-foreground/80">Hi! Ask me about transport, food, etiquette or timing. Pick your language below.</div>}
        {messages.map((m, i) => <div key={i} className={m.role === 'user' ? 'self-end rounded-2xl rounded-br-md bg-brand-soft px-3.5 py-2.5 text-sm text-foreground' : 'rounded-2xl rounded-bl-md bg-secondary px-3.5 py-3 text-sm leading-6 text-foreground/80'}>{m.content}</div>)}
        {loading && <div className="rounded-2xl rounded-bl-md bg-secondary px-3.5 py-3 text-sm text-muted-foreground">Typing…</div>}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send() }} placeholder="Type your question…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        <button type="button" onClick={send} disabled={loading || !input.trim()} aria-label="Send" className="text-brand disabled:opacity-40"><ArrowRight className="size-4" /></button>
      </div>
      <div className="flex items-center justify-between">
        <select value={language} onChange={(event) => setLanguage(event.target.value)} className="bg-transparent text-xs font-medium text-muted-foreground outline-none"><option>English</option><option>Hindi</option><option>Marathi</option><option>Japanese</option><option>Spanish</option><option>French</option></select>
        <Globe2 className="size-4 text-muted-foreground" />
      </div>
    </div></section>}<button type="button" onClick={() => setOpen(!open)} aria-label={open ? 'Close local guide' : 'Open local guide'} className="guide-button">{open ? <X className="size-5" /> : <MessageCircle className="size-5" />}<span className="guide-ping" /></button></div>
}

export default function Page() {
  const [activePage, setActivePage] = useState<PageId>('plan')
  const [days, setDays] = useState<Day[]>([])
  const [trip, setTrip] = useState<Trip | null>(null)
  const [editing, setEditing] = useState(false)
  const [day, setDay] = useState(0)
  const [selected, setSelected] = useState('')
  const [focusTick, setFocusTick] = useState(0)
  const [accessibility, setAccessibility] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [budget, setBudget] = useState(75000)
  const [interests, setInterests] = useState(['Culture', 'Food', 'Nature'])
  const [forecast, setForecast] = useState<Record<string, DayWeather>>({})
  const [original, setOriginal] = useState<Record<number, Day>>({})
  const [rerouting, setRerouting] = useState(false)
  const [status, setStatusMap] = useState<Record<string, Status>>({})
  const [nearby, setNearby] = useState<Record<string, Nearby>>({})
  const [stayPick, setStayPick] = useState<Record<string, NearbyPlace>>({})
  const [transitNear, setTransitNear] = useState<Record<string, NearbyPlace[]>>({})
  const [journey, setJourney] = useState<Journey | null>(null)
  const [error, setError] = useState('')
  const [heroImage, setHeroImage] = useState('')
  const [tripImage, setTripImage] = useState('')
  const [worldImgs, setWorldImgs] = useState<{ label: string; image: string }[]>([])
  const [destPhotos, setDestPhotos] = useState<string[]>([])
  const [tick, setTick] = useState(0)
  const [travel, setTravel] = useState<TravelInfo | null>(null)
  const [travelBusy, setTravelBusy] = useState(false)
  const [coords, setCoords] = useState<Record<string, LL>>({})
  const [geoDone, setGeoDone] = useState(false)
  const geoCache = useRef<Record<string, LL>>({})
  const tries = useRef<Record<string, number>>({})
  const centers = useRef<Record<string, LL>>({})
  const genId = useRef(0)

  const tripLength = countDays(startDate, endDate)
  const generated = trip !== null && days.length > 0
  const canGenerate = origin.trim() !== '' && destination.trim() !== '' && tripLength >= 1 && tripLength <= MAX_DAYS && budget > 0
  const selectedStop = useMemo(() => days[day]?.stops.find((s) => s.name === selected) ?? days[day]?.stops[0], [days, day, selected])
  const pick = (name: string) => { setSelected(name); setFocusTick((t) => t + 1) }
  const setStatus = (key: string, v: Status) => setStatusMap((m) => ({ ...m, [key]: v }))

  // where a stop is on the map (from the plan, or geocoded in the background)
  const locOf = (s?: Stop): LL | null => {
    if (!s || !trip) return null
    if (s.lat !== undefined && s.lng !== undefined) return { lat: s.lat, lng: s.lng }
    return coords[`${s.name}|${trip.destination}`] ?? null
  }
  const gap = (a?: Stop, b?: Stop): number | null => {
    const x = locOf(a)
    const y = locOf(b)
    return x && y ? km(x, y) : null
  }

  const stopKey = days[day]?.stops.map((s) => s.name).join('|') ?? ''
  const mapPoints: MapPoint[] = useMemo(() => {
    if (!trip || !days[day]) return []
    return days[day].stops.filter(isPlace).flatMap((s, i) => {
      const c: LL | undefined = s.lat !== undefined && s.lng !== undefined ? { lat: s.lat, lng: s.lng } : coords[`${s.name}|${trip.destination}`]
      return c ? [{ n: i + 1, name: s.name, lat: c.lat, lng: c.lng }] : []
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopKey, day, trip, coords])

  // ---------- background images ----------
  useEffect(() => {
    let dead = false
    wikiImages(WORLD.map((w) => w.title), 1600).then((m) => {
      if (!dead) setWorldImgs(WORLD.filter((w) => m[w.title]).map((w) => ({ label: w.label, image: m[w.title] })))
    })
    return () => { dead = true }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 7000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const name = destination.trim()
    if (!name) { setHeroImage(''); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const m = await wikiImages([titleCase(name)], 1600)
      if (!cancelled) setHeroImage(Object.values(m)[0] ?? '')
    }, 600)
    return () => { cancelled = true; clearTimeout(t) }
  }, [destination])

  const photoQuery = generated && !editing ? (trip?.destination ?? '') : destination.trim()
  useEffect(() => {
    if (!photoQuery) { setDestPhotos([]); return }
    let dead = false
    const t = setTimeout(async () => {
      const p = await destinationPhotos(photoQuery)
      if (!dead) setDestPhotos(p)
    }, 700)
    return () => { dead = true; clearTimeout(t) }
  }, [photoQuery])

  // ---------- travel distance + cost estimate ----------
  useEffect(() => {
    const o = origin.trim()
    const d = destination.trim()
    if (!o || !d) { setTravel(null); setTravelBusy(false); return }
    let dead = false
    setTravelBusy(true)
    const t = setTimeout(async () => {
      const [a, b] = await Promise.all([locate(o), locate(d)])
      if (dead) return
      setTravelBusy(false)
      if (!a || !b) { setTravel(null); return }
      const dist = Math.round(km(a, b))
      const intl = !!a.cc && !!b.cc && a.cc !== b.cc
      setTravel({ km: dist, intl, ...estimateTravel(dist, intl) })
    }, 900)
    return () => { dead = true; clearTimeout(t) }
  }, [origin, destination])

  // ---------- map coordinates (current day first, then the other days in the background) ----------
  useEffect(() => {
    if (!trip || !days[day]) return
    const city = trip.destination
    const order = [day, ...days.map((_, i) => i).filter((i) => i !== day)]
    const todo = order.flatMap((i) => days[i].stops.filter((s) => isPlace(s) && (s.lat === undefined || s.lng === undefined)))
    let cancelled = false
    setGeoDone(false)
    ;(async () => {
      let bias = centers.current[city]
      if (!bias) {
        const c = await locate(city)
        if (c) { bias = { lat: c.lat, lng: c.lng }; centers.current[city] = bias }
      }
      for (const s of todo) {
        if (cancelled) return
        const key = `${s.name}|${city}`
        if (geoCache.current[key]) continue
        if ((tries.current[key] ?? 0) >= 2) continue
        tries.current[key] = (tries.current[key] ?? 0) + 1
        const hit = await geocodeStop(s.name, city, bias)
        if (hit) {
          geoCache.current[key] = hit
          setCoords({ ...geoCache.current })
        }
      }
      if (!cancelled) setGeoDone(true)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopKey, day, trip?.destination])

  // ---------- stays and medical near today's base (OpenStreetMap, via the backend) ----------
  const cur0 = days[day]
  const baseKey = trip && cur0 ? `${trip.destination}|${cur0.base}` : ''
  const nearbyLoading = !!baseKey && !nearby[baseKey]
  useEffect(() => {
    if (!trip || !cur0 || !baseKey || nearby[baseKey]) return
    let dead = false
    ;(async () => {
      const c = (await locate(`${cur0.base}, ${trip.destination}`)) ?? (await locate(cur0.base))
      if (dead) return
      if (!c) { setNearby((m) => ({ ...m, [baseKey]: { center: { lat: 0, lng: 0 }, places: [] } })); return }
      const places = await getNearby({ lat: c.lat, lng: c.lng, radius_m: 1500, kinds: ['stay', 'medical'] })
      if (!dead) setNearby((m) => ({ ...m, [baseKey]: { center: { lat: c.lat, lng: c.lng }, places } }))
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey])

  // real bus, train and metro stops around the selected place
  const selLoc = selectedStop && isPlace(selectedStop) ? locOf(selectedStop) : null
  const selKey = selectedStop && selLoc && trip ? `${trip.destination}|${selectedStop.name}` : ''
  useEffect(() => {
    if (!selKey || !selLoc || transitNear[selKey]) return
    let dead = false
    const t = setTimeout(async () => {
      const places = await getNearby({ lat: selLoc.lat, lng: selLoc.lng, radius_m: 600, kinds: ['transit'] })
      if (!dead) setTransitNear((m) => ({ ...m, [selKey]: places }))
    }, 400)
    return () => { dead = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, !!selLoc])
  const transitFor = (s: Stop) => (trip ? transitNear[`${trip.destination}|${s.name}`] : undefined)

  // the move of the day (home to destination, or town to town), drawn on the map when its Travel card is selected
  const jKey = trip && cur0?.transfer ? `${cur0.from}|${cur0.base}` : ''
  useEffect(() => {
    if (!jKey || !trip || !cur0) { setJourney(null); return }
    let dead = false
    ;(async () => {
      const fromQ = cur0.legIdx === 0 ? cur0.from : `${cur0.from}, ${trip.destination}`
      const [a, b] = await Promise.all([
        locate(fromQ),
        locate(`${cur0.base}, ${trip.destination}`).then((r) => r ?? locate(cur0.base)),
      ])
      if (dead) return
      setJourney(a && b ? { from: { lat: a.lat, lng: a.lng }, to: { lat: b.lat, lng: b.lng }, mode: cur0.transfer?.mode ?? '', fromName: cur0.from, toName: cur0.base } : null)
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jKey])

  // stays, medical and transit points for the map (TripMap draws them when it supports `extras`)
  const extras = useMemo(() => {
    const out: { kind: string; sub: string; name: string; lat: number; lng: number; picked?: boolean }[] = []
    const d = nearby[baseKey]
    const pick0 = stayPick[baseKey]
    ;(d?.places ?? []).filter((p) => p.kind === 'stay').slice(0, 15).forEach((p) => out.push({ kind: 'stay', sub: p.sub, name: p.name, lat: p.lat, lng: p.lng, picked: pick0?.name === p.name && pick0.lat === p.lat }))
    ;(d?.places ?? []).filter((p) => p.kind === 'medical').slice(0, 10).forEach((p) => out.push({ kind: p.er ? 'emergency' : 'medical', sub: p.sub, name: p.name, lat: p.lat, lng: p.lng }))
    ;(transitNear[selKey] ?? []).slice(0, 6).forEach((p) => out.push({ kind: 'transit', sub: p.sub, name: p.name, lat: p.lat, lng: p.lng }))
    return out
  }, [nearby, baseKey, stayPick, transitNear, selKey])

  const fillImages = async (dest: string, mapped: Day[], id: number) => {
    const places = mapped.flatMap((d) => d.stops.filter(isPlace).map((s) => ({ name: s.name.trim(), city: dest })))
    const [destSmall, destBig, stopUrls] = await Promise.all([
      wikiImages([titleCase(dest)], 800),
      wikiImages([titleCase(dest)], 1600),
      getPlaceImages(places), // backend: one photo per place, same order as `places`
    ])
    if (id !== genId.current) return
    const fallback = Object.values(destSmall)[0] ?? ''
    setTripImage(Object.values(destBig)[0] ?? '')
    setDays((prev) => {
      let k = 0 // reset on every run, so React's double-call is safe
      return prev.map((d) => ({
        ...d,
        stops: d.stops.map((s) => ({ ...s, image: isPlace(s) ? (stopUrls[k++] ?? fallback) : fallback })),
      }))
    })
  }

  const handleGenerate = async () => {
    const id = ++genId.current
    setGenerating(true)
    setError('')
    try {
      const dest = destination.trim()
      const total = tripLength
      const from = origin.trim()
      // plan the days with what is left after getting there
      const onGround = travel ? Math.max(budget - travel.mid, Math.round(budget * 0.35)) : budget

      // 1. realistic skeleton: where we sleep each night and how long each move takes
      const forecastPromise = getForecast(dest)
      const skeleton = await getPlan({ origin: from, destination: dest, n_days: total, budget_inr: budget, interests, accessibility, travel_km: travel?.km, travel_mode: travel?.mode })
      const pdays: PlanDay[] = skeleton?.days?.length === total
        ? skeleton.days
        : Array.from({ length: total }, () => ({ leg: 0, base: dest, kind: 'normal', start: '09:00', max_stops: 4, transfer: null, stay_type: '', stay_cost_inr: 0 }))

      // 2. fill each day with places near the base where we sleep
      const chunks: { i: number; len: number }[] = []
      for (let i = 0; i < total; i += CHUNK) chunks.push({ i, len: Math.min(CHUNK, total - i) })
      const plans = await Promise.all(chunks.map(({ i, len }) => generateItinerary({
        destination: dest,
        start_date: addDays(startDate, i),
        end_date: addDays(startDate, i + len - 1),
        days: len,
        interests,
        budget: Math.round((onGround * len) / total),
        accessibility,
        day_offset: i,
        total_days: total,
        day_context: pdays.slice(i, i + len).map((d) => ({ base: d.base, start: d.start, max_stops: d.max_stops })),
      })))
      const fc = await forecastPromise

      const mapped = toDays({ days: plans.flatMap((p) => p?.days ?? []) }, startDate).slice(0, total)
      if (!mapped.length) throw new Error('empty plan')

      // 3. add the moves (wake up, pack, travel, arrive) and keep every day non-empty
      const full: Day[] = mapped.map((d, i) => {
        const pd = pdays[i]
        const t = pd?.transfer ?? null
        const base = pd?.base ?? dest
        const prevBase = i > 0 ? pdays[i - 1].base : from
        const stops: Stop[] = [...d.stops]
        if (t) {
          const flight = /flight|plane|air/i.test(t.mode)
          stops.push({ kind: 'transfer', time: t.depart, name: `Travel: ${prevBase} → ${base}`, category: 'Travel', icon: flight ? Plane : TrainFront, image: '', description: `${t.mode}, about ${fmtHours(t.hours)} door to door. Arrive around ${t.arrive}${t.travel_days ? ' the next day' : ''}.${t.note ? ' ' + t.note : ''}`, why: '', cost: pd.leg === 0 ? 0 : t.cost_inr, transport: null, badge: '', insights: [], travel: '' })
        }
        if (!stops.length) stops.push({ kind: 'rest', time: pd?.start ?? '', name: `Rest and settle in ${base}`, category: 'Rest', icon: BedDouble, image: '', description: 'Check in, freshen up and take it easy.', why: '', cost: 0, transport: null, badge: '', insights: [], travel: '' })
        stops.sort((a, b) => a.time.localeCompare(b.time))
        return { ...d, base, from: prevBase, legIdx: pd?.leg ?? 0, transfer: t, stayType: pd?.stay_type ?? '', stayCost: pd?.stay_cost_inr ?? 0, overnight: base, stops }
      })

      setDays(full)
      setDay(0)
      setSelected(firstPlace(full[0]))
      setTrip({ destination: dest, origin: from, travel, startDate, endDate, budget, interests })
      setForecast(fc ?? {})
      setOriginal({})
      setStatusMap({})
      setNearby({})
      setStayPick({})
      setTransitNear({})
      setEditing(false)
      fillImages(dest, full, id)
    } catch {
      setError('Could not build the itinerary. Check the details and try again.')
    } finally {
      setGenerating(false)
    }
  }

  const switchDay = (index: number) => { setDay(index); setSelected(firstPlace(days[index])) }
  // swap the outdoor stops of one day for indoor ones (backend: POST /api/reroute)
  const rerouteCurrent = async (index: number) => {
    if (!trip || rerouting || !days[index]) return
    const d = days[index]
    setRerouting(true)
    setError('')
    try {
      const avoid = days.filter((_, i) => i !== index).flatMap((x) => x.stops.filter(isPlace).map((s) => s.name))
      const res = await rerouteDay({
        destination: trip.destination,
        interests: trip.interests,
        accessibility,
        budget: Math.max(Math.round(trip.budget / days.length), 1000),
        reason: 'rain',
        avoid,
        day: {
          theme: d.theme, area: d.area, overnight: d.overnight, bridge: d.bridge,
          stops: d.stops.filter(isPlace).map((s) => ({ time: s.time, name: s.name, category: s.category, description: s.description, why: s.why, badge: s.badge, insights: s.insights, cost_inr: s.cost, travel: s.travel, transport: s.transport })),
        },
      })
      const nd = toDays({ days: [res.day] }, trip.startDate)[0]
      if (!nd?.stops.length) throw new Error('empty')
      const oldImg: Record<string, string> = {}
      d.stops.forEach((s) => { if (s.image) oldImg[s.name] = s.image })
      const merged: Day = { ...d, theme: nd.theme || d.theme, area: nd.area || d.area, overnight: d.overnight, bridge: d.bridge, stops: [...d.stops.filter((s) => !isPlace(s)), ...nd.stops.map((s) => ({ ...s, image: oldImg[s.name] ?? '' }))].sort((a, b) => a.time.localeCompare(b.time)) }
      setOriginal((o) => (o[index] ? o : { ...o, [index]: d }))
      setDays((prev) => prev.map((x, i) => (i === index ? merged : x)))
      if (index === day) setSelected(firstPlace(merged))
      const need = merged.stops.filter((s) => isPlace(s) && !s.image)
      if (need.length) {
        const urls = await getPlaceImages(need.map((s) => ({ name: s.name.trim(), city: trip.destination })))
        const byName: Record<string, string> = {}
        need.forEach((s, k) => { if (urls[k]) byName[s.name] = urls[k] as string })
        setDays((prev) => prev.map((x, i) => (i === index ? { ...x, stops: x.stops.map((s) => (s.image || !isPlace(s) ? s : { ...s, image: byName[s.name] ?? '' })) } : x)))
      }
    } catch {
      setError('Could not reroute this day. Try again.')
    } finally {
      setRerouting(false)
    }
  }
  const undoReroute = (index: number) => {
    const d = original[index]
    if (!d) return
    setDays((prev) => prev.map((x, i) => (i === index ? d : x)))
    setOriginal((o) => { const n = { ...o }; delete n[index]; return n })
    if (index === day) setSelected(firstPlace(d))
  }
  const jumpDay = (index: number) => { switchDay(index); window.scrollTo({ top: 0, behavior: 'smooth' }) }

  const dayTabs = <div role="tablist" aria-label="Trip days" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, overflow: 'visible' }}>{days.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={day === index} onClick={() => switchDay(index)} className={`day-tab ${day === index ? 'day-tab-active' : ''}`}><span>{item.label}</span><small>{item.date}</small></button>)}</div>

  const accessToggle = <div className="flex items-center gap-2 text-sm text-white/85"><Accessibility className="size-4" /><span>Accessibility</span><button type="button" aria-label="Toggle accessibility mode" aria-pressed={accessibility} onClick={() => setAccessibility(!accessibility)} className={`toggle ${accessibility ? 'toggle-on' : ''}`}><span /></button></div>

  // note above the day's stops (where yesterday ended) and cards below them (tonight, tomorrow, spending)
  const cur = days[day]
  const prevDay = day > 0 ? days[day - 1] : undefined
  const nextDay = day < days.length - 1 ? days[day + 1] : undefined
  const dayHead = cur ? <>
    <WeatherNote info={forecast[cur.iso]} rerouted={!!original[day]} busy={rerouting} onReroute={() => rerouteCurrent(day)} onUndo={() => undoReroute(day)} />
    {prevDay && <DayFrom prev={prevDay} cur={cur} first={cur.stops.find(isPlace)} dist={gap(lastPlace(prevDay), cur.stops.find(isPlace))} />}
  </> : null
  const stayHere = trip && cur ? stayPick[baseKey] : undefined
  const placesBlock = cur && trip ? <>
    <StayPanel base={cur.base} type={cur.stayType} cost={cur.stayCost} data={nearby[baseKey]} loading={nearbyLoading} picked={stayHere} onPick={(p) => setStayPick((m) => ({ ...m, [baseKey]: p }))} />
    <MedicalPanel base={cur.base} data={nearby[baseKey]} loading={nearbyLoading} />
  </> : null
  const dayFoot = cur && trip ? <div className="mt-8 flex flex-col gap-4">
    {nextDay && <DayNext cur={cur} next={nextDay} dist={gap(lastPlace(cur), nextDay.stops.find(isPlace))} stay={stayHere} onGo={() => jumpDay(day + 1)} />}
    {placesBlock}
    <SpendCard days={days} day={day} budget={trip.budget} travelCost={trip.travel?.mid ?? 0} status={status} />
  </div> : null
  const dayPlaces = cur ? cur.stops.filter(isPlace) : []
  const dayVisited = cur ? dayPlaces.filter((s) => status[skey(cur.iso, s.name)] === 'visited').length : 0
  const daySkipped = cur ? dayPlaces.filter((s) => status[skey(cur.iso, s.name)] === 'skip').length : 0
  const dayProgress = dayPlaces.length === 0 ? 'No sightseeing today' : `${dayVisited} of ${dayPlaces.length - daySkipped} visited`
  const journeyOn = !!cur?.transfer && (selectedStop?.kind === 'transfer' || dayPlaces.length === 0)
  const dayMeta = cur ? [cur.theme, cur.area].filter(Boolean).join(' · ') : ''

  // ---------- what the background shows ----------
  const tripView = activePage === 'plan' && generated && !editing
  let bgList: string[] = []
  if (activePage === 'trip' && generated) bgList = [...new Set([tripImage, ...destPhotos].filter(Boolean))]
  else if (tripView) bgList = [selectedStop?.image || tripImage || heroImage].filter(Boolean)
  else if (activePage === 'plan' && destination.trim()) bgList = [...new Set([heroImage, ...destPhotos].filter(Boolean))]
  if (!bgList.length) bgList = worldImgs.map((w) => w.image)
  const bgSrc = bgList.length ? bgList[tick % bgList.length] : ''
  const activeTile = worldImgs.findIndex((w) => w.image === bgSrc)
  const whiteGhost = 'text-white hover:bg-white/15 hover:text-white'
  const missing = tripView && !journeyOn && days[day] ? days[day].stops.filter(isPlace).length - mapPoints.length : 0

  return <>
    <Backdrop src={bgSrc} mode={tripView || (activePage === 'trip' && generated) ? 'trip' : 'hero'} />
    <main className="voyara-app"><header className="topbar"><Logo /><nav className="main-nav" aria-label="Main navigation">{NAV.map(([id, label]) => <button key={id} type="button" className={activePage === id ? 'nav-item nav-item-active' : 'nav-item'} onClick={() => setActivePage(id)}>{label}</button>)}</nav><div className="ml-auto flex items-center gap-3">{trip && <span className="hidden text-xs text-white/80 sm:block">{trip.destination} · {fmt(trip.startDate)}–{fmt(trip.endDate)}</span>}<div className="avatar">AS</div></div></header>

      {activePage === 'plan' ? <div className="page-shell">
        {(!generated || editing) && <div className="plan-hero">
          <p className="eyebrow-light">Voyara · AI trip planner</p>
          <h1 className="plan-hero-title">{destination.trim() ? `${destination.trim()}, thoughtfully arranged.` : 'Where to next?'}</h1>
          <p className="plan-hero-sub">Tell us where you start, where you are going and when. We’ll shape the days, the route and the little details.</p>
        </div>}
        {error && <p className="mx-auto mb-4 w-fit rounded-lg bg-white px-3 py-2 text-sm text-destructive">{error}</p>}

        {!generated || editing ? <>
          {generated && <Button variant="ghost" size="sm" onClick={() => setEditing(false)} className={`mb-4 ${whiteGhost}`}>← Back to itinerary</Button>}
          <PlanningPanel accessibility={accessibility} setAccessibility={setAccessibility} generating={generating} canGenerate={canGenerate} onGenerate={handleGenerate} budget={budget} setBudget={setBudget} interests={interests} setInterests={setInterests} origin={origin} setOrigin={setOrigin} destination={destination} setDestination={setDestination} startDate={startDate} setStartDate={setStartDate} endDate={endDate} setEndDate={setEndDate} tripLength={tripLength} travel={travel} travelBusy={travelBusy} />
          <Discover items={worldImgs} active={destination.trim() ? -1 : activeTile} onPick={setDestination} />
        </> : trip && <>
          <div className="trip-header">
            <div>
              <h1 className="trip-title">{trip.destination}, thoughtfully arranged.</h1>
              <p className="trip-meta">{trip.origin ? `${trip.origin} → ${trip.destination} · ` : ''}{fmt(trip.startDate)} — {fmt(trip.endDate)} · {days.length} days · ₹{trip.budget.toLocaleString('en-IN')}</p>
              {trip.travel && <div className="trip-chip"><Plane className="size-4" />{trip.travel.intl ? 'International' : 'Domestic'} · {trip.travel.mode} · about {trip.travel.km.toLocaleString('en-IN')} km · round trip ≈ {inr(trip.travel.lo)}–{inr(trip.travel.hi)}</div>}
            </div>
            <div className="flex items-center gap-4">{accessToggle}<Button variant="outline" onClick={() => setEditing(true)}>Edit trip</Button></div>
          </div>
          <div className="trip-split">
            <div className="map-panel">
              <TripMap points={mapPoints} selected={selectedStop?.name ?? ''} onSelect={pick} focusTick={focusTick} extras={extras} journey={journeyOn ? journey : null} />
              {missing > 0 && <div className="map-empty">{geoDone ? `${missing} place${missing > 1 ? 's' : ''} couldn’t be placed on the map` : `Locating places… ${mapPoints.length} of ${days[day].stops.filter(isPlace).length}`}</div>}
              <MapCard stop={selectedStop} />
            </div>
            <section className="day-panel">
              {dayTabs}
              <div className="itinerary-content"><div className="flex items-baseline justify-between"><div><p className="eyebrow-light">{days[day].date} · {dayProgress} · {inr(daySpend(days[day], status))}</p><h2 className="mt-2 font-serif text-3xl font-normal tracking-[-0.01em] text-white">Day {day + 1} in {trip.destination}</h2>{dayMeta && <p className="mt-1 text-sm text-white/80">{dayMeta}</p>}</div><Button variant="ghost" size="sm" className={whiteGhost}><ExternalLink />Share</Button></div><div className="mt-8">{dayHead}<Timeline stops={days[day].stops} selected={selected} setSelected={pick} accessible={accessibility} dest={trip.destination} iso={days[day].iso} status={status} setStatus={setStatus} transit={transitFor} gapKm={gap} /></div>{dayFoot}</div>
            </section>
          </div>
        </>}
      </div>

      : activePage === 'explore' || activePage === 'profile' ? <div className="page-shell trip-shell"><div className="empty-itinerary"><Compass className="mx-auto size-6 text-white" /><h2 className="mt-4 font-serif text-2xl font-normal text-white">{activePage === 'explore' ? 'Explore' : 'Profile'} is coming soon</h2><p className="mt-2 text-sm text-white/80">We’re building this next.</p></div></div>

      : !generated || !trip ? <div className="page-shell trip-shell"><div className="empty-itinerary"><Compass className="mx-auto size-6 text-white" /><h2 className="mt-4 font-serif text-2xl font-normal text-white">No trip yet</h2><p className="mt-2 text-sm text-white/80">Plan one first and it will show up here.</p><Button onClick={() => setActivePage('plan')} className="mt-5">Go to Plan</Button></div></div>

      : <div className="page-shell trip-shell">
        <div className="trip-hero"><SafeImg src={tripImage} alt={trip.destination} fill /><div className="trip-hero-overlay" /><div className="trip-hero-label"><p>Live trip · {trip.destination}</p><h2>Your trip to {trip.destination}</h2></div></div>
        <div className="page-heading"><div><p className="text-sm text-white/85">{trip.origin ? `${trip.origin} → ${trip.destination} · ` : ''}{fmt(trip.startDate)} – {fmt(trip.endDate)} · {days.length} days</p></div>{accessToggle}</div>
        {accessibility && <div className="accessibility-banner"><Accessibility className="size-4" />Reordered for accessibility <span>Step-free venues are prioritized without removing the rest of your plan.</span></div>}
        <div className="trip-layout">
          <section className="itinerary-column">{dayTabs}<div className="itinerary-content"><div className="flex items-baseline justify-between"><div><p className="eyebrow-light">Live itinerary · {days[day].date} · {dayProgress} · {inr(daySpend(days[day], status))}</p><h2 className="mt-2 font-serif text-3xl font-normal tracking-[-0.01em] text-white">Follow the feeling.</h2>{dayMeta && <p className="mt-1 text-sm text-white/80">{dayMeta}</p>}</div><div className="live-label"><span className="status-dot" />Live</div></div><div className="mt-8">{dayHead}<Timeline stops={days[day].stops} selected={selected} setSelected={setSelected} accessible={accessibility} dest={trip.destination} iso={days[day].iso} status={status} setStatus={setStatus} transit={transitFor} gapKm={gap} /></div><div className="mt-8 flex flex-col gap-4">{nextDay && <DayNext cur={days[day]} next={nextDay} dist={gap(lastPlace(days[day]), nextDay.stops.find(isPlace))} stay={stayHere} onGo={() => jumpDay(day + 1)} />}{placesBlock}</div></div></section>
          <aside className="trip-side">
            <div className="trip-card"><p className="eyebrow">Trip summary</p><div className="mt-4 flex items-end justify-between"><span className="text-4xl font-semibold tracking-[-0.04em] text-foreground">{days.reduce((n, d) => n + d.stops.length, 0)}<span className="ml-1 text-base font-medium text-muted-foreground">stops</span></span><span className="text-xs text-success">{days.length} days</span></div></div>
            <SpendCard days={days} day={day} budget={trip.budget} travelCost={trip.travel?.mid ?? 0} status={status} />
            {trip.travel && <div className="trip-card"><p className="text-sm font-semibold text-foreground">Getting there</p><p className="mt-3 text-sm leading-6 text-muted-foreground">{trip.origin} → {trip.destination}<br />{trip.travel.intl ? 'International' : 'Domestic'} · {trip.travel.mode} · about {trip.travel.km.toLocaleString('en-IN')} km<br />Round trip ≈ {inr(trip.travel.lo)}–{inr(trip.travel.hi)}</p></div>}
            <div className="trip-card"><p className="text-sm font-semibold text-foreground">Your preferences</p><p className="mt-3 text-sm leading-6 text-muted-foreground">Budget ₹{trip.budget.toLocaleString('en-IN')}<br />{trip.interests.join(' · ') || 'No interests selected'}</p></div>
          </aside>
        </div>
      </div>}

      <GuideChat open={chatOpen} setOpen={setChatOpen} city={trip?.destination ?? destination} /></main>
  </>
}
