// One catalog shape serves every industry. What changes per industry lives
// here: which offering types it sells, how prices are worded, what the AI is
// trying to get to (an order or a lead), and which details it must collect
// before handing a lead to the seller. Adding an industry is a new entry here,
// not a migration.

export type Goal = 'ORDER' | 'LEAD' | 'BOOKING';

export type LeadField = {
  key: string;
  label: string;
  // Short question the AI can ask, in Hinglish, when the field is missing.
  ask: string;
};

export type IndustryTemplate = {
  code: string;
  label: string;
  offeringTypes: string[];
  defaultType: string;
  defaultPriceMode: string;
  goal: Goal;
  leadFields: LeadField[];
  // Attributes the catalog form offers for this industry (stored in Offering.attributes).
  attributes: Array<{ key: string; label: string }>;
  // Industry rules the reply must follow, added to the AI prompt.
  rules: string[];
};

const DATE: LeadField = {
  key: 'date',
  label: 'Date',
  ask: 'Kis date ke liye chahiye?',
};
const CITY: LeadField = {
  key: 'city',
  label: 'City',
  ask: 'Aap kis city me ho?',
};
const PHONE: LeadField = {
  key: 'phone',
  label: 'Phone',
  ask: 'Aapka WhatsApp number share kar do, team call karegi.',
};

export const INDUSTRIES: Record<string, IndustryTemplate> = {
  APPAREL: {
    code: 'APPAREL',
    label: 'Clothing & fashion',
    offeringTypes: ['PRODUCT'],
    defaultType: 'PRODUCT',
    defaultPriceMode: 'FIXED',
    goal: 'ORDER',
    leadFields: [],
    attributes: [
      { key: 'fabric', label: 'Fabric' },
      { key: 'fit', label: 'Fit' },
      { key: 'care', label: 'Care' },
    ],
    rules: [
      'Share the exact price and the order link for the item asked about.',
      'If a size or colour is out of stock, say so and offer the nearest available one.',
    ],
  },
  FOOTWEAR: {
    code: 'FOOTWEAR',
    label: 'Footwear',
    offeringTypes: ['PRODUCT'],
    defaultType: 'PRODUCT',
    defaultPriceMode: 'FIXED',
    goal: 'ORDER',
    leadFields: [],
    attributes: [
      { key: 'material', label: 'Material' },
      { key: 'sole', label: 'Sole' },
      { key: 'fit', label: 'Fit (true to size, runs small…)' },
    ],
    rules: [
      'Share the exact price and the order link for the shoe asked about.',
      'When a size is asked, answer from the variant stock only.',
    ],
  },
  BEAUTY_SERVICE: {
    code: 'BEAUTY_SERVICE',
    label: 'Makeup artist / salon',
    offeringTypes: ['SERVICE', 'PACKAGE'],
    defaultType: 'SERVICE',
    defaultPriceMode: 'STARTING_FROM',
    goal: 'BOOKING',
    leadFields: [
      {
        key: 'date',
        label: 'Event date',
        ask: 'Aapka function kis date ko hai?',
      },
      CITY,
      {
        key: 'people',
        label: 'People',
        ask: 'Kitne logon ka makeup karwana hai?',
      },
    ],
    attributes: [
      { key: 'duration', label: 'Duration' },
      { key: 'products', label: 'Products used' },
      { key: 'travel', label: 'Travel / venue policy' },
    ],
    rules: [
      'Prices are "starting from"; say the final quote depends on the look and venue.',
      'Mention the advance needed to block the date if the policy has one.',
      'Never confirm a booking yourself; collect the details and say the artist will confirm.',
    ],
  },
  HOTEL: {
    code: 'HOTEL',
    label: 'Hotel / homestay',
    offeringTypes: ['ROOM', 'PACKAGE'],
    defaultType: 'ROOM',
    defaultPriceMode: 'PER_NIGHT',
    goal: 'BOOKING',
    leadFields: [
      { key: 'checkIn', label: 'Check-in', ask: 'Check-in kis date ko hai?' },
      { key: 'nights', label: 'Nights', ask: 'Kitni raaton ke liye?' },
      { key: 'guests', label: 'Guests', ask: 'Kitne guests honge?' },
    ],
    attributes: [
      { key: 'occupancy', label: 'Max guests' },
      { key: 'amenities', label: 'Amenities' },
      { key: 'meals', label: 'Meals included' },
    ],
    rules: [
      'Quote per-night prices; weekend or season rates only if a variant says so.',
      'Never promise a room is free; say the team will confirm availability.',
    ],
  },
  TRAVEL: {
    code: 'TRAVEL',
    label: 'Travel agency',
    offeringTypes: ['TRIP', 'PACKAGE'],
    defaultType: 'TRIP',
    defaultPriceMode: 'PER_PERSON',
    goal: 'LEAD',
    leadFields: [
      { key: 'date', label: 'Travel month', ask: 'Kab travel karna hai?' },
      { key: 'people', label: 'Travellers', ask: 'Kitne log jaa rahe ho?' },
      {
        key: 'fromCity',
        label: 'From city',
        ask: 'Kaunsi city se start karoge?',
      },
    ],
    attributes: [
      { key: 'duration', label: 'Duration (e.g. 5N/6D)' },
      { key: 'inclusions', label: 'Inclusions' },
      { key: 'exclusions', label: 'Exclusions' },
    ],
    rules: [
      'Prices are per person; say flights or taxes are extra when the exclusions say so.',
      'Collect travel month, travellers and starting city, then hand over to the team.',
    ],
  },
  REAL_ESTATE: {
    code: 'REAL_ESTATE',
    label: 'Real estate',
    offeringTypes: ['PROPERTY'],
    defaultType: 'PROPERTY',
    defaultPriceMode: 'RANGE',
    goal: 'LEAD',
    leadFields: [
      { key: 'budget', label: 'Budget', ask: 'Aapka budget kitna hai?' },
      { key: 'config', label: 'Configuration', ask: '2BHK chahiye ya 3BHK?' },
      {
        key: 'visitDate',
        label: 'Site visit',
        ask: 'Site visit ke liye kaunsa din theek rahega?',
      },
      PHONE,
    ],
    attributes: [
      { key: 'location', label: 'Location' },
      { key: 'area', label: 'Carpet area' },
      { key: 'rera', label: 'RERA number' },
      { key: 'possession', label: 'Possession' },
    ],
    rules: [
      'Only quote the listed price range; never negotiate or promise discounts.',
      'Mention the RERA number when it is listed.',
      'The goal is a site visit; collect budget, configuration and a visit day.',
    ],
  },
  FOOD: {
    code: 'FOOD',
    label: 'Restaurant / cafe / bakery',
    offeringTypes: ['MENU_ITEM', 'PACKAGE'],
    defaultType: 'MENU_ITEM',
    defaultPriceMode: 'FIXED',
    goal: 'ORDER',
    leadFields: [],
    attributes: [
      { key: 'veg', label: 'Veg / non-veg' },
      { key: 'serves', label: 'Serves' },
    ],
    rules: ['Share the price and the order or table booking link.'],
  },
  OTHER: {
    code: 'OTHER',
    label: 'Other',
    offeringTypes: ['PRODUCT', 'SERVICE', 'PACKAGE'],
    defaultType: 'PRODUCT',
    defaultPriceMode: 'FIXED',
    goal: 'LEAD',
    leadFields: [DATE, PHONE],
    attributes: [],
    rules: [],
  },
};

export function industryOf(code?: string | null): IndustryTemplate {
  return INDUSTRIES[code || ''] || INDUSTRIES.APPAREL;
}

export const OFFERING_TYPES = [
  'PRODUCT',
  'SERVICE',
  'PACKAGE',
  'ROOM',
  'PROPERTY',
  'TRIP',
  'MENU_ITEM',
];
export const PRICE_MODES = [
  'FIXED',
  'STARTING_FROM',
  'RANGE',
  'PER_NIGHT',
  'PER_PERSON',
  'ON_REQUEST',
];

/** How a price reads to a customer, e.g. "₹18,000 se start" or "₹3,200 per night". */
export function priceLabel(o: {
  priceMode: string;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
}): string {
  const fmt = (n: number) =>
    `${o.currency === 'INR' ? '₹' : `${o.currency} `}${Math.round(n).toLocaleString('en-IN')}`;
  const min = o.priceMin ?? null;
  const max = o.priceMax ?? null;
  if (o.priceMode === 'ON_REQUEST' || (min == null && max == null))
    return 'price on request';
  const base = fmt((min ?? max) as number);
  switch (o.priceMode) {
    case 'STARTING_FROM':
      return `${base} se start`;
    case 'RANGE':
      return max != null && min != null && max !== min
        ? `${fmt(min)} – ${fmt(max)}`
        : base;
    case 'PER_NIGHT':
      return `${base} per night`;
    case 'PER_PERSON':
      return `${base} per person`;
    default:
      return base;
  }
}

// ------------------------------------------------------------- offer type

export const OFFER_TYPES = ['PRODUCTS', 'SERVICES', 'BOTH'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

const PRODUCT_INDUSTRIES = ['APPAREL', 'FOOTWEAR', 'FOOD'];
const SERVICE_INDUSTRIES = ['BEAUTY_SERVICE', 'HOTEL', 'TRAVEL', 'REAL_ESTATE'];

/** What a business sells when the seller has not said (matches the backfill). */
export function defaultOfferType(industry: string | null | undefined): OfferType {
  if (PRODUCT_INDUSTRIES.includes(industry || '')) return 'PRODUCTS';
  if (SERVICE_INDUSTRIES.includes(industry || '')) return 'SERVICES';
  return 'BOTH';
}

// Offering types that count as a product; everything else is a service.
const PRODUCT_TYPES = ['PRODUCT', 'MENU_ITEM'];

export function offeringKind(type: string): 'PRODUCTS' | 'SERVICES' {
  return PRODUCT_TYPES.includes(type) ? 'PRODUCTS' : 'SERVICES';
}
