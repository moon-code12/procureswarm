import React, { useEffect, useState } from 'react'
import { getSelector, accountOf, openWalletModal, disconnectWallet, signInWithNear, callContract } from './wallet.js'
import { API, loadSession, saveSession, streamAuction, getJson } from './api.js'
import { downloadCsv } from './csv.js'
import History from './History.jsx'
import { CountUp, SwarmLoader, BidChart, SplitBar } from './charts.jsx'

const naira = n => `₦${Math.round(n).toLocaleString('en-NG')}`
const shortHash = h => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '')

function SourceTag({ source }) {
  const ai = source === 'ai-agent'
  return <span className="status-tag" style={ai ? undefined : { color: '#e9c76c', background: '#332819', borderColor: '#795c37' }}>{ai ? 'AI AGENT' : 'SIMULATED'}</span>
}

async function hashBid(auctionId, sellerId, unitPrice, quantity, salt) {
  const input = new TextEncoder().encode(`${auctionId}|${sellerId}|${unitPrice}|${quantity}|${salt}`)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function SealedBidDemo({ auction, contractId, account }) {
  const [price, setPrice] = useState(auction?.winningBid?.unitPrice ?? 0)
  const [salt, setSalt] = useState('')
  const [phase, setPhase] = useState('idle')
  const [message, setMessage] = useState('')
  if (!auction || !contractId || !account) return null
  async function commit() {
    if (!salt) return setMessage('Enter a private salt before committing.')
    setPhase('working'); setMessage('')
    try {
      const commitment = await hashBid(auction.id, account, Number(price), auction.quantity, salt)
      await callContract(contractId, 'commit_bid', { auction_id: auction.id, commitment })
      setPhase('committed'); setMessage(`Commitment ${commitment.slice(0, 12)}… recorded on NEAR.`)
    } catch (err) { setPhase('idle'); setMessage(`Commit failed: ${err.message}`) }
  }
  async function reveal() {
    setPhase('working'); setMessage('')
    try {
      await callContract(contractId, 'reveal_bid', { auction_id: auction.id, unit_price: Number(price), quantity: auction.quantity, salt })
      setPhase('revealed'); setMessage('Bid revealed and matched against its commitment.')
    } catch (err) { setPhase('committed'); setMessage(`Reveal failed: ${err.message}`) }
  }
  return <div className="request-hint" style={{ marginTop: 12 }}><span>🔐</span><div style={{ width: '100%' }}><b>Sealed-bid commit / reveal</b><p className="note">The connected wallet acts as a seller agent. Keep the salt private until reveal.</p><div className="form-row"><label>Bid price<input type="number" min="1" value={price} onChange={e => setPrice(e.target.value)} disabled={phase !== 'idle'} /></label><label>Private salt<input value={salt} onChange={e => setSalt(e.target.value)} placeholder="private value" disabled={phase !== 'idle'} /></label></div><div className="row-actions"><button className="secondary" onClick={commit} disabled={phase !== 'idle'}>Commit bid</button><button className="primary" onClick={reveal} disabled={phase !== 'committed'}>Reveal bid</button></div>{message && <p className="note">{message}</p>}</div></div>
}

function EscrowDemo({ auction, contractId, account }) {
  const [amount, setAmount] = useState('0.01')
  const [message, setMessage] = useState('')
  const [working, setWorking] = useState(false)
  if (!auction?.escrow || !contractId || !account) return null
  async function deposit() {
    setWorking(true); setMessage('')
    try {
      const yocto = String(BigInt(Math.round(Number(amount) * 1e24)))
      await callContract(contractId, 'deposit_escrow', { auction_id: auction.id }, yocto)
      setMessage(`Deposited ${amount} testnet NEAR into escrow. The contract now holds it for this auction.`)
    } catch (err) { setMessage(`Deposit failed: ${err.message}`) }
    finally { setWorking(false) }
  }
  async function confirmDelivery() {
    setWorking(true); setMessage('')
    try {
      await callContract(contractId, 'confirm_delivery', { auction_id: auction.id, seller_id: auction.winningBid.id })
      setMessage('Delivery confirmed. Open escrow is released to the winning seller.')
    } catch (err) { setMessage(`Release failed: ${err.message}. Only the contract owner can confirm delivery.`) }
    finally { setWorking(false) }
  }
  async function refund() {
    setWorking(true); setMessage('')
    try {
      await callContract(contractId, 'refund_escrow', { auction_id: auction.id })
      setMessage('Escrow refund requested for all open buyer deposits.')
    } catch (err) { setMessage(`Refund failed: ${err.message}. Only the contract owner can refund escrow.`) }
    finally { setWorking(false) }
  }
  return <div className="request-hint" style={{ marginTop: 12 }}><span>💰</span><div style={{ width: '100%' }}><b>Testnet escrow</b><p className="note">Target: {auction.escrow.requiredAmountFormatted} across {auction.escrow.buyerCount} buyer shares. This demo uses testnet NEAR only.</p><div className="form-row"><label>Deposit amount (NEAR)<input type="number" min="0.001" step="0.001" value={amount} onChange={e => setAmount(e.target.value)} disabled={working} /></label></div><div className="row-actions"><button className="secondary" onClick={deposit} disabled={working}>Deposit share</button><button className="secondary" onClick={confirmDelivery} disabled={working}>Confirm delivery</button><button className="secondary" onClick={refund} disabled={working}>Refund</button></div>{message && <p className="note">{message}</p>}</div></div>
}

function Verification({ auction }) {
  const [state, setState] = useState({ loading: false, result: null, error: '' })

  async function verify() {
    setState({ loading: true, result: null, error: '' })
    try {
      const res = await fetch(`${API}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auction, txHash: auction.onChain.txHash })
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      setState({ loading: false, result: await res.json(), error: '' })
    } catch (err) {
      setState({ loading: false, result: null, error: `Verification could not run: ${err.message}` })
    }
  }

  const { loading, result, error } = state
  return (
    <div style={{ marginTop: 10 }}>
      <button className="secondary" onClick={verify} disabled={loading}>{loading ? 'Checking the network…' : 'Verify on NEAR'}</button>
      {error && <div className="alert" style={{ marginTop: 10 }}>{error}</div>}
      {result && (
        <div style={{ marginTop: 10 }}>
          <p className="note" style={{ margin: '0 0 8px', color: result.verified ? '#8ee2c0' : '#f2d39b' }}>
            <b>{result.verified ? 'Verified: this result matches the NEAR testnet record.' : 'NOT verified: at least one check failed.'}</b>
          </p>
          {result.checks.map(c => (
            <div key={c.name} className="note" style={{ margin: '4px 0' }}>
              <span style={{ color: c.passed ? '#8ee2c0' : '#f08c8c' }}>{c.passed ? '✓' : '✗'}</span> {c.name}
              {c.detail && !c.passed && <> ({c.detail})</>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OnChain({ onChain, auction }) {
  if (!onChain) return null
  if (onChain.status === 'confirmed') {
    return (
      <div className="request-hint">
        <span>⛓</span>
        <div>
          <p>
            <b>Recorded on NEAR {onChain.network}</b> (finality: {onChain.finality}).<br />
            Contract <b>{onChain.contractId}</b> · result hash <b title={onChain.requestHash}>{shortHash(onChain.requestHash)}</b><br />
            <a href={onChain.explorerUrl} target="_blank" rel="noreferrer" style={{ color: '#8ee2c0' }}>View transaction {shortHash(onChain.txHash)} ↗</a>
          </p>
          <Verification auction={auction} />
        </div>
      </div>
    )
  }
  if (onChain.status === 'failed') return <div className="alert">{onChain.error}. This result is a backend record only, not on-chain.</div>
  return <p className="note">NEAR is not configured on the server, so this result is a backend record only, not on-chain.</p>
}

function RoundsNote({ bids, rounds }) {
  const lowered = bids.filter(b => b.firstRoundUnitPrice != null && b.unitPrice < b.firstRoundUnitPrice)
  const avg = lowered.length
    ? lowered.reduce((s, b) => s + ((b.firstRoundUnitPrice - b.unitPrice) / b.firstRoundUnitPrice) * 100, 0) / lowered.length
    : 0
  const bestFirst = Math.min(...bids.map(b => b.firstRoundUnitPrice ?? b.unitPrice))
  const bestFinal = Math.min(...bids.map(b => b.unitPrice))
  return (
    <div className="rounds-note">
      <span>⇄</span>
      <p style={{ margin: 0 }}>
        <b>Sellers bid over {rounds} rounds.</b> After round 1 they saw the lowest bid and could revise:{' '}
        <b>{lowered.length} of {bids.length}</b> lowered their price{lowered.length ? ' (by ' + avg.toFixed(1) + '% on average)' : ''}.
        {bestFinal < bestFirst && <> The lowest price fell from {naira(bestFirst)} to {naira(bestFinal)} per unit.</>}
      </p>
    </div>
  )
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = e => setMatches(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export default function App() {
  const [health, setHealth] = useState(null)
  const [form, setForm] = useState({ product: '50kg bags of rice', quantity: 100, targetUnitPrice: 42000, rounds: 2 })
  const [result, setResult] = useState(null)
  const [target, setTarget] = useState(42000)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [account, setAccount] = useState(null)
  const isMobile = useMediaQuery('(max-width: 680px)')
  const [showAll, setShowAll] = useState(false)
  const [view, setView] = useState('new')
  const [progress, setProgress] = useState(null)
  const [session, setSession] = useState(() => loadSession())
  const [signingIn, setSigningIn] = useState(false)
  // A verified sign-in only counts for the wallet account it was made with.
  const verifiedAccount = session && account && session.account === account ? session.account : null

  useEffect(() => {
    if (session && session.account !== account) { saveSession(null); setSession(null) }
  }, [account]) // eslint-disable-line react-hooks/exhaustive-deps

  // On phones the result lands far below the form: bring it into view when it arrives.
  useEffect(() => {
    if (!result || !window.matchMedia('(max-width: 680px)').matches) return undefined
    setShowAll(false)
    const t = setTimeout(() => document.getElementById('result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
    return () => clearTimeout(t)
  }, [result])

  useEffect(() => {
    fetch(`${API}/api/health`).then(r => r.json()).then(setHealth).catch(() => setHealth({ ok: false }))
  }, [])

  // Keep the connected wallet account in sync with the wallet selector.
  useEffect(() => {
    let sub
    let cancelled = false
    getSelector()
      .then(selector => {
        if (cancelled) return
        setAccount(accountOf(selector.store.getState()))
        sub = selector.store.observable.subscribe(state => setAccount(accountOf(state)))
      })
      .catch(err => console.error('Wallet init failed:', err))
    return () => { cancelled = true; sub?.unsubscribe() }
  }, [])

  const connect = () => {
    if (!health?.contractId) return setError('The server has no NEAR contract configured, so the wallet cannot connect yet.')
    openWalletModal(health.contractId).catch(err => setError(`Could not open the wallet picker: ${err.message}`))
  }

  async function verifyWallet() {
    setSigningIn(true)
    setError('')
    try {
      const { accountId, token } = await signInWithNear(API)
      const next = { account: accountId, token }
      saveSession(next)
      setSession(next)
    } catch (err) {
      setError(`Wallet sign-in failed: ${err.message}`)
    } finally {
      setSigningIn(false)
    }
  }

  function disconnect() {
    saveSession(null)
    setSession(null)
    disconnectWallet().catch(err => setError(`Could not disconnect: ${err.message}`))
  }

  function openFromHistory(auction) {
    setTarget(auction.targetUnitPrice ?? 42000)
    setResult(auction)
    setView('new')
    setTimeout(() => document.getElementById('result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200)
  }

  const set = k => e => setForm({ ...form, [k]: e.target.value })

  const onEvent = ev => setProgress(p => {
    if (!p) return p
    if (ev.type === 'start') return { ...p, rounds: ev.rounds }
    if (ev.type === 'round') return { ...p, round: ev.round }
    if (ev.type === 'chain') return { ...p, recording: true }
    if (ev.type === 'agent') return { ...p, done: { ...p.done, [ev.id]: ev.round } }
    return p
  })

  async function run(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setProgress({ rounds: Number(form.rounds), round: 1, done: {}, recording: false })
    try {
      const data = await streamAuction(
        {
          product: form.product,
          quantity: Number(form.quantity),
          targetUnitPrice: Number(form.targetUnitPrice),
          rounds: Number(form.rounds),
          requester: account
        },
        onEvent,
        verifiedAccount ? session.token : null
      )
      setTarget(Number(form.targetUnitPrice))
      setResult(data)
      getJson('/api/health').then(setHealth).catch(() => {}) // refresh the daily counter
    } catch (err) {
      // Server messages (validation, rate limits) are already written for people; show them as they are.
      setError(err.status ? err.message : `Could not run the auction: ${err.message}. Is the server running on ${API}?`)
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  const feedTotal = result ? result.allocations.length + result.bids.length : 0
  const feedLimit = isMobile && !showAll ? 4 : Infinity
  const agentsMode = health?.agents === 'ai-agent' ? 'AI AGENTS LIVE' : 'SIMULATED MODE'
  const nearOn = health?.near === 'testnet'
  const aiCount = result ? [...result.bids, ...result.allocations].filter(x => x.source === 'ai-agent').length + (result.auctioneer?.source === 'ai-agent' ? 1 : 0) : 0

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div><b>ProcureSwarm</b><small>AGENT PROCUREMENT</small></div>
        </div>
        <div className="workspace"><span className="dot" /> Group buying <span className="chevron">⌄</span></div>
        <div className="nav-label">WORKSPACE</div>
        <button className="nav-item active">◈ <span>Procurement</span></button>
        <div className="sidebar-bottom">
          <div className="near-card">
            <div className="near-icon">N</div>
            <div><b>NEAR {nearOn ? 'testnet' : 'not configured'}</b><small>{nearOn ? 'Results recorded on-chain' : 'Backend records only'}</small></div>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="topbar-brand"><div className="brand-mark">P</div><b>ProcureSwarm</b></div>
          <div className="breadcrumb">Procurement<span>/</span>New auction</div>
          <div className="top-actions">
            <div className="mode-pill"><i />{health ? agentsMode : 'CONNECTING…'}</div>
            {nearOn && <span className="near-pill">NEAR testnet</span>}
            {account ? (
              <>
                <span className={`status-tag account-chip${verifiedAccount ? ' verified-chip' : ''}`} title={verifiedAccount ? `${account} (verified by signature)` : `${account} (not verified)`}>{verifiedAccount ? '✓ ' : ''}{account}</span>
                {!verifiedAccount && <button className="secondary" onClick={verifyWallet} disabled={signingIn} title="Sign a free message to prove you own this account">{signingIn ? 'Check wallet…' : 'Verify wallet'}</button>}
                <button className="secondary" onClick={disconnect}>Disconnect</button>
              </>
            ) : (
              <button className="secondary" onClick={connect}>Connect wallet</button>
            )}
          </div>
        </div>

        <div className="content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">AGENT PROCUREMENT NETWORK</div>
              <h1>Pool demand. Let agents compete.</h1>
              <p className="muted">Buyer agents declare needs, seller agents bid, and an auctioneer agent picks the winner.</p>
            </div>
          </div>

          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={view === 'new'} className={`tab${view === 'new' ? ' active' : ''}`} onClick={() => setView('new')}>New auction</button>
            <button role="tab" aria-selected={view === 'history'} className={`tab${view === 'history' ? ' active' : ''}`} onClick={() => setView('history')}>History</button>
          </div>

          {health && !health.ok && <div className="alert">Cannot reach the server at {API}. Start it with <b>npm run dev</b> in the server folder.</div>}
          {error && <div className="alert">{error}</div>}

          {view === 'history' ? <History onOpen={openFromHistory} /> : (<>
          <div className={`stats-grid${loading && result ? ' is-loading' : ''}`}>
            <div className="stat-card"><div className="stat-top">Agents answered</div><strong>{result ? <><CountUp value={aiCount} />/11</> : '–'}</strong><small>AI agents (rest simulated)</small></div>
            <div className="stat-card"><div className="stat-top">Bids</div><strong>{result ? <CountUp value={result.bids.length} /> : '–'}</strong><small>from seller agents</small></div>
            <div className="stat-card"><div className="stat-top">Savings vs target</div><strong>{result ? <CountUp value={result.savings} format={naira} /> : '–'}</strong><small>for the buyer group</small></div>
            <div className="stat-card"><div className="stat-top">On-chain</div><strong>{result ? (result.onChain?.status === 'confirmed' ? 'Yes' : 'No') : '–'}</strong><small>NEAR testnet record</small></div>
          </div>

          <div className="two-col">
            <section className="panel request-panel">
              <div className="panel-head"><div><h2>New procurement request</h2><p>The group order sent to the sellers</p></div><span className="step">STEP 1</span></div>
              <form onSubmit={run}>
                <label>Product<input value={form.product} onChange={set('product')} maxLength={80} /></label>
                <label>Bidding rounds
                  <select value={form.rounds} onChange={set('rounds')}>
                    {Array.from({ length: health?.limits?.maxRounds ?? 2 }, (_, i) => i + 1).map(n => (
                      <option key={n} value={n}>{n === 1 ? '1 round (sealed bids)' : `${n} rounds (sellers can undercut)`}</option>
                    ))}
                  </select>
                </label>
                <div className="form-row">
                  <label>Total quantity<input type="number" min="1" value={form.quantity} onChange={set('quantity')} /></label>
                  <label>Target price per unit (₦)<input type="number" min="1" value={form.targetUnitPrice} onChange={set('targetUnitPrice')} /></label>
                </div>
                <button className="primary run-btn" disabled={loading}>{loading ? 'Agents are bidding…' : 'Run auction'} <span>→</span></button>
                <small className="disclaimer">About {Number(form.rounds) * 5 + 6} AI calls per auction, so this can take up to a minute.</small>
              </form>
            </section>

            <section className="panel">
              <div className="panel-head"><div><h2>Agent activity</h2><p>What each agent decided</p></div><span className="step">LIVE</span></div>
              {loading ? <SwarmLoader progress={progress} /> : !result ? <p className="muted">Run an auction to see the agents' decisions.</p> : (
                <div className="timeline">
                  {result.allocations.slice(0, feedLimit).map((b, i) => (
                    <div className="timeline-item" style={{ '--i': i }} key={b.id}><div className="timeline-icon">B</div><div><p><b>{b.name}</b>: needs {b.quantity} units. {b.message}</p><SourceTag source={b.source} /></div></div>
                  ))}
                  {result.bids.slice(0, Math.max(0, feedLimit - result.allocations.length)).map((s, i) => (
                    <div className="timeline-item" style={{ '--i': i + 5 }} key={s.id}><div className="timeline-icon tauction">S</div><div><p><b>{s.name}</b> bid {naira(s.unitPrice)}/unit, {s.deliveryDays}d. {s.message}</p><SourceTag source={s.source} /></div></div>
                  ))}
                
                  {isMobile && feedTotal > 4 && (
                    <button type="button" className="secondary show-all" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show fewer' : `Show all ${feedTotal} agents`}</button>
                  )}
                </div>
              )}
            </section>
          </div>

          {result && (
            <section id="result" key={result.id} className={`panel${loading ? ' is-loading' : ''}`} style={{ marginTop: 16 }}>
              <div className="panel-head"><div><h2>Auction result</h2><p>{result.product} × {result.quantity}</p></div><div className="row-actions"><button type="button" className="secondary" onClick={() => downloadCsv(result)}>Download CSV</button><span className="step">STEP 2</span></div></div>

              <div className="winner">
                <div>
                  <div className="eyebrow">WINNER</div>
                  <h2>{result.winningBid.name}</h2>
                  <p>{result.winningBid.location} · {result.winningBid.deliveryDays} days · reliability {result.winningBid.reliability}/100</p>
                </div>
                <div className="winner-price"><small>TOTAL</small><strong>{result.winningBid.formattedTotal}</strong><span>{naira(result.winningBid.unitPrice)} per unit</span></div>
              </div>

              {result.requester && (result.requesterVerified
                ? <p className="note"><span className="status-tag verified-chip">✓ VERIFIED WALLET</span> Requested by <b>{result.requester}</b>, who proved ownership by signing in with NEAR (not recorded on-chain).</p>
                : <p className="note">Requested by <b>{result.requester}</b>. This name is self-declared: the wallet did not sign in, so the server cannot verify it (not recorded on-chain).</p>)}
              <p className="note" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><span style={{ flexShrink: 0 }}><SourceTag source={result.auctioneer?.source} /></span><span>{result.auctioneer?.reasoning}</span></p>
              {result.roundsRun > 1 && <RoundsNote bids={result.bids} rounds={result.roundsRun} />}
              <OnChain onChain={result.onChain} auction={result} />
              <SealedBidDemo auction={result} contractId={health?.contractId} account={account} />
              <EscrowDemo auction={result} contractId={health?.contractId} account={account} />

              <div className="section-title">Bids vs your target price</div>
              <BidChart bids={result.bids} target={target} winnerId={result.winningBid.id} />

              <details className="table-view" style={{ marginTop: 14 }}>
                <summary className="note" style={{ cursor: 'pointer' }}>Table view (all bids)</summary>
                <div className="table-wrap">
                <table>
                  <thead><tr><th>SELLER</th><th>UNIT PRICE</th><th>TOTAL</th><th>DELIVERY</th><th>SCORE</th><th>SOURCE</th></tr></thead>
                  <tbody>
                    {result.bids.map((b, i) => (
                      <tr key={b.id}>
                        <td><b>{b.name}</b><span className="cell-sub">{b.location}</span></td>
                        <td>{naira(b.unitPrice)}</td><td>{b.formattedTotal}</td><td>{b.deliveryDays} days</td>
                        <td><span className={`score${b.id === result.winningBid.id ? ' best' : ''}`}>{b.score}</span></td>
                        <td><SourceTag source={b.source} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </details>

              <div className="section-title">Cost split between buyers</div>
              <SplitBar allocations={result.allocations} />
            </section>
          )}

          </>)}

          <footer>ProcureSwarm prototype · agent decisions come from AI models, the cost split is calculated in code, and only results marked "Recorded on NEAR" are on-chain.
            {health?.limits && <div className="limits-line">Today: {health.limits.startedToday} of {health.limits.perDay} auctions used · {health.limits.perIpPerHour} per hour per visitor · AI calls since the server started: {health.usage?.calls ?? 0}</div>}
          </footer>
        </div>
      </main>
    </div>
  )
}
