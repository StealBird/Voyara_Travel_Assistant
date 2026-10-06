'use client'

import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export type MapPoint = { n: number; name: string; lat: number; lng: number }

// helpful places drawn under the numbered stops: where to sleep, medical help, bus/train/metro
export type ExtraPoint = {
  kind: string // stay | medical | emergency | transit
  sub: string // Hostel / dorm, Hospital, Bus stop...
  name: string
  lat: number
  lng: number
  picked?: boolean // the stay the traveller chose
}

// a move between two places (for example home country to the destination), drawn as an arc
export type Journey = {
  from: { lat: number; lng: number }
  to: { lat: number; lng: number }
  mode: string
  fromName: string
  toName: string
}

type Props = {
  points: MapPoint[]
  selected: string
  onSelect: (name: string) => void
  focusTick: number // goes up whenever the user picks a stop, so the camera flies there
  extras?: ExtraPoint[]
  journey?: Journey | null
}

const TOPO = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

// group, colour and letter for each kind of helpful place
const GROUPS = {
  stay: { label: 'Stays', color: '#2563EB' },
  medical: { label: 'Medical', color: '#DC2626' },
  transit: { label: 'Transit', color: '#475569' },
} as const
type Group = keyof typeof GROUPS

const groupOf = (kind: string): Group => (kind === 'emergency' ? 'medical' : (kind as Group))

// smooth curved route: every hop bends to alternating sides. returns [lat, lng] pairs
function curve(points: MapPoint[]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const dx = b.lng - a.lng
    const dy = b.lat - a.lat
    const len = Math.hypot(dx, dy) || 1e-9
    const bend = len * 0.22 * (i % 2 ? 1 : -1)
    const cx = (a.lng + b.lng) / 2 + (-dy / len) * bend
    const cy = (a.lat + b.lat) / 2 + (dx / len) * bend
    for (let k = 0; k <= 24; k++) {
      const t = k / 24
      const u = 1 - t
      out.push([u * u * a.lat + 2 * u * t * cy + t * t * b.lat, u * u * a.lng + 2 * u * t * cx + t * t * b.lng])
    }
  }
  return out
}

// great-circle arc from a to b as [lat, lng] pairs (longitudes stay continuous across the date line)
function arc(a: { lat: number; lng: number }, b: { lat: number; lng: number }, n = 64): [number, number][] {
  const r = Math.PI / 180
  const vec = (p: { lat: number; lng: number }) => [Math.cos(p.lat * r) * Math.cos(p.lng * r), Math.cos(p.lat * r) * Math.sin(p.lng * r), Math.sin(p.lat * r)]
  const va = vec(a)
  const vb = vec(b)
  const w = Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])))
  const s = Math.sin(w) || 1e-9
  const out: [number, number][] = []
  let prev = a.lng
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const ka = Math.sin((1 - t) * w) / s
    const kb = Math.sin(t * w) / s
    const x = ka * va[0] + kb * vb[0]
    const y = ka * va[1] + kb * vb[1]
    const z = ka * va[2] + kb * vb[2]
    let lng = Math.atan2(y, x) / r
    while (lng - prev > 180) lng -= 360
    while (lng - prev < -180) lng += 360
    prev = lng
    out.push([Math.atan2(z, Math.hypot(x, y)) / r, lng])
  }
  return out
}

// small round marker with inline styles, so it needs no extra CSS
function extraIcon(e: ExtraPoint): L.DivIcon {
  const g = GROUPS[groupOf(e.kind)] ?? GROUPS.transit
  const emergency = e.kind === 'emergency'
  const size = e.picked ? 30 : emergency ? 26 : 22
  const letter = e.kind === 'stay' ? (e.picked ? '✓' : 'H') : groupOf(e.kind) === 'medical' ? '+' : 'T'
  const el = document.createElement('div')
  el.textContent = letter
  el.style.cssText = [
    `width:${size}px`,
    `height:${size}px`,
    'border-radius:50%',
    `background:${e.picked ? '#16A34A' : g.color}`,
    'color:#fff',
    `font:700 ${emergency ? 17 : 12}px/1 system-ui,sans-serif`,
    'display:flex',
    'align-items:center',
    'justify-content:center',
    `border:${emergency || e.picked ? 3 : 2}px solid #fff`,
    'box-shadow:0 1px 5px rgba(0,0,0,.45)',
  ].join(';')
  return L.divIcon({ className: '', html: el, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}

function extraPopup(e: ExtraPoint): HTMLElement {
  const box = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = e.name
  const sub = document.createElement('div')
  sub.textContent = e.picked ? `${e.sub} · your stay` : e.kind === 'emergency' ? `${e.sub} · emergency department` : e.sub
  const link = document.createElement('a')
  link.href = `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}`
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = 'Open in Maps'
  box.append(title, sub, link)
  return box
}

type Pin = { name: string; btn: HTMLButtonElement; marker: L.Marker }

export default function TripMap({ points, selected, onSelect, focusTick, extras = [], journey = null }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const lines = useRef<L.LayerGroup | null>(null)
  const pinLayer = useRef<L.LayerGroup | null>(null)
  const extraLayer = useRef<L.LayerGroup | null>(null)
  const journeyLayer = useRef<L.LayerGroup | null>(null)
  const pins = useRef<Pin[]>([])
  const dot = useRef<L.Marker | null>(null)
  const raf = useRef(0)
  const [show, setShow] = useState<Record<Group, boolean>>({ stay: true, medical: true, transit: true })

  const pointsRef = useRef(points)
  const selectedRef = useRef(selected)
  const onSelectRef = useRef(onSelect)
  const journeyRef = useRef<Journey | null>(journey)
  pointsRef.current = points
  selectedRef.current = selected
  onSelectRef.current = onSelect
  journeyRef.current = journey

  const markActive = () => {
    pins.current.forEach((p) => {
      const on = p.name === selectedRef.current
      p.btn.classList.toggle('gm-pin-active', on)
      p.marker.setZIndexOffset(on ? 1000 : 0)
    })
  }

  const drawPins = () => {
    const g = pinLayer.current
    if (!g) return
    g.clearLayers()
    pins.current = pointsRef.current.map((p) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'gm-pin'
      btn.setAttribute('aria-label', `Stop ${p.n}: ${p.name}`)
      const num = document.createElement('span')
      num.textContent = String(p.n)
      const tag = document.createElement('em')
      tag.textContent = p.name
      btn.append(num, tag)
      const icon = L.divIcon({ className: '', html: btn, iconSize: [32, 32], iconAnchor: [16, 16] })
      const marker = L.marker([p.lat, p.lng], { icon, keyboard: false }).addTo(g)
      marker.on('click', () => onSelectRef.current(p.name))
      return { name: p.name, btn, marker }
    })
    markActive()
  }

  const drawExtras = () => {
    const g = extraLayer.current
    if (!g) return
    g.clearLayers()
    if (journeyRef.current) return
    extras.forEach((e) => {
      if (!show[groupOf(e.kind)]) return
      L.marker([e.lat, e.lng], {
        icon: extraIcon(e),
        keyboard: false,
        zIndexOffset: e.picked ? -200 : -500, // numbered stops stay on top
      })
        .bindPopup(extraPopup(e))
        .addTo(g)
    })
  }

  const drawRoute = () => {
    const g = lines.current
    const m = map.current
    if (!g || !m) return
    g.clearLayers()
    cancelAnimationFrame(raf.current)
    dot.current?.remove()
    dot.current = null

    const line = curve(pointsRef.current)
    if (line.length < 2) return
    L.polyline(line, { color: '#ffffff', weight: 9, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(g)
    L.polyline(line, { color: '#E86F3D', weight: 4, dashArray: '2 10', lineCap: 'round', className: 'route-flow', interactive: false }).addTo(g)

    dot.current = L.marker(line[0], {
      icon: L.divIcon({ className: '', html: '<div class="gm-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
      interactive: false,
      keyboard: false,
    }).addTo(m)

    const total = line.length - 1
    const dur = Math.max(20000, (total / 24) * 6000) // about 6 seconds per hop
    const start = performance.now()
    const tick = (now: number) => {
      const p = (((now - start) % dur) / dur) * total
      const i = Math.floor(p)
      const f = p - i
      const a = line[i]
      const b = line[Math.min(i + 1, total)]
      dot.current?.setLatLng([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }

  const clearRoute = () => {
    lines.current?.clearLayers()
    pinLayer.current?.clearLayers()
    pins.current = []
    cancelAnimationFrame(raf.current)
    dot.current?.remove()
    dot.current = null
  }

  const drawJourney = () => {
    const g = journeyLayer.current
    const m = map.current
    const j = journeyRef.current
    if (!g || !m) return
    g.clearLayers()
    if (!j) return
    const line = arc(j.from, j.to)
    L.polyline(line, { color: '#ffffff', weight: 9, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(g)
    L.polyline(line, { color: '#E86F3D', weight: 4, dashArray: '2 10', lineCap: 'round', className: 'route-flow', interactive: false }).addTo(g)
    ;([[j.from, j.fromName], [j.to, j.toName]] as const).forEach(([p, name]) => {
      const tip = document.createElement('span')
      tip.textContent = name
      L.circleMarker([p.lat, p.lng], { radius: 7, color: '#ffffff', weight: 3, fillColor: '#E86F3D', fillOpacity: 1 })
        .bindTooltip(tip, { permanent: true, direction: 'top', offset: [0, -8] })
        .addTo(g)
    })
    dot.current = L.marker(line[0], {
      icon: L.divIcon({ className: '', html: '<div class="gm-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
      interactive: false,
      keyboard: false,
    }).addTo(m)
    const total = line.length - 1
    const start = performance.now()
    const tick = (now: number) => {
      const p = (((now - start) % 9000) / 9000) * total
      const i = Math.floor(p)
      const f = p - i
      const a = line[i]
      const b = line[Math.min(i + 1, total)]
      dot.current?.setLatLng([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }

  const fitJourney = () => {
    const m = map.current
    const j = journeyRef.current
    if (!m || !j) return
    m.invalidateSize()
    const tall = m.getSize().y > 420
    m.flyToBounds(L.latLngBounds(arc(j.from, j.to)), {
      paddingTopLeft: [60, tall ? 80 : 40],
      paddingBottomRight: [60, tall ? 190 : 60],
      maxZoom: 10,
      duration: 1.6,
    })
  }

  const fit = () => {
    const m = map.current
    const pts = pointsRef.current
    if (journeyRef.current) { fitJourney(); return }
    if (!m || !pts.length) return
    m.invalidateSize()
    if (pts.length === 1) {
      m.flyTo([pts[0].lat, pts[0].lng], 13, { duration: 1.4 })
      return
    }
    const tall = m.getSize().y > 420
    m.flyToBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])), {
      paddingTopLeft: [60, tall ? 80 : 40],
      paddingBottomRight: [60, tall ? 190 : 60],
      maxZoom: 14,
      duration: 1.4,
    })
  }

  // create the map once
  useEffect(() => {
    if (!box.current || map.current) return
    const m = L.map(box.current, { zoomControl: false, zoomSnap: 0.25, worldCopyJump: true }).setView([20, 0], 2)
    L.control.zoom({ position: 'topright' }).addTo(m)

    const topo = L.tileLayer(TOPO, {
      maxZoom: 18,
      attribution: 'Tiles © Esri — Esri, DeLorme, NAVTEQ, USGS, NRCAN, and others',
    }).addTo(m)
    let errors = 0
    let swapped = false
    topo.on('tileerror', () => {
      errors += 1
      if (errors >= 6 && !swapped) {
        swapped = true
        m.removeLayer(topo)
        L.tileLayer(OSM, { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(m)
      }
    })

    lines.current = L.layerGroup().addTo(m)
    journeyLayer.current = L.layerGroup().addTo(m)
    extraLayer.current = L.layerGroup().addTo(m)
    pinLayer.current = L.layerGroup().addTo(m)
    map.current = m

    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(box.current)
    const t = setTimeout(() => m.invalidateSize(), 250)

    return () => {
      clearTimeout(t)
      ro.disconnect()
      cancelAnimationFrame(raf.current)
      dot.current = null
      pins.current = []
      m.remove()
      map.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // new set of places: redraw route + pins and show them all
  useEffect(() => {
    if (!map.current) return
    if (journey) {
      clearRoute()
      drawJourney()
      fit()
      return
    }
    journeyLayer.current?.clearLayers()
    drawRoute()
    drawPins()
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, journey])

  // stays, medical help and transit stops (redrawn when they or the toggles change)
  useEffect(() => {
    if (!map.current) return
    drawExtras()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extras, show, journey])

  useEffect(() => {
    markActive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  // the user picked a stop: fly there
  useEffect(() => {
    const m = map.current
    if (!focusTick || !m) return
    const p = pointsRef.current.find((x) => x.name === selectedRef.current)
    if (!p) return
    m.flyTo([p.lat, p.lng], Math.max(m.getZoom(), 13), { duration: 1.8 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick])

  const counts: Record<Group, number> = { stay: 0, medical: 0, transit: 0 }
  extras.forEach((e) => { counts[groupOf(e.kind)] = (counts[groupOf(e.kind)] ?? 0) + 1 })

  return (
    <div className="map-canvas">
      <div ref={box} className="map-leaflet" />
      {extras.length > 0 && (
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 1000, display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 'calc(100% - 70px)' }}>
          {(Object.keys(GROUPS) as Group[]).filter((g) => counts[g] > 0).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={show[g]}
              onClick={() => setShow((s) => ({ ...s, [g]: !s[g] }))}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                borderRadius: 999,
                border: '1px solid rgba(0,0,0,.15)',
                background: show[g] ? '#fff' : 'rgba(255,255,255,.7)',
                color: show[g] ? '#1f2937' : '#6b7280',
                font: '600 12px/1 system-ui,sans-serif',
                cursor: 'pointer',
                boxShadow: '0 1px 4px rgba(0,0,0,.25)',
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: GROUPS[g].color, opacity: show[g] ? 1 : 0.4 }} />
              {GROUPS[g].label} {counts[g]}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="map-reset" onClick={fit}>Overview</button>
    </div>
  )
}
