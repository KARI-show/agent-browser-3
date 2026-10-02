// $ per million tokens, from the published price list. Used only to turn token
// usage into a spend figure for the trial budgets — update when prices change.
// Cache reads cost 0.1x input; cache writes 1.25x (5 min TTL) or 2x (1 hour TTL).
export const PRICES = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5-1": { in: 10, out: 50 },
};

const UNKNOWN = { in: 10, out: 50 }; // never under-charge a model we don't know

/** Price entry for a model id; dated ids ("claude-haiku-4-5-20251001") match their base id. */
export function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  let best = null;
  for (const id of Object.keys(PRICES)) if (model.startsWith(id + "-") && (!best || id.length > best.length)) best = id;
  return best ? PRICES[best] : UNKNOWN;
}

/**
 * Micro-dollars (1e-6 USD) for a usage record. `usage.cache_creation` (the API's
 * 5m/1h breakdown) is honoured when present; otherwise cache writes are priced at
 * `fallbackWriteMult` (use 2 when the request asked for a 1-hour TTL).
 */
export function costMicroUsd(model, usage, fallbackWriteMult = 1.25) {
  const p = priceFor(model);
  const input = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cc = usage.cache_creation;
  let write;
  if (cc && (typeof cc.ephemeral_5m_input_tokens === "number" || typeof cc.ephemeral_1h_input_tokens === "number")) {
    write = (cc.ephemeral_5m_input_tokens || 0) * 1.25 + (cc.ephemeral_1h_input_tokens || 0) * 2;
  } else {
    write = (usage.cache_creation_input_tokens || 0) * fallbackWriteMult;
  }
  // $/MTok == micro-dollars per token
  return Math.ceil(input * p.in + cacheRead * p.in * 0.1 + write * p.in + output * p.out);
}

/** Worst case of a request before it runs: every input token at the dearest (1h cache write) rate, all of max_tokens generated. */
export function reserveMicroUsd(model, inputTokens, maxTokens) {
  const p = priceFor(model);
  return Math.ceil(inputTokens * p.in * 2 + maxTokens * p.out);
}
