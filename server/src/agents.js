import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.AGENT_MODEL || "claude-haiku-5-5";

export const agentsEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client;
const getClient = () => (client ??= new Anthropic());

/** Running token totals since the server started, so spend can be watched (see /api/health). */
export const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("agent returned no JSON");
  return JSON.parse(match[0]);
}

async function ask(system, user, maxTokens = 600) {
  const strict = `${system} Output the JSON object only: no text before or after it, and no markdown fences.`;
  let lastError;
  // One retry: occasionally a model replies with prose or a truncated object.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await getClient().messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system: strict,
        messages: [{ role: "user", content: user }]
      });
      usage.calls += 1;
      usage.inputTokens += response.usage?.input_tokens ?? 0;
      usage.outputTokens += response.usage?.output_tokens ?? 0;
      return extractJson(response.content.filter(b => b.type === "text").map(b => b.text).join(""));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Ask one seller agent to place a bid. Returns { unitPrice, deliveryDays, message }.
 * `context` is null in round 1. In later rounds it holds the seller's previous bid and the best
 * (anonymous) competing bid, so the seller can undercut, hold, or improve its delivery.
 * The caller clamps values and falls back on error.
 */
export function getSellerBid(seller, request, context = null) {
  const floor = request.floorFor(seller);
  const system =
    `You are an autonomous sales agent for ${seller.name}, a wholesale supplier in ${seller.location}, Nigeria. ` +
    `Your supplier profile: reliability ${seller.reliability}/100, typical price level ${seller.priceFactor}x market, ` +
    `typical delivery ${seller.deliveryDays} days. You compete against other suppliers in a reverse auction. ` +
    `Your costs mean you cannot go below ₦${floor} per unit. Bid competitively but profitably, and stay consistent with your profile. ` +
    `Respond with ONLY a JSON object: {"unitPrice": <integer NGN per unit>, "deliveryDays": <integer>, "message": "<one sentence pitch>"}`;

  const base = `Buyer group request: ${request.quantity} x ${request.product}. Buyers' target price: ₦${request.targetUnitPrice} per unit.`;
  const user = context
    ? `${base} This is round ${context.round} of ${context.rounds}. Your previous bid: ₦${context.previous.unitPrice} per unit, ` +
      `${context.previous.deliveryDays} days. The lowest bid from any seller so far is ₦${context.bestUnitPrice} per unit ` +
      `(${context.bidCount} sellers bid; the leader's delivery is ${context.bestDeliveryDays} days). ` +
      `You may lower your price, hold it, or improve your delivery to win. Place your revised bid.`
    : `${base} Place your bid.`;

  return ask(system, user, 400);
}

/** A buyer agent states how many units its business needs from the group order. */
export function getBuyerDemand(buyer, request) {
  return ask(
    `You are an autonomous purchasing agent for ${buyer.name}, ${buyer.profile}. ` +
      `You are part of a buyer group pooling a bulk order to get a better price. ` +
      `Decide how many units your business needs. Respond with ONLY JSON: ` +
      `{"quantity": <positive integer units>, "message": "<one sentence on why>"}`,
    `The group is buying ${request.quantity} x ${request.product} in total at about ₦${request.targetUnitPrice} per unit. ` +
      `Your usual share is around ${buyer.quantity} units. How many do you need?`
  );
}

/** The auctioneer agent reviews all final bids and picks a winner. Returns { winnerId, reasoning }. */
export function getAuctioneerDecision(bids, request) {
  const summary = bids.map(b => ({
    id: b.id, name: b.name, location: b.location, reliability: b.reliability,
    unitPrice: b.unitPrice, deliveryDays: b.deliveryDays, pitch: b.message
  }));
  return ask(
    `You are the neutral auctioneer agent for a buyer group's procurement auction. ` +
      `Pick the single best bid, balancing price, reliability and delivery time for the buyers. ` +
      `Respond with ONLY JSON: {"winnerId": "<id from the bids>", "reasoning": "<two sentences>"}`,
    `Request: ${request.quantity} x ${request.product}, target ₦${request.targetUnitPrice} per unit.\nBids:\n${JSON.stringify(summary, null, 2)}`,
    900
  );
}
