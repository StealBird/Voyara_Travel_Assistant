'use client'

import { useMemo, useState } from 'react'
import {
  Accessibility,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  CloudRain,
  Coffee,
  Compass,
  ExternalLink,
  Globe2,
  Heart,
  House,
  Leaf,
  MapPin,
  MessageCircle,
  Moon,
  Mountain,
  Navigation,
  Sparkles,
  TrainFront,
  Utensils,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

const days = [
  {
    id: 1,
    label: 'Day 1',
    date: 'Oct 14',
    stops: [
      { time: '09:00', name: 'Fushimi Inari Taisha', category: 'Sight', icon: Mountain, image: 'https://images.unsplash.com/photo-1478436127897-769e1b3f0f36?w=800&q=80', description: 'Sacred mountain trail through thousands of vermilion torii gates.', badge: 'Rain-safe alternative available', insights: ['Quiet in mornings', 'Easy train access', 'Great photo opportunities'], travel: '7 min by train from Kyoto Station' },
      { time: '12:30', name: 'Nishiki Market', category: 'Food', icon: Utensils, image: 'https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=800&q=80', description: 'A lively five-block arcade filled with Kyoto flavors and craft.', badge: 'Best for grazing', insights: ['Local favorite for lunch', 'Try the yuba croquettes', 'Crowded after 1 PM'], travel: '18 min on foot' },
      { time: '15:00', name: 'Kiyomizu-dera', category: 'Culture', icon: Compass, image: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800&q=80', description: 'A hillside temple with sweeping views across the old city.', badge: 'Golden hour pick', insights: ['Step-free route via west gate', 'Long queues after 2 PM', 'Panoramic city views'], travel: '12 min by taxi' },
      { time: '18:30', name: 'Gion & Pontocho', category: 'Evening', icon: Moon, image: 'https://images.unsplash.com/photo-1524413840807-0c3cb6fa808d?w=800&q=80', description: 'Lantern-lit lanes, intimate teahouses, and an unhurried dinner.', badge: 'Reserve ahead', insights: ['Atmospheric after sunset', 'Small groups feel best', 'Great yakitori nearby'], travel: '15 min by bus' },
    ],
  },
  {
    id: 2,
    label: 'Day 2',
    date: 'Oct 15',
    stops: [
      { time: '08:30', name: 'Arashiyama Bamboo Grove', category: 'Nature', icon: Leaf, image: 'https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=800&q=80', description: 'Walk beneath soaring bamboo before the crowds arrive.', badge: 'Early start recommended', insights: ['Quietest before 9 AM', 'Mostly flat approach', 'Pair with Tenryu-ji'], travel: '22 min by train' },
      { time: '11:30', name: 'Tenryu-ji Temple', category: 'Culture', icon: House, image: 'https://images.unsplash.com/photo-1545569341-9eb8b30979d9?w=800&q=80', description: 'Zen gardens framed by the Arashiyama mountains.', badge: 'Garden highlight', insights: ['Peaceful garden paths', 'Seating throughout', 'Beautiful fall colors'], travel: '4 min on foot' },
      { time: '14:00', name: 'Philosopher’s Path', category: 'Walk', icon: Navigation, image: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800&q=80', description: 'A gentle canal-side stroll linking quiet temples and cafés.', badge: 'Slow afternoon', insights: ['Flat, shaded route', 'Cafés along the way', 'Best with an hour spare'], travel: '35 min by bus' },
      { time: '19:00', name: 'Pontocho Dinner', category: 'Food', icon: Utensils, image: 'https://images.unsplash.com/photo-1524413840807-0c3cb6fa808d?w=800&q=80', description: 'A thoughtful kaiseki dinner in one of Kyoto’s narrowest lanes.', badge: 'Reservation confirmed', insights: ['Intimate atmosphere', 'Counter seating available', 'Seasonal tasting menu'], travel: '12 min by train' },
    ],
  },
  {
    id: 3,
    label: 'Day 3',
    date: 'Oct 16',
    stops: [
      { time: '10:00', name: 'Kyoto Station', category: 'Explore', icon: TrainFront, image: 'https://images.unsplash.com/photo-1492571350019-22de08371fd3?w=800&q=80', description: 'Modern architecture, rooftop gardens, and a final local breakfast.', badge: 'Easy morning', insights: ['Step-free throughout', 'Luggage lockers available', 'Great coffee on 15F'], travel: 'Walk from hotel' },
      { time: '12:30', name: 'Kyoto Railway Museum', category: 'Indoor', icon: TrainFront, image: 'https://images.unsplash.com/photo-1549693578-d683be217e58?w=800&q=80', description: 'A tactile, joyful look at Japan’s engineering history.', badge: 'Weather-proof', insights: ['Excellent rainy-day plan', 'Wide accessible galleries', 'Interactive exhibits'], travel: '10 min by train' },
      { time: '15:30', name: 'Ninenzaka', category: 'Shopping', icon: Heart, image: 'https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=800&q=80', description: 'Browse considered souvenirs along Kyoto’s most charming slope.', badge: 'Take it slow', insights: ['Independent craft shops', 'Best before 5 PM', 'Some uneven paving'], travel: '14 min by taxi' },
      { time: '18:00', name: 'Kamo River', category: 'Evening', icon: Leaf, image: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800&q=80', description: 'A soft landing beside the river before your journey home.', badge: 'Sunset stroll', insights: ['Open views and fresh air', 'Benches along the bank', 'Lovely at dusk'], travel: '9 min on foot' },
    ],
  },
]

type Stop = (typeof days)[number]['stops'][number]

function Logo() {
  return <div className="flex items-center gap-2.5"><div className="flex size-8 items-center justify-center rounded-xl bg-[#1a2f5c] text-[#faf9f6]"><Compass className="size-4" strokeWidth={2.2} /></div><span className="font-semibold tracking-[-0.03em] text-[#1a2f5c]">Voyara</span></div>
}

function PlanningPanel({ accessibility, setAccessibility, generating, onGenerate }: { accessibility: boolean; setAccessibility: (value: boolean) => void; generating: boolean; onGenerate: () => void }) {
  const [budget, setBudget] = useState(75000)
  const [interests, setInterests] = useState(['Culture', 'Food', 'Nature'])
  const choices = ['Culture', 'Food', 'Nature', 'Nightlife', 'Adventure']
  return <aside className="flex flex-col gap-7 lg:pr-5">
    <div><p className="eyebrow">Your next chapter</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] text-[#1a2f5c]">Plan your trip</h1><p className="mt-2 max-w-xs text-sm leading-6 text-[#687080]">Shape a few details and we’ll make the rest feel effortless.</p></div>
    <div className="flex flex-col gap-5">
      <label className="field-label">Destination<span className="field-value mt-2"><MapPin className="size-4 text-[#c9660a]" />Kyoto, Japan</span></label>
      <label className="field-label">Dates<span className="field-value mt-2"><Clock3 className="size-4 text-[#c9660a]" />Oct 14 – Oct 17<ChevronDown className="ml-auto size-4 text-[#98a0aa]" /></span></label>
      <div><div className="flex items-center justify-between"><label className="field-label">Budget</label><span className="text-sm font-semibold text-[#1a2f5c]">₹{budget.toLocaleString('en-IN')}</span></div><input aria-label="Trip budget" type="range" min="35000" max="150000" step="5000" value={budget} onChange={(event) => setBudget(Number(event.target.value))} className="budget-slider mt-4 w-full" /><div className="mt-2 flex justify-between text-[11px] text-[#98a0aa]"><span>Essentials</span><span className="font-medium text-[#687080]">Comfortable</span><span>Elevated</span></div></div>
      <div><p className="field-label">Interests</p><div className="mt-3 flex flex-wrap gap-2">{choices.map((choice) => { const selected = interests.includes(choice); return <button key={choice} type="button" onClick={() => setInterests(selected ? interests.filter((item) => item !== choice) : [...interests, choice])} className={`interest-chip ${selected ? 'interest-chip-active' : ''}`}>{selected && <Check className="size-3" />}{choice}</button> })}</div></div>
      <div className={`accessibility-control ${accessibility ? 'accessibility-on' : ''}`}><div className="flex items-start gap-3"><div className="icon-well"><Accessibility className="size-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-[#1a2f5c]">Accessibility needs</p><p className="mt-1 text-xs leading-5 text-[#7a8290]">Wheelchair access, medical proximity, low-mobility routing.</p>{accessibility && <p className="mt-2 text-xs font-medium text-[#597a68]">Your route will prioritize step-free options.</p>}</div><button type="button" aria-label="Toggle accessibility needs" aria-pressed={accessibility} onClick={() => setAccessibility(!accessibility)} className={`toggle ${accessibility ? 'toggle-on' : ''}`}><span /></button></div></div>
    </div>
    <Button onClick={onGenerate} disabled={generating} className="h-12 w-full rounded-xl bg-[#c9660a] text-white shadow-[0_8px_22px_-10px_rgba(201,102,10,.8)] hover:bg-[#b85a06]">{generating ? <><span className="loading-dot" />Building your itinerary…</> : <>Generate Itinerary <ArrowRight data-icon="inline-end" /></>}</Button>
    <p className="text-center text-[11px] leading-5 text-[#98a0aa]">Your preferences are used to build a thoughtful first draft.</p>
  </aside>
}

function Timeline({ stops, selected, setSelected, live, accessible }: { stops: Stop[]; selected: string; setSelected: (name: string) => void; live?: boolean; accessible?: boolean }) {
  const visibleStops = accessible ? [...stops].sort((a, b) => (a.name.includes('Station') ? -1 : b.name.includes('Station') ? 1 : 0)) : stops
  return <div className="timeline">{visibleStops.map((stop, index) => { const Icon = stop.icon; const isSelected = selected === stop.name; const updated = live && index === 1; return <button key={stop.name} type="button" onClick={() => setSelected(stop.name)} className={`timeline-row ${isSelected ? 'timeline-row-selected' : ''} ${updated ? 'timeline-row-updated' : ''}`}><div className="timeline-time">{stop.time}</div><div className="timeline-marker-wrap"><div className={`timeline-marker ${isSelected ? 'timeline-marker-selected' : ''} ${updated ? 'timeline-marker-updated' : ''}`}><Icon className="size-4" /></div>{index < visibleStops.length - 1 && <div className="timeline-line" />}</div><div className="timeline-stop-content"><div className="timeline-thumb-wrap"><img src={stop.image} alt={`${stop.name} in Kyoto`} className="timeline-thumb" /><span className="timeline-thumb-badge"><Icon className="size-3" /></span></div><div className="min-w-0 flex-1 pb-8 text-left"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[17px] font-semibold tracking-[-0.02em] text-[#1a2f5c]">{updated ? 'Kyoto Railway Museum' : stop.name}</h3>{updated ? <span className="update-badge"><CloudRain className="size-3" />Updated</span> : <span className="category-label">{stop.category}</span>}</div><p className="mt-1.5 max-w-xl text-sm leading-6 text-[#687080]">{updated ? 'Indoor alternative selected because of expected rain.' : stop.description}</p>{updated && <p className="mt-2 text-xs text-[#9a8a78] line-through">Fushimi Inari Taisha · outdoor trail</p>}<div className="mt-3 flex items-center gap-2 text-xs text-[#98a0aa]"><TrainFront className="size-3.5" />{stop.travel}</div></div></div></button> })}</div>
}

function Intelligence({ stop }: { stop: Stop }) { return <aside className="intelligence-panel"><div className="flex items-center justify-between"><div className="icon-well"><Sparkles className="size-4 text-[#c9660a]" /></div><span className="text-[11px] font-medium text-[#98a0aa]">Recent feedback</span></div><img src={stop.image} alt={`${stop.name} in Kyoto`} className="intelligence-image" /><p className="mt-5 text-xs font-semibold uppercase tracking-[0.14em] text-[#9a8a78]">Why this place</p><h2 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-[#1a2f5c]">{stop.name}</h2><div className="mt-5 flex flex-col gap-3">{stop.insights.map((insight, index) => <div key={insight} className="flex items-start gap-2.5 text-sm leading-5 text-[#687080]"><span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${index === 1 ? 'bg-[#f8eee7] text-[#c9660a]' : 'bg-[#e8f1eb] text-[#597a68]'}`}>{index === 1 ? '!' : <Check className="size-3" />}</span>{insight}</div>)}</div><div className="mt-7 border-t border-[#e9e5dc] pt-4"><p className="text-[11px] leading-5 text-[#98a0aa]">Synthesized from recent traveler feedback, local guides, and accessibility notes.</p></div></aside> }

function GuideChat({ open, setOpen }: { open: boolean; setOpen: (value: boolean) => void }) { const [language, setLanguage] = useState('English'); return <div className="guide-wrap">{open && <section className="guide-panel" aria-label="Local guide chat"><div className="flex items-center justify-between border-b border-[#ebe7df] px-5 py-4"><div><p className="text-sm font-semibold text-[#1a2f5c]">Ask your local guide</p><p className="mt-1 text-xs text-[#98a0aa]">Usually replies in a few seconds</p></div><button type="button" onClick={() => setOpen(false)} aria-label="Close guide"><X className="size-4 text-[#687080]" /></button></div><div className="flex flex-col gap-4 p-5"><div className="self-end rounded-2xl rounded-br-md bg-[#f1eee8] px-3.5 py-2.5 text-sm text-[#4c5666]">Do I need to reserve train tickets for tomorrow?</div><div className="rounded-2xl rounded-bl-md bg-[#eef2f7] px-3.5 py-3 text-sm leading-6 text-[#4c5666]">For most local Kyoto trains, no advance reservation is needed. For reserved-seat services such as the Shinkansen, booking ahead is recommended.</div><div className="flex items-center justify-between border-t border-[#ebe7df] pt-4"><select value={language} onChange={(event) => setLanguage(event.target.value)} className="bg-transparent text-xs font-medium text-[#687080] outline-none"><option>English</option><option>Hindi</option><option>Japanese</option><option>Spanish</option></select><Globe2 className="size-4 text-[#98a0aa]" /></div></div></section>}<button type="button" onClick={() => setOpen(!open)} aria-label={open ? 'Close local guide' : 'Open local guide'} className="guide-button">{open ? <X className="size-5" /> : <MessageCircle className="size-5" />}<span className="guide-ping" /></button></div> }

export default function Page() {
  const [activePage, setActivePage] = useState<'plan' | 'trip'>('plan')
  const [day, setDay] = useState(0)
  const [selected, setSelected] = useState(days[0].stops[0].name)
  const [accessibility, setAccessibility] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState(true)
  const [showChange, setShowChange] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  const selectedStop = useMemo(() => days[day].stops.find((stop) => stop.name === selected) ?? days[day].stops[0], [day, selected])
  const handleGenerate = () => { setGenerating(true); setTimeout(() => { setGenerating(false); setGenerated(true) }, 900) }
  const switchDay = (index: number) => { setDay(index); setSelected(days[index].stops[0].name) }
  return <main className="voyara-app"><header className="topbar"><Logo /><nav className="main-nav" aria-label="Main navigation"><button type="button" className={activePage === 'plan' ? 'nav-item nav-item-active' : 'nav-item'} onClick={() => setActivePage('plan')}>Plan</button><button type="button" className={activePage === 'trip' ? 'nav-item nav-item-active' : 'nav-item'} onClick={() => setActivePage('trip')}>My Trip</button></nav><div className="ml-auto flex items-center gap-3"><span className="hidden text-xs text-[#98a0aa] sm:block">Kyoto · Oct 14–17</span><div className="avatar">AS</div></div></header>
    {activePage === 'plan' ? <div className="page-shell"><div className="destination-hero"><img src="https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=1800&q=85" alt="Traditional Kyoto temple and autumn foliage" /><div className="destination-hero-overlay" /><h1>Kyoto, thoughtfully arranged.</h1></div><div className="planning-grid"><PlanningPanel accessibility={accessibility} setAccessibility={setAccessibility} generating={generating} onGenerate={handleGenerate} /><section className="itinerary-column"><div className="day-tabs" role="tablist" aria-label="Trip days">{days.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={day === index} onClick={() => switchDay(index)} className={`day-tab ${day === index ? 'day-tab-active' : ''}`}><span>{item.label}</span><small>{item.date}</small></button>)}</div>{generated ? <div className="itinerary-content"><div className="flex items-baseline justify-between"><div><p className="eyebrow">{days[day].date} · 4 stops</p><h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[#1a2f5c]">A gentle beginning</h2></div><button type="button" className="icon-link"><ExternalLink className="size-4" />Share</button></div><div className="mt-8"><Timeline stops={days[day].stops} selected={selected} setSelected={setSelected} accessible={accessibility} /></div></div> : <div className="empty-itinerary"><Sparkles className="size-6 text-[#c9660a]" /><h2 className="mt-4 text-xl font-semibold text-[#1a2f5c]">Your route is ready when you are.</h2></div>}</section><Intelligence stop={selectedStop} /></div></div> : <div className="page-shell trip-shell"><div className="trip-hero"><img src="https://images.unsplash.com/photo-1524413840807-0c3cb6fa808d?w=1600&q=85" alt="Kyoto street in early morning light" /><div className="trip-hero-overlay" /><div className="trip-hero-label"><p>Live trip · Kyoto</p><h2>Good morning, Anika.</h2></div></div><div className="page-heading"><div><p className="text-sm text-[#687080]">Tuesday, October 15 · Day 2 of 3</p></div><div className="accessibility-top"><Accessibility className="size-4" /><span>Accessibility Mode</span><button type="button" aria-label="Toggle accessibility mode" aria-pressed={accessibility} onClick={() => setAccessibility(!accessibility)} className={`toggle ${accessibility ? 'toggle-on' : ''}`}><span /></button></div></div><div className="live-strip"><div className="flex items-center gap-3"><div className="weather-icon"><CloudRain className="size-5" /></div><div><p className="text-sm font-semibold text-[#1a2f5c]">Rain expected at 3 PM</p><p className="mt-0.5 text-xs text-[#7a8290]">24°C · Light showers</p></div></div><div className="hidden h-8 w-px bg-[#e6d9ca] sm:block" /><div className="flex-1 text-sm text-[#687080]">Indoor alternative suggested for your afternoon visit.</div><button type="button" onClick={() => setShowChange(!showChange)} className="live-link">{showChange ? 'Hide change' : 'View change'} <ArrowRight className="size-3.5" /></button></div>{accessibility && <div className="accessibility-banner"><Accessibility className="size-4" />Reordered for accessibility <span>Step-free venues are prioritized without removing the rest of your plan.</span></div>}<div className="trip-layout"><section className="itinerary-column"><div className="day-tabs" role="tablist" aria-label="Trip days">{days.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={day === index} onClick={() => switchDay(index)} className={`day-tab ${day === index ? 'day-tab-active' : ''}`}><span>{item.label}</span><small>{item.date}</small></button>)}</div><div className="itinerary-content"><div className="flex items-baseline justify-between"><div><p className="eyebrow">Live itinerary · {days[day].date}</p><h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[#1a2f5c]">Follow the feeling.</h2></div><div className="live-label"><span className="status-dot" />Live</div></div><div className="mt-8"><Timeline stops={days[day].stops} selected={selected} setSelected={setSelected} live={showChange && day === 0} accessible={accessibility} /></div></div></section><aside className="trip-side"><div className="trip-card"><p className="eyebrow">Today’s rhythm</p><div className="mt-4 flex items-end justify-between"><span className="text-4xl font-semibold tracking-[-0.06em] text-[#1a2f5c]">6.2<span className="ml-1 text-base font-medium text-[#98a0aa]">km</span></span><span className="text-xs text-[#597a68]">Comfortable pace</span></div><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#e9e5dc]"><div className="h-full w-[58%] rounded-full bg-[#597a68]" /></div><div className="mt-3 flex justify-between text-[11px] text-[#98a0aa]"><span>2 stops complete</span><span>4 stops</span></div></div><div className="trip-card"><div className="flex items-center gap-2"><Coffee className="size-4 text-[#c9660a]" /><p className="text-sm font-semibold text-[#1a2f5c]">A local note</p></div><p className="mt-3 text-sm leading-6 text-[#687080]">The small café on the corner of Hanamikoji opens at 10. Their hojicha latte is worth the detour.</p></div></aside></div></div>}
    <GuideChat open={chatOpen} setOpen={setChatOpen} /></main>
}
