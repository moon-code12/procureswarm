// In the single-service Render deployment the frontend and API share one origin.
// VITE_API_URL remains available for local development or a split deployment.
export const API = import.meta.env.VITE_API_URL || ''

// The sign-in token only lives for the browser tab (sessionStorage), never in a long-lived store.
const TOKEN_KEY = 'ps-session'
export const loadSession = () => {
  try { return JSON.parse(sessionStorage.getItem(TOKEN_KEY)) } catch { return null }
}
export const saveSession = session => {
  if (session) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session))
  else sessionStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function errorFrom(res) {
  let message = `Server returned ${res.status}`
  try { message = (await res.json()).error || message } catch { /* not JSON */ }
  return new ApiError(message, res.status)
}

export async function getJson(path) {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw await errorFrom(res)
  return res.json()
}

/**
 * Runs an auction and reports real progress as each agent finishes. The server streams one JSON
 * event per line; resolves with the final auction.
 */
export async function streamAuction(body, onEvent, token) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API}/api/auction/stream`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) throw await errorFrom(res)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const event = JSON.parse(line)
      if (event.type === 'result') result = event.auction
      else if (event.type === 'error') throw new ApiError(event.message || 'Auction failed', 500)
      else onEvent(event)
    }
  }
  if (!result) throw new ApiError('The auction ended without a result', 502)
  return result
}
