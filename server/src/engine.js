import { randomBytes } from "node:crypto";
import { agentsEnabled, getSellerBid, getBuyerDemand, getAuctioneerDecision } from "./agents.js";

export const sellerTemplates = [
  { id: "seller-river", name: "Riverbend Supplies", location: "Ilorin", reliability: 96, priceFactor: 1.04, deliveryDays: 2 },
  { id: "seller-green", name: "Green Basket Cooperative", location: "Lagos", reliability: 94, priceFactor: 0.98, deliveryDays: 4 },
  { id: "seller-north", name: "Northern Grains Hub", location: "Kano", reliability: 91, priceFactor: 0.93, deliveryDays: 5 },
  { id: "seller-market", name: "MarketLink Wholesale", location: "Ibadan", reliability: 89, priceFactor: 1.00, deliveryDays: 3 },
  { id: "seller-prime", name: "Prime Bulk Traders", location: "Abuja", reliability: 97, priceFactor: 1.08, deliveryDays: 2 }
];

export const buyerTemplates = [
  { id: "buyer-01", name: "Amina Foods", profile: "a mid-size food processing business", quantity: 25 },
  { id: "buyer-02", name: "Campus Kitchen", profile: "a university canteen serving thousands of students", quantity: 20 },
  { id: "buyer-03", name: "FreshPlate Cafe", profile: "a small neighbourhood cafe with tight cash flow", quantity: 15 },
  { id: "buyer-04", name: "Unity Caterers", profile: "an events catering company with lumpy demand", quantity: 20 },
  { id: "buyer-05", name: "Daily Basket", profile: "a grocery retailer restocking weekly", quantity: 20 }
];

const money = n => Math.round(n).toLocaleString("en-NG");

/**
 * Runs a full auction: seller agents bid over one or more rounds, buyer agents declare their needs
 * (in parallel), the auctioneer agent picks a winner, and the cost split is computed in code.
 *
 * `request` must already be validated (see limits.js). `onEvent` receives progress events as each
 * agent finishes, so a caller can stream real progress. Any agent that fails falls back to a
 * simulated value for that agent, and the result says which is which via `source`.
 */
export async function runAuction(request, { onEvent = () => {} } = {}) {
  const { quantity, targetUnitPrice: unitPrice, product } = request;
  const rounds = Math.max(1, request.rounds ?? 1);
  const useAgents = agentsEnabled();
  const emit = event => { try { onEvent(event); } catch { /* a broken listener must not break the auction */ } };

  // Sellers cannot go below a cost floor, so a multi-round price race stays realistic.
  const floorFor = seller => Math.round(unitPrice * seller.priceFactor * 0.88);
  const agentRequest = { product, quantity, targetUnitPrice: unitPrice, floorFor };

  emit({ type: "start", rounds, agents: sellerTemplates.length + buyerTemplates.length + 1 });

  // Buyers don't depend on the bids, so they run alongside the seller rounds.
  const buyersPromise = Promise.all(buyerTemplates.map(async b => {
    let units = b.quantity;
    let message = null;
    let source = "simulated";
    if (useAgents) {
      try {
        const demand = await getBuyerDemand(b, agentRequest);
        const q = Math.round(Number(demand.quantity));
        if (Number.isFinite(q) && q > 0) {
          units = Math.min(q, quantity);
          message = typeof demand.message === "string" ? demand.message.slice(0, 300) : null;
          source = "ai-agent";
        }
      } catch (err) {
        console.error(`Buyer agent ${b.id} failed, using default share:`, err.message);
      }
    }
    emit({ type: "agent", role: "buyer", id: b.id, name: b.name, round: 1, source });
    return { ...b, quantity: units, message, source };
  }));

  // Seller state carried across rounds.
  let state = sellerTemplates.map((seller, index) => {
    const variation = 0.96 + (((index * 7) % 9) / 100); // simulated bid, also the fallback
    return {
      seller,
      unit: Math.round(unitPrice * seller.priceFactor * variation),
      deliveryDays: seller.deliveryDays,
      message: null,
      source: "simulated",
      firstRoundUnit: null
    };
  });
  const roundsData = [];

  for (let round = 1; round <= rounds; round++) {
    if (round > 1) emit({ type: "round", round, rounds });
    const best = state.reduce((a, b) => (b.unit < a.unit ? b : a));
    const context = round === 1 ? null : {
      round, rounds,
      bidCount: state.length,
      bestUnitPrice: best.unit,
      bestDeliveryDays: best.deliveryDays
    };

    state = await Promise.all(state.map(async s => {
      const next = { ...s };
      if (useAgents) {
        try {
          const bid = await getSellerBid(s.seller, agentRequest, context && { ...context, previous: { unitPrice: s.unit, deliveryDays: s.deliveryDays } });
          const agentUnit = Math.round(Number(bid.unitPrice));
          const agentDays = Math.round(Number(bid.deliveryDays));
          if (Number.isFinite(agentUnit) && agentUnit > 0) {
            // Clamp: never below the seller's cost floor, never absurdly far from the target.
            const low = Math.max(floorFor(s.seller), Math.round(unitPrice * 0.5));
            next.unit = Math.min(Math.max(agentUnit, low), Math.round(unitPrice * 2));
            if (Number.isFinite(agentDays) && agentDays > 0) next.deliveryDays = Math.min(agentDays, 30);
            next.message = typeof bid.message === "string" ? bid.message.slice(0, 300) : next.message;
            next.source = "ai-agent";
          }
        } catch (err) {
          console.error(`Agent for ${s.seller.id} failed in round ${round}, keeping previous bid:`, err.message);
        }
      }
      if (next.firstRoundUnit === null) next.firstRoundUnit = next.unit;
      emit({ type: "agent", role: "seller", id: s.seller.id, name: s.seller.name, round, source: next.source });
      return next;
    }));
    roundsData.push({ round, bids: state.map(s => ({ id: s.seller.id, unitPrice: s.unit, deliveryDays: s.deliveryDays })) });
  }

  const bids = state.map(s => {
    const total = s.unit * quantity;
    const score = Math.round(
      s.seller.reliability * 0.45 +
      (100 - Math.min(100, Math.max(0, (s.unit / unitPrice - 0.8) * 250))) * 0.4 +
      (100 - s.deliveryDays * 5) * 0.15
    );
    return {
      ...s.seller, deliveryDays: s.deliveryDays, product, quantity, unitPrice: s.unit, totalPrice: total,
      formattedTotal: `₦${money(total)}`, score, message: s.message, source: s.source,
      firstRoundUnitPrice: s.firstRoundUnit
    };
  }).sort((a, b) => b.score - a.score);

  // Auctioneer agent picks the winner; fall back to the top-scored bid if it fails or answers invalidly.
  let winningBid = bids[0];
  let auctioneer = { source: "simulated", reasoning: "Highest weighted score (reliability, price, delivery)." };
  if (useAgents) {
    try {
      const decision = await getAuctioneerDecision(bids, agentRequest);
      const picked = bids.find(b => b.id === decision.winnerId);
      if (picked) {
        winningBid = picked;
        auctioneer = { source: "ai-agent", reasoning: String(decision.reasoning || "").slice(0, 500) };
      }
    } catch (err) {
      console.error("Auctioneer agent failed, using top score:", err.message);
    }
  }
  emit({ type: "agent", role: "auctioneer", id: "auctioneer", name: "Auctioneer", round: rounds, source: auctioneer.source });

  const buyers = await buyersPromise;
  // Costs are computed in code (never by the model) from the declared shares.
  const totalBuyerQty = buyers.reduce((sum, b) => sum + b.quantity, 0);
  const allocations = buyers.map(b => {
    const share = b.quantity / totalBuyerQty;
    const amount = Math.round(winningBid.totalPrice * share);
    return { ...b, sharePercent: Math.round(share * 100), amount, formattedAmount: `₦${money(amount)}` };
  });

  return {
    id: `auction-${Date.now()}-${randomBytes(3).toString("hex")}`,
    status: "completed",
    product,
    quantity,
    targetUnitPrice: unitPrice,
    roundsRun: rounds,
    rounds: roundsData,
    bids,
    winningBid,
    auctioneer,
    allocations,
    escrow: {
      status: "awaiting-deposits",
      requiredAmount: winningBid.totalPrice,
      requiredAmountFormatted: `₦${money(winningBid.totalPrice)}`,
      buyerCount: allocations.length,
      deliveryConfirmationRequired: true
    },
    savings: Math.max(0, Math.round((unitPrice * quantity) - winningBid.totalPrice)),
    createdAt: new Date().toISOString()
  };
}
