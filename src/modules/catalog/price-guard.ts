// The one promise the AI must never break: every price it says comes from the
// seller's catalog. A made-up price in a DM is a promise the seller then has to
// honour or retract in front of a customer.
//
// The AI service runs the same check; this copy is the last line before a
// message leaves, so a regression there cannot reach a customer.

const UNIT: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  l: 1e5,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
};

const CURRENCY_FIRST =
  /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|l|cr|crores?)?\b/gi;
const CURRENCY_LAST =
  /\b([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|cr|crores?)?\s*(?:rs\.?|rupees?|\/-|inr)(?![a-z])/gi;
const UNIT_ONLY = /\b(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr)\b/gi;

function toNumber(raw: string, unit?: string): number {
  const n = Number(raw.replace(/,/g, ''));
  return unit ? n * (UNIT[unit.toLowerCase()] ?? 1) : n;
}

/** Every money amount written in a message, in rupees. */
export function extractAmounts(text: string): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const re of [CURRENCY_FIRST, CURRENCY_LAST, UNIT_ONLY]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const n = toNumber(m[1], m[2]);
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  }
  return [...new Set(out)];
}

export type PriceSource = {
  priceMin?: number | null;
  priceMax?: number | null;
  variants?: Array<{ price?: number | null }>;
};

export function allowedAmounts(
  offerings: PriceSource[],
  extra: number[] = [],
): number[] {
  const set = new Set<number>(extra);
  for (const o of offerings) {
    if (o.priceMin != null) set.add(o.priceMin);
    if (o.priceMax != null) set.add(o.priceMax);
    for (const v of o.variants || []) if (v.price != null) set.add(v.price);
  }
  return [...set];
}

/**
 * Amounts in `reply` that are neither catalog prices nor something the customer
 * said themselves (a budget, say). A 1% tolerance absorbs rounding such as
 * "₹18k" for 18,000.
 */
export function unknownPrices(
  reply: string,
  allowed: number[],
  customerText = '',
): number[] {
  const ok = [...allowed, ...extractAmounts(customerText)];
  return extractAmounts(reply).filter(
    (n) => !ok.some((a) => Math.abs(a - n) <= Math.max(1, a * 0.01)),
  );
}
