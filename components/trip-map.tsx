'use client'

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export type MapPoint = { n: number; name: string; lat: number; lng: number }

type Props = {
  points: MapPoint[]
  selected: string
  onSelect: (name: string) => void
  focusTick: number // goes up whenever the user picks a stop, so the camera flies there
}

const TOPO = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

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

type Pin = { name: string; btn: HTMLButtonElement; marker: L.Marker }

export default function TripMap({ points, selected, onSelect, focusTick }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const lines = useRef<L.LayerGroup | null>(null)
  const pinLayer = useRef<L.LayerGroup | null>(null)
  const pins = useRef<Pin[]>([])
  const dot = useRef<L.Marker | null>(null)
  const raf = useRef(0)

  const pointsRef = useRef(points)
  const selectedRef = useRef(selected)
  const onSelectRef = useRef(onSelect)
  pointsRef.current = points
  selectedRef.current = selected
  onSelectRef.current = onSelect

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

  const fit = () => {
    const m = map.current
    const pts = pointsRef.current
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
    drawRoute()
    drawPins()
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points])

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

  return (
    <div className="map-canvas">
      <div ref={box} className="map-leaflet" />
      <button type="button" className="map-reset" onClick={fit}>Overview</button>
    </div>
  )
}