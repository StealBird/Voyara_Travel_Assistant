'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { LucideIcon } from 'lucide-react'
import {
  Accessibility,
  ArrowRight,
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
  TrainFront,
  Utensils,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MapPoint } from '@/components/trip-map'
import { generateItinerary, getWeather, getPlaceImages, askGuide } from '@/lib/api'

const TripMap = dynamic(() => import('@/components/trip-map'), {
  ssr: false,
  loading: () => <div className="map-skeleton" />,
})

type Stop = { time: string; name: string; category: string; icon: LucideIcon; image: string; description: string; badge: string; insights: string[]; travel: string; lat?: number; lng?: number }
type Day = { id: number; label: string; date: string; stops: Stop[] }
type TravelInfo = { km: number; intl: boolean; mode: string; mid: number; lo: number; hi: number }
type Trip = { destination: string; origin: string; travel: TravelInfo | null; startDate: string; endDate: string; budget: number; interests: string[] }
type PageId = 'plan' | 'explore' | 'trip' | 'profile'
type LL = { lat: number; lng: number }

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
    stops: (d.stops ?? d.activities ?? []).map((s: any, j: number) => {
      const category = s.category ?? 'Sight'
      return {
        time: s.time ?? '',
        name: s.name ?? s.title ?? 'Stop',
        category,
        icon: iconFor(category, j),
        image: '',
        description: s.description ?? '',
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
    <p className="mt-1 text-xs text-muted-foreground">About {travel.km.toLocaleString('en-IN')} km · {travel.mode} · round trip roughly {inr(travel.lo)}–{inr(travel.hi)}</p>
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

function Timeline({ stops, selected, setSelected, accessible }: { stops: Stop[]; selected: string; setSelected: (name: string) => void; accessible?: boolean }) {
  const visibleStops = accessible ? [...stops].sort((a, b) => (a.name.includes('Station') ? -1 : b.name.includes('Station') ? 1 : 0)) : stops
  return <div className="journey">{visibleStops.map((stop, index) => {
    const Icon = stop.icon
    const isSelected = selected === stop.name
    const n = stops.indexOf(stop) + 1
    return <div key={stop.name + index}>
      {index > 0 && <Connector flip={index % 2 === 0} />}
      <article
        role="button"
        tabIndex={0}
        onClick={() => setSelected(stop.name)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(stop.name) } }}
        className={`stop-card ${isSelected ? 'stop-card-selected' : ''}`}
      >
        <div className="stop-media">
          <SafeImg src={stop.image} alt={stop.name} className="stop-img" />
          <span className="stop-num">{n}</span>
          {stop.time && <span className="stop-time"><Clock3 className="size-3.5" />{stop.time}</span>}
        </div>
        <div className="stop-body">
          <span className="category-label inline-flex items-center gap-1.5"><Icon className="size-3.5" />{stop.category}</span>
          <h3 className="mt-1 font-serif text-2xl font-normal leading-tight text-foreground">{stop.name}</h3>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{stop.description}</p>
          {stop.travel && <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><TrainFront className="size-3.5" />{stop.travel}</div>}
        </div>
      </article>
    </div>
  })}</div>
}

function MapCard({ stop }: { stop?: Stop }) {
  if (!stop) return null
  return <div className="map-card">
    <SafeImg src={stop.image} alt={stop.name} className="map-card-img" />
    <div className="min-w-0">
      <p className="category-label">{stop.category}</p>
      <h3 className="mt-0.5 font-serif text-xl font-normal leading-tight text-foreground">{stop.name}</h3>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{stop.insights[0]}</p>
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
  const [rain, setRain] = useState(false)
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

  const stopKey = days[day]?.stops.map((s) => s.name).join('|') ?? ''
  const mapPoints: MapPoint[] = useMemo(() => {
    if (!trip || !days[day]) return []
    return days[day].stops.flatMap((s, i) => {
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
    const todo = order.flatMap((i) => days[i].stops.filter((s) => s.lat === undefined || s.lng === undefined))
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

  const fillImages = async (dest: string, mapped: Day[], id: number) => {
    const places = mapped.flatMap((d) => d.stops.map((s) => ({ name: s.name.trim(), city: dest })))
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
        stops: d.stops.map((s) => ({ ...s, image: stopUrls[k++] ?? fallback })),
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
      // plan the days with what is left after getting there
      const onGround = travel ? Math.max(budget - travel.mid, Math.round(budget * 0.35)) : budget
      const chunks: { i: number; len: number }[] = []
      for (let i = 0; i < total; i += CHUNK) chunks.push({ i, len: Math.min(CHUNK, total - i) })

      const weatherPromise = getWeather(dest).catch(() => null)
      const plans = await Promise.all(chunks.map(({ i, len }) => generateItinerary({
        destination: dest,
        start_date: addDays(startDate, i),
        end_date: addDays(startDate, i + len - 1),
        days: len,
        interests,
        budget: Math.round((onGround * len) / total),
        accessibility,
      })))
      const weather = await weatherPromise

      const mapped = toDays({ days: plans.flatMap((p) => p?.days ?? []) }, startDate).filter((d) => d.stops.length > 0)
      if (!mapped.length) throw new Error('empty plan')
      setDays(mapped)
      setDay(0)
      setSelected(mapped[0].stops[0].name)
      setTrip({ destination: dest, origin: origin.trim(), travel, startDate, endDate, budget, interests })
      setRain(Boolean(weather?.swap_to_indoor))
      setEditing(false)
      fillImages(dest, mapped, id)
    } catch {
      setError('Could not build the itinerary. Check the details and try again.')
    } finally {
      setGenerating(false)
    }
  }

  const switchDay = (index: number) => { setDay(index); setSelected(days[index]?.stops[0]?.name ?? '') }

  const dayTabs = <div role="tablist" aria-label="Trip days" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, overflow: 'visible' }}>{days.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={day === index} onClick={() => switchDay(index)} className={`day-tab ${day === index ? 'day-tab-active' : ''}`}><span>{item.label}</span><small>{item.date}</small></button>)}</div>

  const accessToggle = <div className="flex items-center gap-2 text-sm text-white/85"><Accessibility className="size-4" /><span>Accessibility</span><button type="button" aria-label="Toggle accessibility mode" aria-pressed={accessibility} onClick={() => setAccessibility(!accessibility)} className={`toggle ${accessibility ? 'toggle-on' : ''}`}><span /></button></div>

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
  const missing = tripView && days[day] ? days[day].stops.length - mapPoints.length : 0

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
              {trip.travel && <div className="trip-chip"><Plane className="size-4" />{trip.travel.mode} · about {trip.travel.km.toLocaleString('en-IN')} km · round trip ≈ {inr(trip.travel.lo)}–{inr(trip.travel.hi)}</div>}
            </div>
            <div className="flex items-center gap-4">{accessToggle}<Button variant="outline" onClick={() => setEditing(true)}>Edit trip</Button></div>
          </div>
          <div className="trip-split">
            <div className="map-panel">
              <TripMap points={mapPoints} selected={selectedStop?.name ?? ''} onSelect={pick} focusTick={focusTick} />
              {missing > 0 && <div className="map-empty">{geoDone ? `${missing} place${missing > 1 ? 's' : ''} couldn’t be placed on the map` : `Locating places… ${mapPoints.length} of ${days[day].stops.length}`}</div>}
              <MapCard stop={selectedStop} />
            </div>
            <section className="day-panel">
              {dayTabs}
              <div className="itinerary-content"><div className="flex items-baseline justify-between"><div><p className="eyebrow-light">{days[day].date} · {days[day].stops.length} stops</p><h2 className="mt-2 font-serif text-3xl font-normal tracking-[-0.01em] text-white">Day {day + 1} in {trip.destination}</h2></div><Button variant="ghost" size="sm" className={whiteGhost}><ExternalLink />Share</Button></div><div className="mt-8"><Timeline stops={days[day].stops} selected={selected} setSelected={pick} accessible={accessibility} /></div></div>
            </section>
          </div>
        </>}
      </div>

      : activePage === 'explore' || activePage === 'profile' ? <div className="page-shell trip-shell"><div className="empty-itinerary"><Compass className="mx-auto size-6 text-white" /><h2 className="mt-4 font-serif text-2xl font-normal text-white">{activePage === 'explore' ? 'Explore' : 'Profile'} is coming soon</h2><p className="mt-2 text-sm text-white/80">We’re building this next.</p></div></div>

      : !generated || !trip ? <div className="page-shell trip-shell"><div className="empty-itinerary"><Compass className="mx-auto size-6 text-white" /><h2 className="mt-4 font-serif text-2xl font-normal text-white">No trip yet</h2><p className="mt-2 text-sm text-white/80">Plan one first and it will show up here.</p><Button onClick={() => setActivePage('plan')} className="mt-5">Go to Plan</Button></div></div>

      : <div className="page-shell trip-shell">
        <div className="trip-hero"><SafeImg src={tripImage} alt={trip.destination} fill /><div className="trip-hero-overlay" /><div className="trip-hero-label"><p>Live trip · {trip.destination}</p><h2>Your trip to {trip.destination}</h2></div></div>
        <div className="page-heading"><div><p className="text-sm text-white/85">{trip.origin ? `${trip.origin} → ${trip.destination} · ` : ''}{fmt(trip.startDate)} – {fmt(trip.endDate)} · {days.length} days</p></div>{accessToggle}</div>
        {rain && <div className="live-strip"><div className="flex items-center gap-3"><div className="weather-icon"><CloudRain className="size-5" /></div><div><p className="text-sm font-semibold text-foreground">Rain expected</p><p className="mt-0.5 text-xs text-muted-foreground">Live weather for {trip.destination}</p></div></div><div className="hidden h-8 w-px bg-border sm:block" /><div className="flex-1 text-sm text-muted-foreground">Consider indoor alternatives for outdoor stops.</div></div>}
        {accessibility && <div className="accessibility-banner"><Accessibility className="size-4" />Reordered for accessibility <span>Step-free venues are prioritized without removing the rest of your plan.</span></div>}
        <div className="trip-layout">
          <section className="itinerary-column">{dayTabs}<div className="itinerary-content"><div className="flex items-baseline justify-between"><div><p className="eyebrow-light">Live itinerary · {days[day].date}</p><h2 className="mt-2 font-serif text-3xl font-normal tracking-[-0.01em] text-white">Follow the feeling.</h2></div><div className="live-label"><span className="status-dot" />Live</div></div><div className="mt-8"><Timeline stops={days[day].stops} selected={selected} setSelected={setSelected} accessible={accessibility} /></div></div></section>
          <aside className="trip-side">
            <div className="trip-card"><p className="eyebrow">Trip summary</p><div className="mt-4 flex items-end justify-between"><span className="text-4xl font-semibold tracking-[-0.04em] text-foreground">{days.reduce((n, d) => n + d.stops.length, 0)}<span className="ml-1 text-base font-medium text-muted-foreground">stops</span></span><span className="text-xs text-success">{days.length} days</span></div></div>
            {trip.travel && <div className="trip-card"><p className="text-sm font-semibold text-foreground">Getting there</p><p className="mt-3 text-sm leading-6 text-muted-foreground">{trip.origin} → {trip.destination}<br />{trip.travel.mode} · about {trip.travel.km.toLocaleString('en-IN')} km<br />Round trip ≈ {inr(trip.travel.lo)}–{inr(trip.travel.hi)}</p></div>}
            <div className="trip-card"><p className="text-sm font-semibold text-foreground">Your preferences</p><p className="mt-3 text-sm leading-6 text-muted-foreground">Budget ₹{trip.budget.toLocaleString('en-IN')}<br />{trip.interests.join(' · ') || 'No interests selected'}</p></div>
          </aside>
        </div>
      </div>}

      <GuideChat open={chatOpen} setOpen={setChatOpen} city={trip?.destination ?? destination} /></main>
  </>
}