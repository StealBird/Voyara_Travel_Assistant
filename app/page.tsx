'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Accessibility,
  ArrowRight,
  Check,
  Clock3,
  CloudRain,
  Compass,
  ExternalLink,
  Globe2,
  MapPin,
  MessageCircle,
  Moon,
  Mountain,
  Sparkles,
  TrainFront,
  Utensils,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { generateItinerary, getWeather, getPlaceImages, askGuide } from '@/lib/api'

type Stop = { time: string; name: string; category: string; icon: LucideIcon; image: string; description: string; badge: string; insights: string[]; travel: string }
type Day = { id: number; label: string; date: string; stops: Stop[] }
type Trip = { destination: string; startDate: string; endDate: string; budget: number; interests: string[] }

const ICONS = [Compass, Utensils, Mountain, Moon]
const QUICK_PICKS = ['Kyoto', 'Goa', 'Paris', 'Jaipur']
const MAX_DAYS = 30
const CHUNK = 5

const titleCase = (s: string) => s.trim().replace(/\b\w/g, (c) => c.toUpperCase())

// One batched Wikipedia call per 50 titles. Returns { originalTitle: imageUrl }.
// Now used only for the destination banners (hero + trip hero).
async function wikiImages(titles: string[], width: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const uniq = [...new Set(titles.map((t) => t.trim()).filter(Boolean))]
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50)
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=${width}&titles=${encodeURIComponent(batch.join('|'))}`
      const res = await fetch(url)
      if (!res.ok) continue
      const q = (await res.json())?.query
      const byTitle: Record<string, string> = {}
      ;(Object.values(q?.pages ?? {}) as any[]).forEach((p) => { if (p.thumbnail?.source) byTitle[p.title] = p.thumbnail.source })
      batch.forEach((t) => {
        const n = (q?.normalized ?? []).find((x: any) => x.from === t)?.to ?? t
        const r = (q?.redirects ?? []).find((x: any) => x.from === n)?.to ?? n
        if (byTitle[r]) out[t] = byTitle[r]
      })
    } catch {}
  }
  return out
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
    stops: (d.stops ?? d.activities ?? []).map((s: any, j: number) => ({
      time: s.time ?? '',
      name: s.name ?? s.title ?? 'Stop',
      category: s.category ?? 'Sight',
      icon: ICONS[j % ICONS.length],
      image: '',
      description: s.description ?? '',
      badge: s.badge ?? '',
      insights: s.insights ?? ['Popular with travelers', 'Check opening hours', 'Matches your interests'],
      travel: s.travel ?? '',
    })),
  }))
}

function Logo() {
  return <div className="flex items-center gap-2.5"><div className="flex size-8 items-center justify-center rounded-xl bg-foreground text-background"><Compass className="size-4" strokeWidth={2.2} /></div><span className="font-semibold tracking-[-0.03em] text-foreground">Voyara</span></div>
}

type PanelProps = {
  accessibility: boolean; setAccessibility: (v: boolean) => void
  generating: boolean; canGenerate: boolean; onGenerate: () => void
  budget: number; setBudget: (v: number) => void
  interests: string[]; setInterests: (v: string[]) => void
  destination: string; setDestination: (v: string) => void
  startDate: string; setStartDate: (v: string) => void
  endDate: string; setEndDate: (v: string) => void
  tripLength: number
}

function PlanningPanel(p: PanelProps) {
  const choices = ['Culture', 'Food', 'Nature', 'Nightlife', 'Adventure']
  const today = new Date().toISOString().slice(0, 10)
  const tooLong = p.tripLength > MAX_DAYS
  const badRange = p.startDate !== '' && p.endDate !== '' && p.tripLength < 1
  return <section className="mx-auto flex w-full max-w-3xl flex-col gap-7 rounded-2xl border border-border bg-card p-6 sm:p-8">
    <div><p className="eyebrow">Your next chapter</p><h1 className="mt-2 font-serif text-4xl font-normal tracking-[-0.01em] text-foreground">Plan your trip</h1><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">Shape a few details and we’ll make the rest feel effortless.</p></div>
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <label className="field-label">Destination<span className="field-value mt-2"><MapPin className="size-4 shrink-0 text-brand" /><input value={p.destination} onChange={(e) => p.setDestination(e.target.value)} placeholder="Where to?" className="w-full bg-transparent outline-none" /></span></label>
        <div className="mt-2 flex flex-wrap gap-2">{QUICK_PICKS.map((c) => <button key={c} type="button" onClick={() => p.setDestination(c)} className={`interest-chip ${p.destination === c ? 'interest-chip-active' : ''}`}>{c}</button>)}</div>
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
      <div><p className="field-label">Interests</p><div className="mt-3 flex flex-wrap gap-2">{choices.map((choice) => { const selected = p.interests.includes(choice); return <button key={choice} type="button" onClick={() => p.setInterests(selected ? p.interests.filter((i) => i !== choice) : [...p.interests, choice])} className={`interest-chip ${selected ? 'interest-chip-active' : ''}`}>{selected && <Check className="size-3" />}{choice}</button> })}</div></div>
    </div>
    <div className={`accessibility-control ${p.accessibility ? 'accessibility-on' : ''}`}><div className="flex items-start gap-3"><div className="icon-well"><Accessibility className="size-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">Accessibility needs</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Wheelchair access, medical proximity, low-mobility routing.</p>{p.accessibility && <p className="mt-2 text-xs font-medium text-success">Your route will prioritize step-free options.</p>}</div><button type="button" aria-label="Toggle accessibility needs" aria-pressed={p.accessibility} onClick={() => p.setAccessibility(!p.accessibility)} className={`toggle ${p.accessibility ? 'toggle-on' : ''}`}><span /></button></div></div>
    <div>
      <Button onClick={p.onGenerate} disabled={p.generating || !p.canGenerate} className="h-12 w-full">{p.generating ? <><span className="loading-dot" />Building your itinerary…</> : <>Generate Itinerary <ArrowRight data-icon="inline-end" /></>}</Button>
      <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">{p.canGenerate ? 'Your preferences are used to build a thoughtful first draft.' : 'Pick a destination, dates and budget to get started.'}</p>
    </div>
  </section>
}

function Timeline({ stops, selected, setSelected, accessible }: { stops: Stop[]; selected: string; setSelected: (name: string) => void; accessible?: boolean }) {
  const visibleStops = accessible ? [...stops].sort((a, b) => (a.name.includes('Station') ? -1 : b.name.includes('Station') ? 1 : 0)) : stops
  return <div className="timeline">{visibleStops.map((stop, index) => { const Icon = stop.icon; const isSelected = selected === stop.name; return <button key={stop.name + index} type="button" onClick={() => setSelected(stop.name)} className={`timeline-row ${isSelected ? 'timeline-row-selected' : ''}`}><div className="timeline-time">{stop.time}</div><div className="timeline-marker-wrap"><div className={`timeline-marker ${isSelected ? 'timeline-marker-selected' : ''}`}><Icon className="size-4" /></div>{index < visibleStops.length - 1 && <div className="timeline-line" />}</div><div className="timeline-stop-content"><div className="timeline-thumb-wrap"><SafeImg src={stop.image} alt={stop.name} className="timeline-thumb" /><span className="timeline-thumb-badge"><Icon className="size-3" /></span></div><div className="min-w-0 flex-1 pb-8 text-left"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">{stop.name}</h3><span className="category-label">{stop.category}</span></div><p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">{stop.description}</p>{stop.travel && <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><TrainFront className="size-3.5" />{stop.travel}</div>}</div></div></button> })}</div>
}

function Intelligence({ stop }: { stop?: Stop }) {
  if (!stop) return <aside className="intelligence-panel"><div className="icon-well"><Sparkles className="size-4" /></div><p className="mt-5 text-sm leading-6 text-muted-foreground">Pick any stop to see why it fits.</p></aside>
  return <aside className="intelligence-panel"><div className="flex items-center justify-between"><div className="icon-well"><Sparkles className="size-4" /></div><span className="text-xs font-medium text-muted-foreground">Recent feedback</span></div><SafeImg src={stop.image} alt={stop.name} className="intelligence-image" /><p className="mt-5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Why this place</p><h2 className="mt-2 font-serif text-2xl font-normal text-foreground">{stop.name}</h2><div className="mt-5 flex flex-col gap-3">{stop.insights.map((insight, index) => <div key={insight} className="flex items-start gap-2.5 text-sm leading-5 text-muted-foreground"><span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${index === 1 ? 'bg-brand-soft text-brand-strong' : 'bg-success-soft text-success'}`}>{index === 1 ? '!' : <Check className="size-3" />}</span>{insight}</div>)}</div><div className="mt-7 border-t border-border pt-4"><p className="text-xs leading-5 text-muted-foreground">Synthesized from recent traveler feedback, local guides, and accessibility notes.</p></div></aside>
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
  const [activePage, setActivePage] = useState<'plan' | 'trip'>('plan')
  const [days, setDays] = useState<Day[]>([])
  const [trip, setTrip] = useState<Trip | null>(null)
  const [editing, setEditing] = useState(false)
  const [day, setDay] = useState(0)
  const [selected, setSelected] = useState('')
  const [accessibility, setAccessibility] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [destination, setDestination] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [budget, setBudget] = useState(75000)
  const [interests, setInterests] = useState(['Culture', 'Food', 'Nature'])
  const [rain, setRain] = useState(false)
  const [error, setError] = useState('')
  const [heroImage, setHeroImage] = useState('')
  const [tripImage, setTripImage] = useState('')
  const genId = useRef(0)

  const tripLength = countDays(startDate, endDate)
  const generated = trip !== null && days.length > 0
  const canGenerate = destination.trim() !== '' && tripLength >= 1 && tripLength <= MAX_DAYS && budget > 0
  const selectedStop = useMemo(() => days[day]?.stops.find((s) => s.name === selected) ?? days[day]?.stops[0], [days, day, selected])

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
      const chunks: { i: number; len: number }[] = []
      for (let i = 0; i < total; i += CHUNK) chunks.push({ i, len: Math.min(CHUNK, total - i) })

      const weatherPromise = getWeather(dest).catch(() => null)
      const plans = await Promise.all(chunks.map(({ i, len }) => generateItinerary({
        destination: dest,
        start_date: addDays(startDate, i),
        end_date: addDays(startDate, i + len - 1),
        days: len,
        interests,
        budget: Math.round((budget * len) / total),
        accessibility,
      })))
      const weather = await weatherPromise

      const mapped = toDays({ days: plans.flatMap((p) => p?.days ?? []) }, startDate).filter((d) => d.stops.length > 0)
      if (!mapped.length) throw new Error('empty plan')
      setDays(mapped)
      setDay(0)
      setSelected(mapped[0].stops[0].name)
      setTrip({ destination: dest, startDate, endDate, budget, interests })
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

  const accessToggle = <div className="flex items-center gap-2 text-sm text-muted-foreground"><Accessibility className="size-4" /><span>Accessibility</span><button type="button" aria-label="Toggle accessibility mode" aria-pressed={accessibility} onClick={() => setAccessibility(!accessibility)} className={`toggle ${accessibility ? 'toggle-on' : ''}`}><span /></button></div>

  return <main className="voyara-app"><header className="topbar"><Logo /><nav className="main-nav" aria-label="Main navigation"><button type="button" className={activePage === 'plan' ? 'nav-item nav-item-active' : 'nav-item'} onClick={() => setActivePage('plan')}>Plan</button><button type="button" className={activePage === 'trip' ? 'nav-item nav-item-active' : 'nav-item'} onClick={() => setActivePage('trip')}>My Trip</button></nav><div className="ml-auto flex items-center gap-3">{trip && <span className="hidden text-xs text-muted-foreground sm:block">{trip.destination} · {fmt(trip.startDate)}–{fmt(trip.endDate)}</span>}<div className="avatar">AS</div></div></header>

    {activePage === 'plan' ? <div className="page-shell">
      <div className="destination-hero">
        <SafeImg src={heroImage} alt={destination || 'Destination'} fill />
        <div className="destination-hero-overlay" />
        <h1>{destination.trim() ? `${destination.trim()}, thoughtfully arranged.` : 'Somewhere new, thoughtfully arranged.'}</h1>
      </div>
      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {!generated || editing ? <>
        {generated && <button type="button" onClick={() => setEditing(false)} className="icon-link mb-4">← Back to itinerary</button>}
        <PlanningPanel accessibility={accessibility} setAccessibility={setAccessibility} generating={generating} canGenerate={canGenerate} onGenerate={handleGenerate} budget={budget} setBudget={setBudget} interests={interests} setInterests={setInterests} destination={destination} setDestination={setDestination} startDate={startDate} setStartDate={setStartDate} endDate={endDate} setEndDate={setEndDate} tripLength={tripLength} />
      </> : trip && <>
        <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground"><MapPin className="size-4 text-brand" />{trip.destination}</div>
          <span className="text-sm text-muted-foreground">{fmt(trip.startDate)} – {fmt(trip.endDate)} · {days.length} days</span>
          <span className="text-sm text-muted-foreground">₹{trip.budget.toLocaleString('en-IN')}</span>
          {accessToggle}
          <button type="button" onClick={() => setEditing(true)} className="icon-link ml-auto">Edit trip</button>
        </div>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="itinerary-column">
            {dayTabs}
            <div className="itinerary-content"><div className="flex items-baseline justify-between"><div><p className="eyebrow">{days[day].date} · {days[day].stops.length} stops</p><h2 className="mt-2 font-serif text-3xl font-normal tracking-[-0.01em] text-foreground">Day {day + 1} in {trip.destination}</h2></div><button type="button" className="icon-link"><ExternalLink className="size-4" />Share</button></div><div className="mt-8"><Timeline stops={days[day].stops} selected={selected} setSelected={setSelected} accessible={accessibility} /></div></div>
          </section>
          <Intelligence stop={selectedStop} />
        </div>
      </>}
    </div>

    : !generated || !trip ? <div className="page-shell trip-shell"><div className="empty-itinerary"><Compass className="mx-auto size-6 text-brand" /><h2 className="mt-4 font-serif text-2xl font-normal text-foreground">No trip yet</h2><p className="mt-2 text-sm text-muted-foreground">Plan one first and it will show up here.</p><Button onClick={() => setActivePage('plan')} className="mt-5">Go to Plan</Button></div></div>

    : <div className="page-shell trip-shell">
      <div className="trip-hero"><SafeImg src={tripImage} alt={trip.destination} fill /><div className="trip-hero-overlay" /><div className="trip-hero-label"><p>Live trip · {trip.destination}</p><h2>Your trip to {trip.destination}</h2></div></div>
      <div className="page-heading"><div><p className="text-sm text-muted-foreground">{fmt(trip.startDate)} – {fmt(trip.endDate)} · {days.length} days</p></div>{accessToggle}</div>
      {rain && <div className="live-strip"><div className="flex items-center gap-3"><div className="weather-icon"><CloudRain className="size-5" /></div><div><p className="text-sm font-semibold text-foreground">Rain expected</p><p className="mt-0.5 text-xs text-muted-foreground">Live weather for {trip.destination}</p></div></div><div className="hidden h-8 w-px bg-border sm:block" /><div className="flex-1 text-sm text-muted-foreground">Consider indoor alternatives for outdoor stops.</div></div>}
      {accessibility && <div className="accessibility-banner"><Accessibility className="size-4" />Reordered for accessibility <span>Step-free venues are prioritized without removing the rest of your plan.</span></div>}
      <div className="trip-layout">
        <section className="itinerary-column">{dayTabs}<div className="itinerary-content"><div className="flex items-baseline justify-between"><div><p className="eyebrow">Live itinerary · {days[day].date}</p><h2 className="mt-2 font-serif text-3xl font-normal tracking-[-0.01em] text-foreground">Follow the feeling.</h2></div><div className="live-label"><span className="status-dot" />Live</div></div><div className="mt-8"><Timeline stops={days[day].stops} selected={selected} setSelected={setSelected} accessible={accessibility} /></div></div></section>
        <aside className="trip-side">
          <div className="trip-card"><p className="eyebrow">Trip summary</p><div className="mt-4 flex items-end justify-between"><span className="text-4xl font-semibold tracking-[-0.04em] text-foreground">{days.reduce((n, d) => n + d.stops.length, 0)}<span className="ml-1 text-base font-medium text-muted-foreground">stops</span></span><span className="text-xs text-success">{days.length} days</span></div></div>
          <div className="trip-card"><p className="text-sm font-semibold text-foreground">Your preferences</p><p className="mt-3 text-sm leading-6 text-muted-foreground">Budget ₹{trip.budget.toLocaleString('en-IN')}<br />{trip.interests.join(' · ') || 'No interests selected'}</p></div>
        </aside>
      </div>
    </div>}

    <GuideChat open={chatOpen} setOpen={setChatOpen} city={trip?.destination ?? destination} /></main>
}