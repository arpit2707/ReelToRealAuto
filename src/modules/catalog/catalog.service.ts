import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import {
  INDUSTRIES,
  OFFERING_TYPES,
  PRICE_MODES,
  industryOf,
} from './industries';
import { parseCsv } from './csv';
import {
  LANGUAGES,
  REPLY_LANGUAGES,
  SERVICES,
  TONES,
  REPLY_TONES,
  missingForActivation,
  missingForOnboarding,
  onboardingStatus,
} from './onboarding';

const SHOPIFY_API_VERSION = '2024-10';

export type VariantInput = {
  label: string;
  options?: Record<string, string> | null;
  price?: number | null;
  stock?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
};

export type OfferingInput = {
  type?: string;
  title: string;
  description?: string | null;
  priceMode?: string;
  priceMin?: number | null;
  priceMax?: number | null;
  currency?: string;
  attributes?: Record<string, string> | null;
  actionUrl?: string | null;
  imageUrl?: string | null;
  sku?: string | null;
  isActive?: boolean;
  bookable?: boolean;
  dailyCapacity?: number | null;
  variants?: VariantInput[];
  // For a PACKAGE: the offerings it bundles.
  componentIds?: string[];
};

export type ProfileInput = {
  industry?: string;
  description?: string | null;
  city?: string | null;
  serviceAreas?: string[];
  hours?: string | null;
  policies?: Record<string, string> | null;
  faqs?: Array<{ q: string; a: string }> | null;
  alertPhone?: string | null;
  autoTagPosts?: boolean;
  businessName?: string | null;
  audience?: string | null;
  tone?: string | null;
  replyTone?: string | null;
  language?: string | null;
  replyLanguage?: string | null;
  services?: string[];
  // True finishes setup and switches the chosen automations on.
  completeOnboarding?: boolean;
};

const OFFERING_INCLUDE = {
  variants: { orderBy: { position: 'asc' as const } },
  components: { include: { item: { select: { id: true, title: true } } } },
  _count: {
    select: { postLinks: { where: { status: { not: 'SELLER_REJECTED' } } } },
  },
};

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  // ---------------------------------------------------------------- profile

  async getProfile(orgId: string) {
    const profile = await this.prisma.businessProfile.findUnique({
      where: { orgId },
    });
    return {
      profile: profile ?? {
        orgId,
        industry: 'APPAREL',
        serviceAreas: [],
        autoTagPosts: true,
        services: [],
        activatedAt: null,
      },
      onboarding: onboardingStatus(profile),
      template: industryOf(profile?.industry),
      services: SERVICES,
      industries: Object.values(INDUSTRIES).map((i) => ({
        code: i.code,
        label: i.label,
        goal: i.goal,
      })),
    };
  }

  async saveProfile(orgId: string, input: ProfileInput) {
    if (input.industry && !INDUSTRIES[input.industry]) {
      throw new BadRequestException(`Unknown industry ${input.industry}`);
    }
    const tone = input.tone ?? input.replyTone;
    if (tone && !TONES.includes(tone)) {
      throw new BadRequestException(`Unknown tone ${tone}`);
    }
    const language = input.language ?? input.replyLanguage;
    if (language && !LANGUAGES.includes(language)) {
      throw new BadRequestException(`Unknown language ${language}`);
    }
    const unknown = (input.services || []).filter(
      (c) => !SERVICES.some((s) => s.code === c),
    );
    if (unknown.length) {
      throw new BadRequestException(`Unknown service ${unknown.join(', ')}`);
    }
    const data = {
      industry: input.industry,
      description: input.description,
      city: input.city,
      serviceAreas: input.serviceAreas?.map((s) => s.trim()).filter(Boolean),
      hours: input.hours,
      policies:
        input.policies === null
          ? Prisma.DbNull
          : (input.policies as Prisma.InputJsonValue | undefined),
      faqs:
        input.faqs === null
          ? Prisma.DbNull
          : (input.faqs?.filter((f) => f.q?.trim() && f.a?.trim()) as
              Prisma.InputJsonValue | undefined),
      alertPhone:
        input.alertPhone === undefined
          ? undefined
          : normalizePhone(input.alertPhone),
      businessName: input.businessName?.trim() ?? input.businessName,
      audience: input.audience,
      tone: input.tone ?? input.replyTone,
      replyTone: input.replyTone ?? input.tone,
      language: input.language ?? input.replyLanguage,
      replyLanguage: input.replyLanguage ?? input.language,
      services: input.services ? [...new Set(input.services)] : undefined,
    };
    if (input.completeOnboarding) {
      const existing = await this.prisma.businessProfile.findUnique({
        where: { orgId },
      });
      const missing = missingForOnboarding({
        industry: input.industry ?? existing?.industry,
        description: input.description ?? existing?.description,
      });
      if (missing.length) {
        throw new BadRequestException(
          `Tell us more before switching on automation: ${missing.join(', ')}`,
        );
      }
    }
    const onboardedAt = input.completeOnboarding ? new Date() : undefined;
    await this.prisma.businessProfile.upsert({
      where: { orgId },
      update: {
        ...data,
        ...(onboardedAt ? { onboardedAt, activatedAt: onboardedAt } : {}),
      },
      create: {
        orgId,
        ...data,
        industry: input.industry || 'APPAREL',
        onboardedAt,
        activatedAt: onboardedAt,
      },
    });
    return this.getProfile(orgId);
  }

  /** Switches automation on once the seller has told us enough about the page. */
  async activate(orgId: string) {
    const profile = await this.prisma.businessProfile.findUnique({
      where: { orgId },
    });
    const missing = missingForActivation(profile);
    if (missing.length) {
      throw new BadRequestException({
        message: 'Finish the business setup before turning automation on',
        missing,
      });
    }
    if (!profile!.activatedAt) {
      await this.prisma.businessProfile.update({
        where: { orgId },
        data: { activatedAt: new Date() },
      });
    }
    return this.getProfile(orgId);
  }

  async deactivate(orgId: string) {
    await this.prisma.businessProfile.updateMany({
      where: { orgId },
      data: { activatedAt: null },
    });
    return this.getProfile(orgId);
  }

  // -------------------------------------------------------------- offerings

  listOfferings(orgId: string, opts: { includeInactive?: boolean } = {}) {
    return this.prisma.offering.findMany({
      where: { orgId, ...(opts.includeInactive ? {} : { isActive: true }) },
      include: OFFERING_INCLUDE,
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async getOffering(orgId: string, id: string) {
    const o = await this.prisma.offering.findFirst({
      where: { id, orgId },
      include: OFFERING_INCLUDE,
    });
    if (!o) throw new NotFoundException('Offering not found');
    return o;
  }

  async createOffering(orgId: string, input: OfferingInput) {
    const clean = await this.validate(orgId, input);
    const created = await this.prisma.offering.create({
      data: {
        orgId,
        ...clean.fields,
        source: 'MANUAL',
        variants: { create: clean.variants },
        components: {
          create: clean.componentIds.map((itemId) => ({ itemId })),
        },
      },
    });
    return this.getOffering(orgId, created.id);
  }

  async updateOffering(orgId: string, id: string, input: OfferingInput) {
    await this.getOffering(orgId, id);
    const clean = await this.validate(orgId, input, id);
    await this.prisma.$transaction([
      this.prisma.offering.update({ where: { id }, data: clean.fields }),
      ...(input.variants
        ? [
            this.prisma.offeringVariant.deleteMany({
              where: { offeringId: id },
            }),
            this.prisma.offeringVariant.createMany({
              data: clean.variants.map((v) => ({ ...v, offeringId: id })),
            }),
          ]
        : []),
      ...(input.componentIds
        ? [
            this.prisma.packageItem.deleteMany({ where: { packageId: id } }),
            this.prisma.packageItem.createMany({
              data: clean.componentIds.map((itemId) => ({
                packageId: id,
                itemId,
              })),
            }),
          ]
        : []),
    ]);
    return this.getOffering(orgId, id);
  }

  async deleteOffering(orgId: string, id: string) {
    await this.getOffering(orgId, id);
    await this.prisma.offering.delete({ where: { id } });
    return { ok: true };
  }

  private async validate(orgId: string, input: OfferingInput, selfId?: string) {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('Title is required');
    const type = input.type || 'PRODUCT';
    if (!OFFERING_TYPES.includes(type))
      throw new BadRequestException(`Unknown type ${type}`);
    const priceMode = input.priceMode || 'FIXED';
    if (!PRICE_MODES.includes(priceMode))
      throw new BadRequestException(`Unknown price mode ${priceMode}`);
    const priceMin = numOrNull(input.priceMin);
    const priceMax = numOrNull(input.priceMax);
    if (priceMin != null && priceMax != null && priceMax < priceMin) {
      throw new BadRequestException('Maximum price is lower than the minimum');
    }
    const variants = (input.variants || [])
      .filter((v) => v.label?.trim())
      .map((v, i) => ({
        label: v.label.trim(),
        options: (v.options || undefined) as Prisma.InputJsonValue | undefined,
        price: numOrNull(v.price),
        stock:
          v.stock == null || (v.stock as unknown) === ''
            ? null
            : Math.max(0, Math.round(Number(v.stock))),
        validFrom: v.validFrom ? new Date(v.validFrom) : null,
        validTo: v.validTo ? new Date(v.validTo) : null,
        position: i,
      }));
    let componentIds = [...new Set(input.componentIds || [])].filter(
      (c) => c !== selfId,
    );
    if (componentIds.length) {
      const found = await this.prisma.offering.findMany({
        where: { orgId, id: { in: componentIds } },
        select: { id: true },
      });
      componentIds = found.map((f) => f.id);
    }
    return {
      fields: {
        type,
        title,
        description: input.description?.trim() || null,
        priceMode,
        priceMin,
        priceMax,
        currency: input.currency || 'INR',
        attributes: (input.attributes || undefined) as
          Prisma.InputJsonValue | undefined,
        actionUrl: input.actionUrl?.trim() || null,
        imageUrl: input.imageUrl?.trim() || null,
        sku: input.sku?.trim() || null,
        isActive: input.isActive ?? true,
        bookable: input.bookable ?? false,
        dailyCapacity:
          input.dailyCapacity == null
            ? null
            : Math.max(1, Math.round(Number(input.dailyCapacity))),
      },
      variants,
      componentIds,
    };
  }

  // ------------------------------------------------------------- CSV import

  /**
   * One row per offering, or several rows with the same title (or SKU) for its
   * variants. Columns (header names, any order, case-insensitive):
   * title, type, price, price_max, price_mode, description, variant,
   * variant_price, stock, link, sku, image.
   */
  async importCsv(orgId: string, csv: string) {
    const rows = parseCsv(csv);
    if (rows.length < 2)
      throw new BadRequestException('The file has no rows under the header');
    const header = rows[0].map((h) =>
      h.trim().toLowerCase().replace(/\s+/g, '_'),
    );
    const col = (name: string) => header.indexOf(name);
    if (col('title') < 0)
      throw new BadRequestException('The file needs a "title" column');

    const profile = await this.prisma.businessProfile.findUnique({
      where: { orgId },
    });
    const template = industryOf(profile?.industry);
    const groups = new Map<
      string,
      { input: OfferingInput; line: number; invalid: boolean }
    >();
    const errors: string[] = [];

    rows.slice(1).forEach((r, idx) => {
      const get = (name: string) =>
        col(name) >= 0 ? (r[col(name)] || '').trim() : '';
      const title = get('title');
      if (!title) return;
      const key = (get('sku') || title).toLowerCase();
      const price = parsePrice(get('price'));
      const variant = get('variant');
      let g = groups.get(key);
      if (!g) {
        const type = (get('type') || template.defaultType).toUpperCase();
        const priceMode = (
          get('price_mode') || template.defaultPriceMode
        ).toUpperCase();
        const problems: string[] = [];
        if (!OFFERING_TYPES.includes(type))
          problems.push(`unknown type "${type}"`);
        if (!PRICE_MODES.includes(priceMode))
          problems.push(`unknown price_mode "${priceMode}"`);
        if (get('price') && price == null)
          problems.push(`price "${get('price')}" is not a number`);
        // A row with a problem is reported and skipped, never imported with
        // a guessed value: a wrong price here would reach customers.
        if (problems.length)
          errors.push(`Row ${idx + 2} (${title}): ${problems.join(', ')}`);
        g = {
          line: idx + 2,
          invalid: problems.length > 0,
          input: {
            title,
            type: OFFERING_TYPES.includes(type) ? type : template.defaultType,
            priceMode: PRICE_MODES.includes(priceMode)
              ? priceMode
              : template.defaultPriceMode,
            priceMin: price,
            priceMax: parsePrice(get('price_max')),
            description: get('description') || null,
            actionUrl: get('link') || null,
            imageUrl: get('image') || null,
            sku: get('sku') || null,
            variants: [],
          },
        };
        groups.set(key, g);
      }
      if (variant) {
        g.input.variants!.push({
          label: variant,
          price: parsePrice(get('variant_price')) ?? price,
          stock: get('stock') === '' ? null : Number(get('stock')),
        });
      }
    });

    let created = 0;
    let updated = 0;
    for (const [key, { input, line, invalid }] of groups) {
      if (invalid) continue;
      try {
        const clean = await this.validate(orgId, input);
        const externalRef = key;
        const existing = await this.prisma.offering.findUnique({
          where: {
            orgId_source_externalRef: { orgId, source: 'CSV', externalRef },
          },
        });
        if (existing) {
          await this.prisma.$transaction([
            this.prisma.offering.update({
              where: { id: existing.id },
              data: clean.fields,
            }),
            this.prisma.offeringVariant.deleteMany({
              where: { offeringId: existing.id },
            }),
            this.prisma.offeringVariant.createMany({
              data: clean.variants.map((v) => ({
                ...v,
                offeringId: existing.id,
              })),
            }),
          ]);
          updated += 1;
        } else {
          await this.prisma.offering.create({
            data: {
              orgId,
              ...clean.fields,
              source: 'CSV',
              externalRef,
              variants: { create: clean.variants },
            },
          });
          created += 1;
        }
      } catch (err: any) {
        errors.push(
          `Row ${line} (${input.title}): ${err?.response?.message || err.message}`,
        );
      }
    }
    return { created, updated, errors };
  }

  // ----------------------------------------------------------- Shopify sync

  async syncShopify(orgId: string) {
    const store = await this.prisma.shopifyStore.findFirst({
      where: { orgId },
    });
    if (!store)
      throw new BadRequestException(
        'No Shopify store is connected to this workspace',
      );
    let token: string;
    try {
      token = this.crypto.decrypt(store.accessTokenEncrypted);
    } catch {
      throw new BadRequestException(
        'The Shopify access token could not be read; reconnect the store',
      );
    }

    let url: string | null =
      `https://${store.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json?status=active&limit=250&fields=id,title,body_html,handle,variants,images,image,product_type`;
    let created = 0;
    let updated = 0;
    const seen: string[] = [];
    while (url) {
      const res = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token },
      });
      if (!res.ok) {
        throw new BadRequestException(
          `Shopify refused the product list (${res.status}): ${(await res.text()).slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as { products?: any[] };
      for (const p of json.products || []) {
        const externalRef = String(p.id);
        seen.push(externalRef);
        const prices = (p.variants || [])
          .map((v: any) => Number(v.price))
          .filter((n: number) => Number.isFinite(n));
        const fields = {
          type: 'PRODUCT',
          title: String(p.title || 'Untitled'),
          description: stripHtml(p.body_html || '').slice(0, 2000) || null,
          priceMode: 'FIXED',
          priceMin: prices.length ? Math.min(...prices) : null,
          priceMax: prices.length ? Math.max(...prices) : null,
          currency: 'INR',
          actionUrl: p.handle
            ? `https://${store.shopDomain}/products/${p.handle}`
            : null,
          imageUrl: p.image?.src || p.images?.[0]?.src || null,
          isActive: true,
        };
        const variants = (p.variants || []).map((v: any, i: number) => ({
          label: String(v.title || `Variant ${i + 1}`),
          options: optionMap(v),
          price: Number.isFinite(Number(v.price)) ? Number(v.price) : null,
          stock: v.inventory_quantity ?? null,
          position: i,
        }));
        const existing = await this.prisma.offering.findUnique({
          where: {
            orgId_source_externalRef: { orgId, source: 'SHOPIFY', externalRef },
          },
        });
        if (existing) {
          await this.prisma.$transaction([
            this.prisma.offering.update({
              where: { id: existing.id },
              data: fields,
            }),
            this.prisma.offeringVariant.deleteMany({
              where: { offeringId: existing.id },
            }),
            this.prisma.offeringVariant.createMany({
              data: variants.map((v: any) => ({
                ...v,
                offeringId: existing.id,
              })),
            }),
          ]);
          updated += 1;
        } else {
          await this.prisma.offering.create({
            data: {
              orgId,
              ...fields,
              source: 'SHOPIFY',
              externalRef,
              variants: { create: variants },
            },
          });
          created += 1;
        }
      }
      url = nextLink(res.headers.get('link'));
    }
    // Products removed or archived in Shopify stop being offered, but keep
    // their post links in case they come back.
    const deactivated = await this.prisma.offering.updateMany({
      where: {
        orgId,
        source: 'SHOPIFY',
        externalRef: { notIn: seen },
        isActive: true,
      },
      data: { isActive: false },
    });
    return { created, updated, deactivated: deactivated.count };
  }

  // ---------------------------------------------------------- availability

  listBlockedDates(orgId: string, offeringId: string) {
    return this.prisma.offeringBlockedDate.findMany({
      where: { offeringId, offering: { orgId } },
      orderBy: { date: 'asc' },
    });
  }

  async setBlockedDate(
    orgId: string,
    offeringId: string,
    date: string,
    booked: number | null,
    note?: string,
  ) {
    await this.getOffering(orgId, offeringId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new BadRequestException('Date must be YYYY-MM-DD');
    return this.prisma.offeringBlockedDate.upsert({
      where: { offeringId_date: { offeringId, date } },
      update: { booked, note },
      create: { offeringId, date, booked, note },
    });
  }

  async clearBlockedDate(orgId: string, offeringId: string, date: string) {
    await this.getOffering(orgId, offeringId);
    await this.prisma.offeringBlockedDate.deleteMany({
      where: { offeringId, date },
    });
    return { ok: true };
  }

  /** "free" | "full" | "limited", for the dates a customer asked about. */
  async availability(offeringIds: string[], dates: string[]) {
    if (!offeringIds.length || !dates.length) return [];
    const [offerings, blocked] = await Promise.all([
      this.prisma.offering.findMany({
        where: { id: { in: offeringIds }, bookable: true },
        select: { id: true, dailyCapacity: true },
      }),
      this.prisma.offeringBlockedDate.findMany({
        where: { offeringId: { in: offeringIds }, date: { in: dates } },
      }),
    ]);
    const out: Array<{
      offeringId: string;
      date: string;
      status: 'free' | 'full' | 'limited';
    }> = [];
    for (const o of offerings) {
      for (const date of dates) {
        const b = blocked.find((x) => x.offeringId === o.id && x.date === date);
        let status: 'free' | 'full' | 'limited' = 'free';
        if (b) {
          if (
            b.booked == null ||
            o.dailyCapacity == null ||
            b.booked >= o.dailyCapacity
          )
            status = 'full';
          else status = 'limited';
        }
        out.push({ offeringId: o.id, date, status });
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ helpers

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    throw new BadRequestException(`"${String(v)}" is not a valid price`);
  return n;
}

function parsePrice(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[₹,\s]|rs\.?|inr/gi, ''));
  return Number.isFinite(n) ? n : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function optionMap(v: any): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  ['option1', 'option2', 'option3'].forEach((k, i) => {
    if (v[k] && v[k] !== 'Default Title') out[`option${i + 1}`] = String(v[k]);
  });
  return Object.keys(out).length ? out : undefined;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  const m = header.split(',').find((p) => p.includes('rel="next"'));
  return m ? m.slice(m.indexOf('<') + 1, m.indexOf('>')) : null;
}

export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 10 ? `91${digits}` : digits;
}
