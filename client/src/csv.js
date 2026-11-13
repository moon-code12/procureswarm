// CSV export of an auction result.

// Spreadsheet apps run cells that start with = + - @ as formulas. The product name is user text,
// so any text cell like that gets a leading apostrophe to keep it inert.
const cell = v => {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const row = cells => cells.map(cell).join(',')

export function auctionToCsv(a) {
  const lines = [
    row(['ProcureSwarm auction']),
    row(['Auction ID', a.id]),
    row(['Created', a.createdAt]),
    row(['Product', a.product]),
    row(['Quantity', a.quantity]),
    row(['Target unit price (NGN)', a.targetUnitPrice ?? '']),
    row(['Rounds', a.roundsRun ?? 1]),
    row(['Winner', a.winningBid.name]),
    row(['Winning total (NGN)', a.winningBid.totalPrice]),
    row(['Savings vs target (NGN)', a.savings]),
    row(['NEAR status', a.onChain?.status ?? '']),
    row(['NEAR transaction', a.onChain?.txHash ?? '']),
    '',
    row(['Bids']),
    row(['Seller', 'Location', 'Round 1 unit price', 'Final unit price (NGN)', 'Total (NGN)', 'Delivery days', 'Reliability', 'Score', 'Source']),
    ...a.bids.map(b => row([b.name, b.location, b.firstRoundUnitPrice ?? b.unitPrice, b.unitPrice, b.totalPrice, b.deliveryDays, b.reliability, b.score, b.source])),
    '',
    row(['Cost split']),
    row(['Buyer', 'Units', 'Share %', 'Amount (NGN)', 'Source']),
    ...a.allocations.map(b => row([b.name, b.quantity, b.sharePercent, b.amount, b.source]))
  ]
  return lines.join('\r\n')
}

export function downloadCsv(auction) {
  // The BOM makes Excel read the naira text and accents correctly.
  const blob = new Blob(['﻿', auctionToCsv(auction)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${auction.id}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
