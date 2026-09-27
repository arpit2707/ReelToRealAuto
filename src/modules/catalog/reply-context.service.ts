import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CatalogService } from './catalog.service';
import { industryOf, priceLabel, type IndustryTemplate } from './industries';

// Suggested links below this confidence are ignored until the seller confirms
// them, so a wrong guess does not put the wrong price in front of a customer.
const MIN_SUGGESTED_CONFIDENCE = 0.6;
const MAX_OFFERINGS = 5;

export type GoalState = {
  offeringIds?: string[];
  fields?: Record<string, string>;
  leadId?: string;
  // ISO time until which the AI stays quiet after handing the chat to a
  // person. Cleared by "Resume AI" in the inbox.
  handedOffUntil?: string;
};

export type ContextOffering = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  price_label: string;
  price_mode: string;
  price_min: number | null;
  price_max: number | null;
  currency: string;
  action_url: string | null;
  attributes: Record<string, unknown> | null;
  variants: Array<{
    label: string;
    price: number | null;
    stock: number | null;
    in_stock: boolean;
  }>;
  includes: string[];
  linked_to_post: boolean;
  availability?: Array<{ date: string; status: string }>;
};

export type ReplyContext = {
  business: {
    industry: string;
    industry_label: string;
    description: string | null;
    city: string | null;
    service_areas: string[];
    hours: string | null;
    policies: Record<string, string> | null;
    faqs: Array<{ q: string; a: string }>;
  };
  playbook: {
    goal: string;
    lead_fields: Array<{ key: string; label: string; ask: string }>;
    rules: string[];
  };
  offerings: ContextOffering[];
  goal_state: GoalState;
  recent_messages: Array<{ from: 'customer' | 'business'; text: string }>;
  template: IndustryTemplate;
  // Every catalog price the reply may mention; used by the price guard.
  allowed_prices: number[];
};

const STOP = new Set(
  'hai hain kya ka ki ke ko se me mein aur bhi ye yeh wo woh kitne kitna kitni price rate cost milega milegi chahiye please pls plz bhai sir mam hello hi hey the a an is are for and of to in on it this that what how much available do you have can i me my'.split(
    ' ',
  ),
);

export function tokens(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

@Injectable()
export class ReplyContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async build(input: {
    orgId: string;
    text: string;
    postId?: string | null;
    conversationId?: string | null;
  }): Promise<ReplyContext> {
    const [profile, conversation] = await Promise.all([
      this.prisma.businessProfile.findUnique({ where: { orgId: input.orgId } }),
      input.conversationId
        ? this.prisma.conversation.findUnique({
            where: { id: input.conversationId },
            select: { goalState: true },
          })
        : null,
    ]);
    const template = industryOf(profile?.industry);
    const goalState = ((conversation?.goalState as GoalState | null) ||
      {}) as GoalState;

    const linkedIds = input.postId
      ? await this.linkedOfferingIds(input.orgId, input.postId)
      : [];
    const rememberedIds = goalState.offeringIds || [];
    const searched = await this.search(input.orgId, input.text, MAX_OFFERINGS);

    const orderedIds = [
      ...new Set([
        ...linkedIds,
        ...rememberedIds,
        ...searched.map((s) => s.id),
      ]),
    ].slice(0, MAX_OFFERINGS);
    const rows = orderedIds.length
      ? await this.prisma.offering.findMany({
          where: { id: { in: orderedIds }, orgId: input.orgId, isActive: true },
          include: {
            variants: { orderBy: { position: 'asc' } },
            components: { include: { item: { select: { title: true } } } },
          },
        })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));

    const dates = datesIn(goalState.fields);
    const availability =
      template.goal === 'BOOKING'
        ? await this.catalog.availability(orderedIds, dates)
        : [];

    const offerings: ContextOffering[] = orderedIds
      .map((id) => byId.get(id))
      .filter((o): o is NonNullable<typeof o> => Boolean(o))
      .map((o) => ({
        id: o.id,
        type: o.type,
        title: o.title,
        description: o.description ? o.description.slice(0, 400) : null,
        price_label: priceLabel(o),
        price_mode: o.priceMode,
        price_min: o.priceMin,
        price_max: o.priceMax,
        currency: o.currency,
        action_url: o.actionUrl,
        attributes: (o.attributes as Record<string, unknown> | null) || null,
        variants: o.variants.map((v) => ({
          label: v.label,
          price: v.price,
          stock: v.stock,
          in_stock: v.stock == null || v.stock > 0,
        })),
        includes: o.components.map((c) => c.item.title),
        linked_to_post: linkedIds.includes(o.id),
        ...(availability.length
          ? {
              availability: availability
                .filter((a) => a.offeringId === o.id)
                .map(({ date, status }) => ({ date, status })),
            }
          : {}),
      }));

    const recent = input.conversationId
      ? await this.prisma.inboxMessage.findMany({
          where: { conversationId: input.conversationId, body: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 6,
          select: { direction: true, body: true },
        })
      : [];

    const allowed = new Set<number>();
    for (const o of offerings) {
      if (o.price_min != null) allowed.add(o.price_min);
      if (o.price_max != null) allowed.add(o.price_max);
      for (const v of o.variants) if (v.price != null) allowed.add(v.price);
    }

    return {
      business: {
        industry: template.code,
        industry_label: template.label,
        description: profile?.description || null,
        city: profile?.city || null,
        service_areas: profile?.serviceAreas || [],
        hours: profile?.hours || null,
        policies: (profile?.policies as Record<string, string> | null) || null,
        faqs: (
          (profile?.faqs as Array<{ q: string; a: string }> | null) || []
        ).slice(0, 12),
      },
      playbook: {
        goal: template.goal,
        lead_fields: template.leadFields,
        rules: template.rules,
      },
      offerings,
      goal_state: goalState,
      recent_messages: recent.reverse().map((m) => ({
        from:
          m.direction === 'INBOUND'
            ? ('customer' as const)
            : ('business' as const),
        text: (m.body || '').slice(0, 300),
      })),
      template,
      allowed_prices: [...allowed],
    };
  }

  private async linkedOfferingIds(orgId: string, postId: string) {
    const links = await this.prisma.postOfferingLink.findMany({
      where: {
        orgId,
        postId,
        OR: [
          { status: 'SELLER_CONFIRMED' },
          {
            status: 'AI_SUGGESTED',
            confidence: { gte: MIN_SUGGESTED_CONFIDENCE },
          },
        ],
        offering: { isActive: true },
      },
      orderBy: [{ status: 'desc' }, { confidence: 'desc' }],
      select: { offeringId: true },
    });
    return links.map((l) => l.offeringId);
  }

  /**
   * Keyword match over titles, SKUs, descriptions, attributes and variant
   * labels. Catalogs here are tens to a few hundred items per seller, so this
   * runs in memory; it returns nothing rather than a weak guess.
   */
  async search(orgId: string, text: string, limit = MAX_OFFERINGS) {
    const q = tokens(text);
    if (!q.length) return [];
    const rows = await this.prisma.offering.findMany({
      where: { orgId, isActive: true },
      select: {
        id: true,
        title: true,
        sku: true,
        description: true,
        attributes: true,
        type: true,
        variants: { select: { label: true } },
      },
      take: 1000,
    });
    const scored = rows
      .map((o) => {
        const title = tokens(o.title);
        const rest = tokens(
          [
            o.sku,
            o.description,
            JSON.stringify(o.attributes || {}),
            o.variants.map((v) => v.label).join(' '),
            o.type,
          ].join(' '),
        );
        let score = 0;
        for (const t of q) {
          if (title.includes(t)) score += 3;
          else if (title.some((w) => w.startsWith(t) || t.startsWith(w)))
            score += 1.5;
          if (rest.includes(t)) score += 1;
        }
        if (o.sku && q.includes(o.sku.toLowerCase())) score += 5;
        return { id: o.id, score };
      })
      .filter((s) => s.score >= 3)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

function datesIn(fields?: Record<string, string>): string[] {
  if (!fields) return [];
  return Object.values(fields).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
}
