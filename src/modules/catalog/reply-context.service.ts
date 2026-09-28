import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CatalogService } from './catalog.service';
import {
  defaultOfferType,
  industryOf,
  offeringKind,
  priceLabel,
  type IndustryTemplate,
} from './industries';
import { PostAiGateService } from './post-ai-gate.service';
import { DmSpotlightService, type SpotlightForAi } from './dm-spotlight.service';

// Suggested links below this confidence are ignored until the seller confirms
// them, so a wrong guess does not put the wrong price in front of a customer.
const MIN_SUGGESTED_CONFIDENCE = 0.6;
const MAX_OFFERINGS = 5;
// Background items for an open question ("hi", "price list").
const MAX_OVERVIEW = 8;
// A post mentioned in a chat stays its topic for this long.
export const POST_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

// Why an item is in the context: shown in the post, talked about earlier,
// matched by this message, a Spotlight post's item, or background for an
// open question.
export type OfferingMatch = 'post' | 'chat' | 'search' | 'spotlight' | 'overview';

export type GoalState = {
  offeringIds?: string[];
  fields?: Record<string, string>;
  leadId?: string;
  // ISO time until which the AI stays quiet after handing the chat to a
  // person. Cleared by "Resume AI" in the inbox.
  handedOffUntil?: string;
  // Set when the seller answers from the inbox: the AI steps back for 12h.
  sellerPausedUntil?: string;
  // Why the chat needs the seller (crisis, complaint, human_request,
  // unresolved_query, missing_information, ai_unavailable, ...).
  handoffReason?: string;
  // When helplines were sent; the AI stays off until the seller resumes it.
  crisisAt?: string;
  // "We got your message" went out while the AI service was down.
  aiDownNoticeAt?: string;
  // The post this chat is about (from a comment, story reply, share or ad)
  // and when it was last mentioned; it is remembered for 7 days.
  postId?: string;
  postAt?: string;
  // PRODUCTS or SERVICES, once a customer on a "both" page made it clear.
  offeringType?: string;
  // DISCOVER -> QUOTE -> COLLECT -> DONE
  stage?: string;
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
  match: OfferingMatch;
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
    // What this page sells, and examples for an open question.
    offer_type: 'PRODUCTS' | 'SERVICES' | 'BOTH';
    categories: string[];
  };
  playbook: {
    goal: string;
    lead_fields: Array<{ key: string; label: string; ask: string }>;
    rules: string[];
  };
  offerings: ContextOffering[];
  // The post the customer commented on or replied to: its caption and the
  // seller's note about it. Null for plain DMs.
  post: { post_id: string; caption: string | null; note: string | null } | null;
  // The post this message is about (AI-on posts only), even without a caption.
  post_id: string | null;
  // Style for this page: the page's own settings, else the business profile's.
  style: {
    audience: string | null;
    tone: string | null;
    language: string | null;
  };
  goal_state: GoalState;
  recent_messages: Array<{ from: 'customer' | 'business'; text: string }>;
  template: IndustryTemplate;
  // Every catalog price the reply may mention; used by the price guard.
  allowed_prices: number[];
  // Plain DMs only: the page's highlighted posts, and the links (their
  // permalinks) the reply may share besides the catalog's own.
  spotlight: SpotlightForAi[];
  allowed_links: string[];
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
    @Optional() private readonly gate?: PostAiGateService,
    @Optional() private readonly spotlightService?: DmSpotlightService,
  ) {}

  /**
   * Which post this message is about: the one in the event (comment, story
   * reply, share, ad), else the one this chat was about in the last 7 days.
   * A post whose AI is off is never used: the chat is answered like a plain
   * DM rather than guessing about that post.
   */
  private async pickPost(
    orgId: string,
    eventPostId: string | null | undefined,
    convo: { goalState: unknown; sourcePostId?: string | null } | null,
  ): Promise<string | null> {
    const state = ((convo?.goalState as GoalState | null) || {}) as GoalState;
    const fresh = Boolean(
      state.postAt && Date.now() - new Date(state.postAt).getTime() < POST_MEMORY_MS,
    );
    const candidates = [
      eventPostId,
      fresh ? state.postId : null,
      fresh ? convo?.sourcePostId : null,
    ].filter((p): p is string => Boolean(p));
    for (const postId of [...new Set(candidates)]) {
      if (!this.gate || (await this.gate.isPostAiOn(orgId, postId))) return postId;
    }
    return null;
  }

  async build(input: {
    orgId: string;
    text: string;
    postId?: string | null;
    conversationId?: string | null;
    // The Instagram account / Facebook Page the message came in on.
    channelId?: string | null;
  }): Promise<ReplyContext> {
    const [profile, conversation, page] = await Promise.all([
      this.prisma.businessProfile.findUnique({ where: { orgId: input.orgId } }),
      input.conversationId
        ? this.prisma.conversation.findUnique({
            where: { id: input.conversationId },
            select: { goalState: true, sourcePostId: true },
          })
        : null,
      input.channelId
        ? this.prisma.pageProfile.findFirst({
            where: { channelId: input.channelId, orgId: input.orgId },
          })
        : null,
    ]);
    const postId = await this.pickPost(input.orgId, input.postId, conversation);
    const [social, link] = await Promise.all([
      postId
        ? this.prisma.socialPost.findUnique({
            where: {
              orgId_postId: { orgId: input.orgId, postId },
            },
            select: { caption: true, note: true },
          })
        : null,
      postId
        ? this.prisma.postOfferingLink.findFirst({
            where: { orgId: input.orgId, postId, caption: { not: null } },
            select: { caption: true },
          })
        : null,
    ]);
    const template = industryOf(profile?.industry);
    const goalState = ((conversation?.goalState as GoalState | null) ||
      {}) as GoalState;
    // A page limited to some catalog items only suggests those, unless the
    // seller tagged the post with something else.
    const pageItems = page?.offeringIds?.length ? page.offeringIds : null;

    const linkedIds = postId
      ? await this.linkedOfferingIds(input.orgId, postId)
      : [];
    const rememberedIds = (goalState.offeringIds || []).filter(
      (id) => !pageItems || pageItems.includes(id),
    );
    // A plain DM (no AI-on post): the page's Spotlight posts and their items.
    const spotlight =
      !postId && input.channelId && this.spotlightService
        ? await this.spotlightService
            .forDm(input.orgId, input.channelId)
            .catch(() => [] as SpotlightForAi[])
        : [];
    const spotlightIds = spotlight.flatMap((s) => s.offering_ids);
    const searched = await this.search(
      input.orgId,
      input.text,
      MAX_OFFERINGS,
      pageItems,
    );

    const offerType = (page?.offerType ||
      profile?.offerType ||
      defaultOfferType(profile?.industry)) as 'PRODUCTS' | 'SERVICES' | 'BOTH';
    // On a page that sells both, what the customer said they want.
    const wants =
      offerType === 'BOTH'
        ? goalState.offeringType
        : offerType;

    let orderedIds = [
      ...new Set([
        ...linkedIds,
        ...rememberedIds,
        ...searched.map((s) => s.id),
        ...spotlightIds,
      ]),
    ].slice(0, MAX_OFFERINGS);
    // Nothing matched ("hi", "price list", "kya naya hai"): a few items of the
    // right kind as background for an open question, no prices pushed.
    const overviewIds = orderedIds.length
      ? []
      : await this.overview(input.orgId, pageItems, wants);
    if (!orderedIds.length) orderedIds = overviewIds;
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
        match: (linkedIds.includes(o.id)
          ? 'post'
          : rememberedIds.includes(o.id)
            ? 'chat'
            : searched.some((s) => s.id === o.id)
              ? 'search'
              : spotlightIds.includes(o.id)
                ? 'spotlight'
                : overviewIds.includes(o.id)
                  ? 'overview'
                  : 'search') as OfferingMatch,
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

    const caption = social?.caption || link?.caption || null;
    return {
      business: {
        industry: template.code,
        industry_label: template.label,
        description: page?.description || profile?.description || null,
        city: profile?.city || null,
        service_areas: profile?.serviceAreas || [],
        hours: profile?.hours || null,
        policies: (profile?.policies as Record<string, string> | null) || null,
        faqs: [
          ...((page?.faqs as Array<{ q: string; a: string }> | null) || []),
          ...((profile?.faqs as Array<{ q: string; a: string }> | null) || []),
        ].slice(0, 12),
        offer_type: offerType,
        categories: page?.categories || [],
      },
      playbook: {
        goal: template.goal,
        lead_fields: template.leadFields,
        rules: template.rules,
      },
      offerings,
      post_id: postId,
      post:
        postId && (caption || social?.note)
          ? {
              post_id: postId,
              caption: caption ? caption.slice(0, 1000) : null,
              note: social?.note || null,
            }
          : null,
      style: {
        audience: page?.audience || profile?.audience || null,
        tone: page?.tone || profile?.tone || profile?.replyTone || null,
        language:
          page?.language || profile?.language || profile?.replyLanguage || null,
      },
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
      spotlight,
      allowed_links: spotlight
        .map((s) => s.permalink)
        .filter((l): l is string => Boolean(l)),
    };
  }

  /** Newest active items of the kind the page (or customer) wants. */
  private async overview(
    orgId: string,
    onlyIds: string[] | null,
    wants: string | undefined,
  ): Promise<string[]> {
    const rows = await this.prisma.offering.findMany({
      where: {
        orgId,
        isActive: true,
        ...(onlyIds?.length ? { id: { in: onlyIds } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, type: true },
    });
    return rows
      .filter((r) => !wants || wants === 'BOTH' || offeringKind(r.type) === wants)
      .slice(0, MAX_OVERVIEW)
      .map((r) => r.id);
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
  async search(
    orgId: string,
    text: string,
    limit = MAX_OFFERINGS,
    onlyIds?: string[] | null,
  ) {
    const q = tokens(text);
    if (!q.length) return [];
    const rows = await this.prisma.offering.findMany({
      where: {
        orgId,
        isActive: true,
        ...(onlyIds?.length ? { id: { in: onlyIds } } : {}),
      },
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
