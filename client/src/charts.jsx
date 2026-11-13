import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const naira = n => `₦${Math.round(n).toLocaleString('en-NG')}`

// Dark-surface chart colours, validated with the dataviz palette validator against the panel colour (#111d2e).
export const BELOW = '#3987e5' // cheaper than target (diverging blue pole)
export const ABOVE = '#e66767' // pricier than target (diverging red pole)
const BUYER_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] // categorical slots 1-5

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Counts up to a number. Honours prefers-reduced-motion. */
export function CountUp({ value, format = n => n.toLocaleString('en-NG'), duration = 900 }) {
  const [shown, setShown] = useState(0)
  const current = useRef(0)

  useEffect(() => {
    if (typeof value !== 'number' || reducedMotion()) {
      current.current = value
      setShown(value)
      return undefined
    }
    const from = current.current
    const start = performance.now()
    let raf
    const tick = now => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const v = Math.round(from + (value - from) * eased)
      current.current = v
      setShown(v)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return <>{format(shown)}</>
}

/**
 * Live progress while an auction runs. Every chip reflects a real event streamed by the server:
 * a chip turns solid only after that agent has actually answered.
 */
const CHIPS = [
  { id: 'buyer-01', n: 'Amina', kind: 'buyer' }, { id: 'buyer-02', n: 'Campus', kind: 'buyer' },
  { id: 'buyer-03', n: 'FreshPlate', kind: 'buyer' }, { id: 'buyer-04', n: 'Unity', kind: 'buyer' },
  { id: 'buyer-05', n: 'Daily', kind: 'buyer' },
  { id: 'seller-river', n: 'Riverbend', kind: 'seller' }, { id: 'seller-green', n: 'Green Basket', kind: 'seller' },
  { id: 'seller-north', n: 'Northern', kind: 'seller' }, { id: 'seller-market', n: 'MarketLink', kind: 'seller' },
  { id: 'seller-prime', n: 'Prime', kind: 'seller' },
  { id: 'auctioneer', n: 'Auctioneer', kind: 'auctioneer' }
]

export function SwarmLoader({ progress }) {
  const p = progress || { rounds: 1, round: 1, done: {}, recording: false }
  const sellers = CHIPS.filter(c => c.kind === 'seller')
  const sellersDone = sellers.filter(c => (p.done[c.id] ?? 0) >= p.round).length
  const allSellersDone = sellersDone === sellers.length && p.round >= p.rounds

  const state = c => {
    if (c.kind === 'seller') return (p.done[c.id] ?? 0) >= p.round ? 'done' : 'working'
    if (c.kind === 'auctioneer') return p.done.auctioneer ? 'done' : allSellersDone ? 'working' : 'waiting'
    return p.done[c.id] ? 'done' : 'working'
  }
  const finished = CHIPS.filter(c => state(c) === 'done').length

  let title = 'Agents are deliberating…'
  if (p.recording) title = 'Recording the result on NEAR testnet…'
  else if (p.round > 1 && sellersDone < sellers.length) title = `Round ${p.round} of ${p.rounds}: sellers are revising their bids`
  else if (p.round > 1) title = 'Round ' + p.round + ' done: the auctioneer is choosing a winner'
  else if (sellersDone === sellers.length && p.rounds === 1) title = 'The auctioneer is choosing a winner'

  return (
    <div className="swarm" role="status" aria-live="polite">
      <p className="swarm-title">{title}</p>
      <div className="swarm-bar"><span style={{ width: `${(finished / CHIPS.length) * 100}%` }} /></div>
      <div className="swarm-chips">
        {CHIPS.map((c, i) => (
          <span key={c.id} className={`swarm-chip ${c.kind} ${state(c)}`} style={{ '--i': i }}><i />{c.n}</span>
        ))}
      </div>
      <p className="muted">{finished} of {CHIPS.length} agents have answered{p.rounds > 1 ? ` · sellers bid over ${p.rounds} rounds` : ''}. This usually takes 15 to 60 seconds.</p>
    </div>
  )
}

const NICE = [1, 2, 3, 5, 10, 20, 50, 100]
const pct = d => `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)}%`

/**
 * Diverging bar chart: each seller's bid as % above/below the buyers' target price.
 * The centre line is the target. Blue = cheaper than target, red = pricier.
 */
export function BidChart({ bids, target, winnerId }) {
  const [tip, setTip] = useState(null)

  // On touch screens the tooltip stays until the next tap elsewhere.
  useEffect(() => {
    const away = e => { if (!e.target.closest?.('.bidrow')) setTip(null) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [])

  const rows = [...bids]
    .map(b => ({ ...b, delta: ((b.unitPrice - target) / target) * 100 }))
    .sort((a, b) => a.unitPrice - b.unitPrice)
  const maxAbs = Math.max(0.1, ...rows.map(r => Math.abs(r.delta)))
  const D = NICE.find(n => n >= maxAbs) ?? Math.ceil(maxAbs)
  const SCALE = 0.72 // leaves room beyond the longest bar for its label
  const x = d => (Math.abs(d) / D) * 50 * SCALE // bar length, % of plot width
  const ticks = [-D, -D / 2, 0, D / 2, D]

  const showTip = (row, e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX ?? rect.left + rect.width / 2
    const py = e.clientY ?? rect.top
    setTip({ row, x: px, y: py })
  }

  return (
    <div className="bidchart">
      <div className="bidchart-legend">
        <span><i style={{ background: BELOW }} />Cheaper than target</span>
        <span><i style={{ background: ABOVE }} />Above target</span>
        <span className="muted">Target {naira(target)} per unit</span>
      </div>

      <div className="bidchart-body">
        {rows.map((r, i) => {
          const neg = r.delta < 0
          const w = x(r.delta)
          const winner = r.id === winnerId
          return (
            <div
              key={r.id}
              className={`bidrow${winner ? ' is-winner' : ''}`}
              style={{ '--i': i }}
              tabIndex={0}
              aria-label={`${r.name}: ${naira(r.unitPrice)} per unit, ${pct(r.delta)} versus target, ${r.deliveryDays} days delivery${winner ? ', winner' : ''}`}
              onPointerMove={e => showTip(r, e)}
              onPointerLeave={e => { if (e.pointerType !== 'touch') setTip(null) }}
              onClick={e => showTip(r, e)}
              onFocus={e => showTip(r, e)}
              onBlur={() => setTip(null)}
            >
              <div className="bidrow-label">
                <b>{r.name}{winner && <span className="winner-badge">★ Winner</span>}</b>
                <small>{r.location} · {naira(r.unitPrice)} · {r.deliveryDays}d{r.firstRoundUnitPrice != null && r.firstRoundUnitPrice !== r.unitPrice && <> · was {naira(r.firstRoundUnitPrice)}</>}</small>
              </div>
              <div className="bidrow-plot">
                {ticks.map(t => (
                  <span key={t} className={`gridline${t === 0 ? ' zero' : ''}`} style={{ left: `${50 + (t / D) * 50 * SCALE}%` }} />
                ))}
                <span
                  className={`bar ${neg ? 'neg' : 'pos'}`}
                  style={{ width: `${w}%`, background: neg ? BELOW : ABOVE, animationDelay: `${i * 90 + 150}ms` }}
                />
                <span
                  className="bar-value"
                  style={neg ? { right: `calc(50% + ${w}% + 8px)` } : { left: `calc(50% + ${w}% + 8px)` }}
                >
                  {pct(r.delta)}
                </span>
              </div>
            </div>
          )
        })}
        <div className="bidchart-axis">
          <span className="bidchart-axis-spacer" />
          <div className="bidchart-axis-ticks">
            {ticks.map(t => (
              <span key={t} style={{ left: `${50 + (t / D) * 50 * SCALE}%` }}>{t === 0 ? 'Target' : `${t > 0 ? '+' : '−'}${Math.abs(t)}%`}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Rendered into <body>: the animated panels would otherwise become the containing block for position:fixed. */}
      {tip && createPortal(
        <div className="viz-tooltip" style={{ left: tip.x, top: Math.max(8, tip.y - 12), transform: tip.x > window.innerWidth * 0.55 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)' }}>
          <b>{tip.row.name}</b>
          <strong>{naira(tip.row.unitPrice)} <small>per unit</small></strong>
          <span>{pct(tip.row.delta)} vs target · total {tip.row.formattedTotal}</span>
          <span>{tip.row.deliveryDays} days · reliability {tip.row.reliability}/100 · score {tip.row.score}</span>
          {tip.row.firstRoundUnitPrice != null && tip.row.firstRoundUnitPrice !== tip.row.unitPrice && <span>Round 1 bid: {naira(tip.row.firstRoundUnitPrice)} → final {naira(tip.row.unitPrice)}</span>}
          <span>{tip.row.source === 'ai-agent' ? 'AI agent bid' : 'Simulated bid'}</span>
        </div>,
        document.body
      )}
    </div>
  )
}

/** Thin segmented bar + list: how the winning total is split between the buyers. */
export function SplitBar({ allocations }) {
  const [hover, setHover] = useState(null)
  const total = allocations.reduce((s, a) => s + a.quantity, 0) || 1
  return (
    <div className="splitbar">
      <div className="splitbar-track" role="img" aria-label="Share of the order per buyer">
        {allocations.map((a, i) => (
          <span
            key={a.id}
            className={hover && hover !== a.id ? 'dim' : ''}
            style={{ width: `${(a.quantity / total) * 100}%`, background: BUYER_COLORS[i % BUYER_COLORS.length], animationDelay: `${i * 80 + 200}ms` }}
            onPointerEnter={() => setHover(a.id)}
            onPointerLeave={() => setHover(null)}
            title={`${a.name}: ${a.quantity} units, ${a.formattedAmount}`}
          />
        ))}
      </div>
      <div className="allocation-list">
        {allocations.map((a, i) => (
          <div
            className={`allocation${hover === a.id ? ' hot' : ''}`}
            key={a.id}
            style={{ '--i': i }}
            onPointerEnter={() => setHover(a.id)}
            onPointerLeave={() => setHover(null)}
          >
            <div>
              <b><i className="swatch" style={{ background: BUYER_COLORS[i % BUYER_COLORS.length] }} />{a.name}</b>
              <small>{a.quantity} units · {a.sharePercent}%</small>
            </div>
            <strong>{a.formattedAmount}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}
