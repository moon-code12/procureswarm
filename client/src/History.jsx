import React, { useEffect, useState } from 'react'
import { getJson } from './api.js'

const naira = n => `₦${Math.round(n).toLocaleString('en-NG')}`
const when = iso => new Date(iso).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })

/** Past auctions saved by the server. Open one to see the full result and re-verify it on NEAR. */
export default function History({ onOpen }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(null)

  useEffect(() => {
    let cancelled = false
    getJson('/api/auctions')
      .then(list => { if (!cancelled) setItems(list) })
      .catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [])

  async function open(id) {
    setOpening(id)
    setError('')
    try {
      onOpen(await getJson(`/api/auctions/${encodeURIComponent(id)}`))
    } catch (err) {
      setError(`Could not open that auction: ${err.message}`)
    } finally {
      setOpening(null)
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Auction history</h2><p>The latest auctions run on this server</p></div><span className="step">{items ? `${items.length} SAVED` : ''}</span></div>

      {error && <div className="alert">{error}</div>}
      {!items && !error && <p className="muted">Loading…</p>}
      {items && items.length === 0 && <p className="muted">No auctions yet. Run one and it will appear here.</p>}

      <div className="history-list">
        {items?.map((a, i) => (
          <button key={a.id} className="history-item" style={{ '--i': Math.min(i, 12) }} onClick={() => open(a.id)} disabled={opening === a.id}>
            <div className="history-main">
              <b>{a.product} × {a.quantity}</b>
              <small>{when(a.createdAt)} · {a.roundsRun} round{a.roundsRun > 1 ? 's' : ''} · {a.aiAgents}/11 AI agents</small>
            </div>
            <div className="history-winner">
              <span>{a.winnerName}</span>
              <strong>{a.formattedTotal ?? naira(a.totalPrice)}</strong>
            </div>
            <span className={`status-tag${a.onChainStatus === 'confirmed' ? '' : ' warn'}`}>
              {a.onChainStatus === 'confirmed' ? 'ON NEAR' : a.onChainStatus === 'failed' ? 'NOT RECORDED' : 'OFF-CHAIN'}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
