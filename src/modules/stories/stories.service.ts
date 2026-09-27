import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { timingSafeEqualString } from '../../common/hmac';
import { reel2realSender, type WaSender } from '../../common/wa-sender';
import { GeminiClient } from './gemini.client';
import { KeywordResearchService } from './keyword-research.service';
import { overlayText, toFeedJpeg, toPaddedStoryJpeg, toStoryJpeg } from './story-image';
import { toReelMp4 } from './story-video';

export const OPTION_COUNT = 5;
const MIN_OPTIONS = 4;
const MAX_OPTIONS = 5;
const SHOW_PREFIX = 'STORY_SHOW_';
// Legacy list picker rows; still honoured for batches sent before the buttons.
const PICK_PREFIX = 'STORY_PICK_';
const POST_PREFIX = 'STORY_POST_';
const EDIT_PREFIX = 'STORY_EDIT_';
// After the posting time has passed: publish now, or at tomorrow's posting time.
const NOW_PREFIX = 'STORY_NOW_';
const TOMORROW_PREFIX = 'STORY_TMRW_';
const CANCEL_PREFIX = 'STORY_CANCEL_';
// "Edit caption" on the scheduled-post preview.
const CAPTION_PREFIX = 'STORY_CAP_';
// "Edit cancel" while the merchant is describing a change.
const EDIT_CANCEL_PREFIX = 'STORY_EDITX_';
const OPTION_PREFIXES = [POST_PREFIX, PICK_PREFIX, EDIT_PREFIX, CAPTION_PREFIX, NOW_PREFIX, TOMORROW_PREFIX];
// Statuses from which the merchant may still pick (or re-pick); FAILED lets them retry.
const PICKABLE = ['NOTIFIED', 'AWAITING_PICK', 'SCHEDULED', 'FAILED'];
// "Send today's ideas now" must not throw away a pick or a post that went out.
const KEEP_ON_REGENERATE = ['GENERATING', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED'];
const PICK_WINDOW_MS = 36 * 60 * 60 * 1000;
// The "you have not picked yet" nudge goes out this long before the posting time.
const REMIND_BEFORE_MS = 2 * 60 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SCHEDULE_AHEAD_MS = 2 * 60 * 1000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const CAPTION_EDIT = /^caption\s*[:\-]\s*/i;
const CANCEL_TEXT = /^(cancel|cancel karo|ruko|stop)$/i;
// Ways of saying "never mind" while in edit mode. Only read then, so a word
// like "nahi" in a normal chat is never taken as a command.
const EDIT_CANCEL_TEXT =
  /^(cancel|cancel karo|cancel kar do|rehne do|rehne dijiye|rahne do|chhodo|chodo|chhod do|skip|stop|ruko|nahi|nahin|no|mat karo|band karo|kuch nahi|koi nahi|never ?mind)[.!\s]*$/i;
// Edit mode lapses, so a message hours later is not read as an edit.
const EDIT_TTL_MS = 30 * 60 * 1000;
// Room left in a WhatsApp interactive body (1024) around the preview caption.
const PREVIEW_CAPTION_CHARS = 600;
export const DESTINATIONS = ['IG_STORY', 'IG_FEED', 'IG_REEL', 'FB_FEED'] as const;
export type Destination = (typeof DESTINATIONS)[number];
const DESTINATION_NAMES: Record<Destination, string> = {
  IG_STORY: 'Instagram story',
  IG_FEED: 'Instagram post',
  IG_REEL: 'Instagram reel',
  FB_FEED: 'Facebook post',
};

export type MediaVariant = 'draft' | 'final' | 'feed' | 'reel';
type EditMode = 'IMAGE' | 'CAPTION';
type TargetResult = { ok: boolean; id?: string; error?: string };
// When a picked post goes live: a moment, or right away.
type When = Date | 'now';
type OptionCard = {
  id: string;
  position: number;
  title: string;
  label?: string | null;
  idea: string;
  caption?: string | null;
  revision?: number;
};

/**
 * Daily post ideas: research what is trending in the merchant's niche, turn it
 * into four or five labelled images, deliver them on WhatsApp from the
 * Reel2Real number with Post this / Edit buttons, and publish the picked one at
 * the merchant's posting time to their Instagram story, Instagram feed and/or
 * Facebook Page. The seller can also send (or upload) their own photo and
 * schedule it, and do all of this from the dashboard as well.
 */
@Injectable()
export class StoriesService {
  private readonly logger = new Logger(StoriesService.name);
  private dailyRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metaPublisher: MetaPublisherService,
    private readonly gemini: GeminiClient,
    private readonly keywords: KeywordResearchService,
  ) {}

  // ---------------------------------------------------------------- settings

  async getSettings(orgId: string) {
    const settings = await this.prisma.storySettings.findUnique({
      where: { orgId },
    });
    return (
      settings || {
        orgId,
        enabled: false,
        whatsappNumber: null,
        instagramChannelId: null,
        facebookChannelId: null,
        businessDescription: null,
        keywordDatabase: 'in',
        sendTime: '09:00',
        postTime: '19:00',
        optionCount: OPTION_COUNT,
        destinations: ['IG_STORY'],
        nicheKeywords: [],
      }
    );
  }

  async updateSettings(
    orgId: string,
    input: {
      enabled?: boolean;
      whatsappNumber?: string | null;
      instagramChannelId?: string | null;
      facebookChannelId?: string | null;
      businessDescription?: string | null;
      keywordDatabase?: string;
      sendTime?: string;
      postTime?: string;
      optionCount?: number;
      destinations?: string[];
      nicheKeywords?: string[];
    },
  ) {
    const data: Record<string, unknown> = {};
    if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);
    if (input.whatsappNumber !== undefined) data.whatsappNumber = normalizeWhatsAppNumber(input.whatsappNumber);
    if (input.businessDescription !== undefined) {
      data.businessDescription = input.businessDescription?.trim().slice(0, 1000) || null;
    }
    if (input.keywordDatabase !== undefined) {
      const db = String(input.keywordDatabase).toLowerCase();
      if (!/^[a-z]{2}$/.test(db)) throw new BadRequestException('keywordDatabase must be a two-letter code');
      data.keywordDatabase = db;
    }
    for (const key of ['sendTime', 'postTime'] as const) {
      if (input[key] === undefined) continue;
      const value = normalizeTime(input[key]);
      if (!value) throw new BadRequestException(`${key} must be a time like 09:00`);
      data[key] = value;
    }
    if (input.optionCount !== undefined) {
      const n = Number(input.optionCount);
      if (!Number.isInteger(n) || n < MIN_OPTIONS || n > MAX_OPTIONS) {
        throw new BadRequestException(`optionCount must be ${MIN_OPTIONS} or ${MAX_OPTIONS}`);
      }
      data.optionCount = n;
    }
    if (input.destinations !== undefined) {
      const list = [...new Set((input.destinations || []).map((d) => String(d).toUpperCase()))];
      if (!list.length || list.some((d) => !(DESTINATIONS as readonly string[]).includes(d))) {
        throw new BadRequestException(`Choose at least one of ${DESTINATIONS.join(', ')}`);
      }
      data.destinations = list;
    }
    if (input.nicheKeywords !== undefined) {
      data.nicheKeywords = [
        ...new Set((input.nicheKeywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean)),
      ]
        .map((k) => k.slice(0, 60))
        .slice(0, 10);
    }
    for (const [key, platform, name] of [
      ['instagramChannelId', 'INSTAGRAM', 'Instagram account'],
      ['facebookChannelId', 'FACEBOOK', 'Facebook Page'],
    ] as const) {
      if (input[key] === undefined) continue;
      if (input[key]) {
        const channel = await this.prisma.channel.findFirst({
          where: { id: input[key]!, orgId, platform },
        });
        if (!channel) throw new BadRequestException(`That ${name} is not connected to this workspace`);
      }
      data[key] = input[key] || null;
    }
    const merged = { ...(await this.getSettings(orgId)), ...data };
    if (merged.enabled && !merged.whatsappNumber) {
      throw new BadRequestException('Add a WhatsApp number before turning daily posts on');
    }
    return this.prisma.storySettings.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });
  }

  async listBatches(orgId: string, take = 10) {
    const batches = await this.prisma.storyBatch.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take,
      include: { options: { orderBy: { position: 'asc' }, select: OPTION_FIELDS } },
    });
    return batches.map((b) => this.batchView(b));
  }

  /** Everything scheduled to go live, soonest first: the content calendar. */
  async listUpcoming(orgId: string) {
    const batches = await this.prisma.storyBatch.findMany({
      where: { orgId, status: 'SCHEDULED' },
      orderBy: { scheduledFor: 'asc' },
      take: 50,
      include: { options: { orderBy: { position: 'asc' }, select: OPTION_FIELDS } },
    });
    return batches.map((b) => this.batchView(b));
  }

  private batchView(b: {
    status: string;
    selectedOptionId: string | null;
    options: Array<{ id: string; revision?: number } & Record<string, unknown>>;
    [k: string]: unknown;
  }) {
    return {
      ...b,
      options: b.options.map((o) => ({
        ...o,
        imageUrl: this.mediaUrl(o.id, 'draft', o.revision),
        finalImageUrl: b.selectedOptionId === o.id && b.status === 'PUBLISHED' ? this.mediaUrl(o.id, 'final') : null,
      })),
    };
  }

  // ------------------------------------------------------------ generation

  /**
   * Entry point for the cron, which runs every 15 minutes: sends today's ideas
   * to each org whose send time has passed, publishes picks that are due, and
   * nudges sellers who have not picked yet. Every step is idempotent, so a
   * missed or repeated tick is harmless.
   */
  async runDaily(
    now = new Date(),
  ): Promise<{ started: boolean; orgs: number; published: number; reminded: number }> {
    if (this.dailyRunning) return { started: false, orgs: 0, published: 0, reminded: 0 };
    this.dailyRunning = true;
    try {
      const settings = await this.prisma.storySettings.findMany({
        where: { enabled: true, whatsappNumber: { not: null } },
        select: {
          orgId: true,
          sendTime: true,
          org: { select: { timezone: true } },
        },
      });
      let orgs = 0;
      for (const s of settings) {
        const tz = s.org?.timezone || 'Asia/Kolkata';
        if (localTime(tz, now) < (s.sendTime || '09:00')) continue;
        const today = await this.prisma.storyBatch.findFirst({
          where: { orgId: s.orgId, forDate: localDate(tz, now), kind: 'DAILY' },
          select: { id: true },
        });
        if (today) continue;
        orgs += 1;
        try {
          await this.generateBatch(s.orgId);
        } catch (e: any) {
          this.logger.error(`Daily posts failed for org ${s.orgId}: ${e.message}`);
        }
      }
      const published = await this.publishDue(now);
      const reminded = await this.remindUnpicked(now).catch((e) => {
        this.logger.error(`Pick reminders failed: ${e.message}`);
        return 0;
      });
      return { started: true, orgs, published, reminded };
    } finally {
      this.dailyRunning = false;
    }
  }

  /**
   * Throws when regenerating today's ideas would throw away something the
   * seller relies on: a pick waiting to go live, or a post that went out.
   */
  async assertCanRegenerate(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const today = await this.prisma.storyBatch.findFirst({
      where: { orgId, forDate: localDate(org?.timezone || 'Asia/Kolkata'), kind: 'DAILY' },
      select: { status: true },
    });
    if (today && KEEP_ON_REGENERATE.includes(today.status)) {
      throw new BadRequestException(regenerateBlockedMessage(today.status));
    }
  }

  /**
   * Creates today's batch for one org. Idempotent per day: an existing batch is
   * kept unless it failed or `force` is set, and even `force` keeps a batch that
   * is scheduled or already published.
   *
   * `via: 'whatsapp'` (the daily run) sends the ideas to the merchant's number.
   * `via: 'web'` only makes them, for picking in the dashboard: no WhatsApp
   * number or sender needed, e.g. for an agency or staff planning on a laptop.
   */
  async generateBatch(orgId: string, opts: { force?: boolean; via?: 'whatsapp' | 'web' } = {}) {
    const viaWhatsApp = opts.via !== 'web';
    if (viaWhatsApp && !this.sender()) throw new Error('Story WhatsApp sender is not configured');
    if (!this.gemini.isConfigured()) throw new Error('GEMINI_API_KEY is not set');

    const settings = (await this.prisma.storySettings.findUnique({
      where: { orgId },
    })) || (await this.getSettings(orgId));
    if (viaWhatsApp && !settings.whatsappNumber) throw new Error('No WhatsApp number set for daily posts');
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org) throw new NotFoundException('Organization not found');
    const destinations = destinationsOf(settings);
    const igChannel = await this.instagramChannel(orgId, settings.instagramChannelId);
    if (!igChannel && destinations.some((d) => d.startsWith('IG_'))) {
      throw new Error('No active Instagram account connected');
    }
    if (destinations.includes('FB_FEED') && !(await this.facebookChannel(orgId, settings.facebookChannelId))) {
      throw new Error('No active Facebook Page connected');
    }

    const forDate = localDate(org.timezone || 'Asia/Kolkata');
    const existing = await this.prisma.storyBatch.findFirst({
      where: { orgId, forDate, kind: 'DAILY' },
    });
    if (existing && existing.status !== 'FAILED' && !opts.force) return existing;
    if (existing && KEEP_ON_REGENERATE.includes(existing.status)) {
      throw new BadRequestException(regenerateBlockedMessage(existing.status));
    }
    if (existing) await this.prisma.storyBatch.delete({ where: { id: existing.id } });

    const batch = await this.prisma.storyBatch.create({
      data: {
        orgId,
        forDate,
        kind: 'DAILY',
        status: 'GENERATING',
        waRecipient: viaWhatsApp ? settings.whatsappNumber : null,
      },
    });

    try {
      const [products, recent, profile, page] = await Promise.all([
        this.prisma.offering
          .findMany({
            where: { orgId, isActive: true },
            orderBy: { updatedAt: 'desc' },
            take: 10,
            select: { id: true, title: true, priceMin: true, currency: true },
          })
          .then((rows) =>
            rows.map((r) => ({
              id: r.id,
              title: r.title,
              price: r.priceMin ?? 0,
              currency: r.currency,
            })),
          ),
        this.prisma.storyOption.findMany({
          where: { batch: { orgId, id: { not: batch.id } } },
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: { title: true },
        }),
        this.prisma.businessProfile.findUnique({ where: { orgId } }).catch(() => null),
        igChannel
          ? this.prisma.pageProfile.findFirst({ where: { channelId: igChannel.id, orgId } }).catch(() => null)
          : null,
      ]);
      // One description for the whole product: the daily-posts override, then
      // the page's own, then the business setup.
      const description = settings.businessDescription || page?.description || profile?.description || null;

      const trendKeywords = await this.researchTrends({
        industry: profile?.industry,
        description,
        seeds: settings.nicheKeywords || [],
        forDate,
      });
      await this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: { trendKeywords },
      });

      const count = clampCount(settings.optionCount);
      const ideas = await this.gemini.generateIdeas(
        {
          brandName: profile?.businessName || org.name,
          instagramHandle: igChannel?.handle,
          description,
          industry: profile?.industry,
          persona: brandPersona(org.brandPersona, {
            tone: page?.tone || profile?.tone || profile?.replyTone,
            language: page?.language || profile?.language || profile?.replyLanguage,
            audience: page?.audience || profile?.audience,
          }),
          products,
          recentTitles: recent.map((r) => r.title),
          forDate,
          trendKeywords,
        },
        count,
      );

      const productIds = new Set(products.map((p) => p.id));
      for (let i = 0; i < ideas.length; i++) {
        const { offeringId, ...idea } = ideas[i];
        const image = await toStoryJpeg(await this.withRetry(() => this.gemini.generateImage(idea.imagePrompt)));
        await this.prisma.storyOption.create({
          data: {
            batchId: batch.id,
            position: i + 1,
            ...idea,
            label: idea.label || `Trending: ${idea.seedKeyword}`.slice(0, 30),
            offeringId: offeringId && productIds.has(offeringId) ? offeringId : null,
            imageData: new Uint8Array(image),
          },
        });
      }

      if (!viaWhatsApp) {
        return this.prisma.storyBatch.update({
          where: { id: batch.id },
          data: { status: 'AWAITING_PICK' },
        });
      }
      const sent = await this.sendIdeasTemplate(settings.whatsappNumber!, org.name, batch.id);
      if (!sent) throw new Error('WhatsApp template could not be sent');

      return this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: { status: 'NOTIFIED' },
      });
    } catch (e: any) {
      await this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: {
          status: 'FAILED',
          error: { stage: 'generate', message: e.message },
        },
      });
      throw e;
    }
  }

  private async sendIdeasTemplate(to: string, orgName: string, batchId: string, template?: string) {
    const sender = this.sender();
    if (!sender) return false;
    return this.metaPublisher.sendWhatsAppTemplate(
      sender.phoneNumberId,
      to,
      template || process.env.STORY_WA_TEMPLATE || 'daily_story_ideas',
      process.env.STORY_WA_TEMPLATE_LANG || 'en',
      [
        { type: 'body', parameters: [{ type: 'text', text: orgName }] },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `${SHOW_PREFIX}${batchId}` }],
        },
      ],
      sender.accessToken,
    );
  }

  /**
   * Today's keywords for the niche. Apify supplies the hashtags trending on
   * Instagram for the seed terms; Gemini ranks search phrases from those and the
   * business itself. Without Apify (no token, or it failed) Gemini works from
   * the niche alone, and without either the seeds are used as they are.
   */
  async researchTrends(ctx: {
    industry?: string | null;
    description?: string | null;
    seeds: string[];
    forDate: string;
  }): Promise<string[]> {
    const seeds = [...new Set([...ctx.seeds, ctx.industry ? humanIndustry(ctx.industry) : ''].filter(Boolean))].slice(
      0,
      3,
    );
    const trendingHashtags: string[] = [];
    for (const seed of seeds.slice(0, 2)) {
      try {
        trendingHashtags.push(...(await this.keywords.apifyHashtags(seed)));
      } catch (e: any) {
        this.logger.warn(`Apify trend lookup failed for "${seed}": ${e.message}`);
      }
    }
    try {
      const ranked = await this.gemini.trendKeywords({
        industry: ctx.industry,
        description: ctx.description,
        seeds,
        trendingHashtags: [...new Set(trendingHashtags)].slice(0, 20),
        forDate: ctx.forDate,
      });
      if (ranked.length) return ranked;
    } catch (e: any) {
      this.logger.warn(`Gemini trend ranking failed: ${e.message}`);
    }
    return seeds;
  }

  // ------------------------------------------------------------- reminders

  /**
   * A seller who got today's ideas but has not picked one hears about it two
   * hours before the posting time, once. Inside WhatsApp's 24h window a plain
   * message does; otherwise the ideas template goes out again.
   */
  async remindUnpicked(now = new Date()): Promise<number> {
    const batches = await this.prisma.storyBatch.findMany({
      where: {
        kind: 'DAILY',
        status: { in: ['NOTIFIED', 'AWAITING_PICK'] },
        reminderSentAt: null,
        createdAt: { gt: new Date(now.getTime() - PICK_WINDOW_MS) },
      },
      include: {
        org: {
          select: { name: true, timezone: true, storySettings: { select: { postTime: true } } },
        },
      },
      take: 200,
    });
    let reminded = 0;
    for (const b of batches) {
      const tz = b.org?.timezone || 'Asia/Kolkata';
      if (b.forDate !== localDate(tz, now) || !b.waRecipient) continue;
      const postTime = b.org?.storySettings?.postTime || '19:00';
      const due = zonedDateTime(b.forDate, postTime, tz).getTime();
      if (now.getTime() < due - REMIND_BEFORE_MS || now.getTime() >= due) continue;
      const claimed = await this.prisma.storyBatch.updateMany({
        where: { id: b.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claimed.count === 0) continue;
      const sender = this.sender();
      if (!sender) continue;
      let sent = false;
      if (b.status === 'AWAITING_PICK') {
        sent = await this.metaPublisher.sendWhatsAppMessage(
          sender.phoneNumberId,
          b.waRecipient,
          `Aaj ki post abhi chuni nahi gayi. ${postTime} baje tak kisi option ke neeche "Post this" dabaiye, ` +
            'warna aaj kuch post nahi hoga.',
          sender.accessToken,
        );
      }
      if (!sent) {
        sent = await this.sendIdeasTemplate(
          b.waRecipient,
          b.org?.name || '',
          b.id,
          process.env.STORY_WA_REMINDER_TEMPLATE,
        );
      }
      if (sent) reminded += 1;
    }
    return reminded;
  }

  // -------------------------------------------------------- WhatsApp replies

  /** True for inbound messages this service owns; checked before the generic inbox/AI path. */
  async isStoryReply(msg: any, phoneNumberId: string): Promise<boolean> {
    const id = replyId(msg);
    if (id && [SHOW_PREFIX, CANCEL_PREFIX, EDIT_CANCEL_PREFIX, ...OPTION_PREFIXES].some((p) => id.startsWith(p))) {
      return true;
    }
    const sender = this.sender();
    if (!sender || phoneNumberId !== sender.phoneNumberId) return false;
    const from = String(msg?.from || '');
    if (msg?.type === 'image' && msg?.image?.id) {
      // A seller sending their own photo to post; anyone else is a normal chat.
      const seller = await this.prisma.storySettings.findFirst({
        where: { whatsappNumber: from },
        select: { orgId: true },
      });
      return Boolean(seller);
    }
    const text = String(msg?.text?.body || '').trim();
    if (/^[1-5]$/.test(text)) return true;
    if (!text) return false;
    if (CANCEL_TEXT.test(text)) {
      const scheduled = await this.prisma.storyBatch.findFirst({
        where: { waRecipient: from, status: 'SCHEDULED' },
        select: { id: true },
      });
      if (scheduled) return true;
    }
    // Other free text is ours only while the merchant is describing an edit
    // (a lapsed edit is ours too, to say so instead of silently dropping it),
    // or says "2 post karo" while today's ideas are open.
    if (await this.editingBatch(from)) return true;
    if (pickIntent(text) !== null) {
      const open = await this.prisma.storyBatch.findFirst({
        where: {
          waRecipient: from,
          status: { in: PICKABLE },
          createdAt: { gt: new Date(Date.now() - PICK_WINDOW_MS) },
        },
        select: { id: true },
      });
      return Boolean(open);
    }
    return false;
  }

  /** The batch whose option this number is currently describing changes for. */
  private editingBatch(from: string) {
    return this.prisma.storyBatch.findFirst({
      where: {
        waRecipient: from,
        editingOptionId: { not: null },
        status: { in: PICKABLE },
        createdAt: { gt: new Date(Date.now() - PICK_WINDOW_MS) },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async handleWhatsAppReply(msg: any): Promise<void> {
    const from = String(msg?.from || '');
    const id = replyId(msg);
    if (id?.startsWith(SHOW_PREFIX)) {
      return this.showOptions(id.slice(SHOW_PREFIX.length), from);
    }
    if (id?.startsWith(CANCEL_PREFIX)) {
      return this.cancelFromWhatsApp(id.slice(CANCEL_PREFIX.length), from);
    }
    if (id?.startsWith(EDIT_CANCEL_PREFIX)) {
      return this.cancelEdit(id.slice(EDIT_CANCEL_PREFIX.length), from);
    }
    for (const prefix of OPTION_PREFIXES) {
      if (!id?.startsWith(prefix)) continue;
      const rest = id.slice(prefix.length);
      const sep = rest.lastIndexOf('_');
      const batchId = rest.slice(0, sep);
      const position = Number(rest.slice(sep + 1));
      if (prefix === EDIT_PREFIX) return this.startEdit(batchId, position, from);
      if (prefix === CAPTION_PREFIX) return this.startEdit(batchId, position, from, 'CAPTION');
      const when = prefix === NOW_PREFIX ? 'now' : prefix === TOMORROW_PREFIX ? 'tomorrow' : undefined;
      return this.pick(batchId, position, from, new Date(), when);
    }

    if (msg?.type === 'image' && msg?.image?.id) {
      return this.receiveOwnPhoto(msg);
    }

    const text = String(msg?.text?.body || '').trim();
    // An open edit is the most recent thing the merchant started, so it wins:
    // "cancel" then means "never mind the edit", not "cancel my schedule".
    const editing = await this.editingBatch(from);
    if (editing?.editingOptionId) {
      const startedAt = editing.editingStartedAt || editing.updatedAt;
      if (!startedAt || Date.now() - new Date(startedAt).getTime() > EDIT_TTL_MS) {
        await this.clearEdit(editing.id);
        await this.text(
          from,
          'Edit ka time nikal gaya tha, isliye kuch nahi badla. Badlav karna ho to option ke neeche "Edit" phir se dabaiye.',
        );
        return;
      }
      if (EDIT_CANCEL_TEXT.test(text)) return this.cancelEdit(editing.id, from);
      const position = pickIntent(text);
      if (position !== null) {
        await this.clearEdit(editing.id);
        return this.pick(editing.id, position, from);
      }
      return this.applyEdit(editing.id, editing.editingOptionId, text, from, editingMode(editing.editingMode));
    }

    if (CANCEL_TEXT.test(text)) {
      const scheduled = await this.prisma.storyBatch.findFirst({
        where: { waRecipient: from, status: 'SCHEDULED' },
        orderBy: { scheduledFor: 'asc' },
        select: { id: true },
      });
      if (scheduled) return this.cancelFromWhatsApp(scheduled.id, from);
    }
    const position = pickIntent(text);
    if (position === null) return;
    const batch = await this.prisma.storyBatch.findFirst({
      where: {
        waRecipient: from,
        status: { in: PICKABLE },
        createdAt: { gt: new Date(Date.now() - PICK_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!batch) return;
    return this.pick(batch.id, position, from);
  }

  async showOptions(batchId: string, from: string) {
    const sender = this.sender();
    if (!sender) return;
    const batch = await this.prisma.storyBatch.findUnique({
      where: { id: batchId },
      include: {
        options: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            position: true,
            title: true,
            label: true,
            idea: true,
            caption: true,
          },
        },
      },
    });
    if (!batch || batch.waRecipient !== from) return;
    if (!PICKABLE.includes(batch.status) || batch.options.length === 0) {
      await this.text(from, statusMessage(batch.status));
      return;
    }

    for (const o of batch.options) {
      await this.sendOption(batch.id, o, from);
    }
    const settings = await this.prisma.storySettings.findUnique({
      where: { orgId: batch.orgId },
    });
    await this.text(
      from,
      `Jo post pasand ho uske neeche "Post this" dabaiye, woh ${settings?.postTime || '19:00'} baje ` +
        `${destinationsText(destinationsOf(settings))} pe live hogi. Kuch badalna ho to "Edit" dabaiye.`,
    );
    if (batch.status === 'NOTIFIED') {
      await this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: { status: 'AWAITING_PICK' },
      });
    }
  }

  private async sendOption(batchId: string, o: OptionCard, to: string) {
    const sender = this.sender();
    if (!sender) return;
    const body =
      `${o.position}. ${o.label ? `[${o.label}] ` : ''}*${o.title}*\n${o.idea}` +
      (o.caption ? `\n\nCaption: ${o.caption}` : '');
    const sent = await this.metaPublisher.sendWhatsAppImageButtons(
      sender.phoneNumberId,
      to,
      this.mediaUrl(o.id, 'draft', o.revision),
      body,
      [
        { id: `${POST_PREFIX}${batchId}_${o.position}`, title: 'Post this' },
        { id: `${EDIT_PREFIX}${batchId}_${o.position}`, title: 'Edit' },
      ],
      sender.accessToken,
    );
    // Buttons need the 24h window; if Meta refuses, the image and a number still work.
    if (!sent) {
      await this.metaPublisher.sendWhatsAppImage(
        sender.phoneNumberId,
        to,
        this.mediaUrl(o.id, 'draft', o.revision),
        `${body}\n\nIse chunne ke liye ${o.position} bhejiye.`,
        sender.accessToken,
      );
    }
  }

  /**
   * "Post this" on WhatsApp: schedules the option for the merchant's posting
   * time. When that time has already passed, asks whether to post right away
   * or at tomorrow's posting time instead of posting without asking. Picking
   * another option before then replaces the pick.
   */
  async pick(
    batchId: string,
    position: number,
    from: string,
    now = new Date(),
    when?: 'now' | 'tomorrow',
  ) {
    const batch = await this.prisma.storyBatch.findUnique({
      where: { id: batchId },
      include: { options: { where: { position }, select: { id: true } } },
    });
    if (!batch || batch.waRecipient !== from) return;
    if (!PICKABLE.includes(batch.status)) {
      await this.text(from, statusMessage(batch.status));
      return;
    }
    const option = batch.options[0];
    if (!option) {
      await this.text(from, `Option ${position} nahi mila. Diye gaye options me se number bhejiye.`);
      return;
    }

    const { postTime, timezone, destinations } = await this.postingInfo(batch.orgId);
    let at: When;
    if (when === 'now') {
      at = 'now';
    } else if (when === 'tomorrow') {
      at = zonedDateTime(nextDate(localDate(timezone, now)), postTime, timezone);
    } else {
      const due = zonedDateTime(batch.forDate, postTime, timezone);
      if (due.getTime() <= now.getTime()) {
        await this.askNowOrTomorrow(batch.id, position, postTime, from);
        return;
      }
      at = due;
    }

    if (!(await this.choose(batch.id, option.id, at, now))) {
      await this.text(from, statusMessage(batch.status));
      return;
    }
    if (at === 'now') {
      await this.text(from, `Option ${position} chuna gaya. Abhi post kar rahe hain...`);
      await this.publishBatch(batch.id);
      return;
    }
    const day = localDate(timezone, at) === localDate(timezone, now) ? 'aaj' : 'kal';
    await this.confirmScheduled(
      from,
      batch.id,
      position,
      option.id,
      `Option ${position} chuna gaya. Yeh ${day} ${postTime} baje ${destinationsText(destinations)} pe post hoga.`,
    );
  }

  private async askNowOrTomorrow(batchId: string, position: number, postTime: string, to: string) {
    const sender = this.sender();
    if (!sender) return;
    const sent = await this.metaPublisher.sendInteractiveButtonMessage(
      sender.phoneNumberId,
      to,
      `Option ${position}`,
      `Aaj ka ${postTime} ka time nikal chuka hai. Option ${position} abhi post karein ya kal ${postTime} baje?`,
      'Reel2Real daily posts',
      [
        { id: `${NOW_PREFIX}${batchId}_${position}`, title: 'Abhi post karo' },
        { id: `${TOMORROW_PREFIX}${batchId}_${position}`, title: `Kal ${postTime} baje`.slice(0, 20) },
      ],
      sender.accessToken,
    );
    if (!sent) {
      await this.text(
        to,
        `Aaj ka ${postTime} ka time nikal chuka hai. Dashboard ke "Daily posts" me jaakar ` +
          `option ${position} ko abhi ya kal ke liye post kar sakte hain.`,
      );
    }
  }

  /**
   * Confirms a scheduled post with exactly what will go live: the caption and
   * the hashtags, researched now rather than at posting time so the merchant
   * is not approving blind. Buttons: Edit caption, Cancel.
   */
  private async confirmScheduled(to: string, batchId: string, position: number, optionId: string, headline: string) {
    const sender = this.sender();
    if (!sender) return;
    const preview = await this.postPreview(optionId).catch((e) => {
      this.logger.warn(`Preview for option ${optionId} failed: ${e.message}`);
      return '';
    });
    const body = [headline, preview].filter(Boolean).join('\n\n');
    const sent = await this.metaPublisher.sendInteractiveButtonMessage(
      sender.phoneNumberId,
      to,
      'Post scheduled',
      body,
      'Reel2Real daily posts',
      [
        { id: `${CAPTION_PREFIX}${batchId}_${position}`, title: 'Edit caption' },
        { id: `${CANCEL_PREFIX}${batchId}`, title: 'Cancel' },
      ],
      sender.accessToken,
    );
    if (!sent) {
      await this.text(
        to,
        `${body}\n\nCaption badalna ho to "caption: naya caption" likhiye. Rokna ho to "cancel" likhiye.`,
      );
    }
  }

  /** "Caption + hashtags" exactly as they will be posted. */
  private async postPreview(optionId: string): Promise<string> {
    const option = await this.prisma.storyOption.findUnique({
      where: { id: optionId },
      select: {
        id: true,
        title: true,
        caption: true,
        seedKeyword: true,
        hashtags: true,
        keywords: true,
        batch: { select: { orgId: true, trendKeywords: true } },
      },
    });
    if (!option) return '';
    const { hashtags } = await this.ensureHashtags(option);
    let caption = option.caption || option.title;
    if (caption.length > PREVIEW_CAPTION_CHARS) caption = `${caption.slice(0, PREVIEW_CAPTION_CHARS)}…`;
    return ['*Preview (yahi post hoga):*', caption, hashtags.join(' ')].filter(Boolean).join('\n');
  }

  /**
   * Hashtags and keywords for an option, researched once and stored, so the
   * preview the merchant approved is what gets posted.
   */
  private async ensureHashtags(option: {
    id: string;
    seedKeyword: string;
    hashtags?: string[] | null;
    keywords?: string[] | null;
    batch?: { orgId?: string; trendKeywords?: string[] | null } | null;
  }): Promise<{ keywords: string[]; hashtags: string[] }> {
    if (option.hashtags?.length) return { keywords: option.keywords || [], hashtags: option.hashtags };
    const settings = option.batch?.orgId
      ? await this.prisma.storySettings.findUnique({ where: { orgId: option.batch.orgId } })
      : null;
    const research = await this.keywords.research(option.seedKeyword, settings?.keywordDatabase || 'in');
    const keywords = unique([...research.keywords, ...(option.batch?.trendKeywords || [])]).slice(0, 5);
    const hashtags = research.hashtags;
    await this.prisma.storyOption.update({ where: { id: option.id }, data: { keywords, hashtags } });
    return { keywords, hashtags };
  }

  /**
   * Claims the option for posting: scheduled for `at`, or picked for an
   * immediate publish. False when the batch is no longer pickable.
   */
  private async choose(batchId: string, optionId: string, at: When, now: Date): Promise<boolean> {
    const claimed = await this.prisma.storyBatch.updateMany({
      where: { id: batchId, status: { in: PICKABLE } },
      data:
        at === 'now'
          ? { selectedOptionId: optionId, scheduledFor: now, ...NO_EDIT }
          : { status: 'SCHEDULED', selectedOptionId: optionId, scheduledFor: at, ...NO_EDIT },
    });
    return claimed.count > 0;
  }

  private async postingInfo(orgId: string) {
    const [settings, org] = await Promise.all([
      this.prisma.storySettings.findUnique({ where: { orgId } }),
      this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { timezone: true },
      }),
    ]);
    return {
      postTime: settings?.postTime || '19:00',
      timezone: org?.timezone || 'Asia/Kolkata',
      destinations: destinationsOf(settings),
    };
  }

  /** Takes a scheduled post off the calendar; the options stay pickable. */
  private async unschedule(batchId: string): Promise<boolean> {
    const done = await this.prisma.storyBatch.updateMany({
      where: { id: batchId, status: 'SCHEDULED' },
      data: { status: 'AWAITING_PICK', selectedOptionId: null, scheduledFor: null },
    });
    return done.count > 0;
  }

  async cancelFromWhatsApp(batchId: string, from: string) {
    const batch = await this.prisma.storyBatch.findUnique({
      where: { id: batchId },
      select: { waRecipient: true, status: true },
    });
    if (!batch || batch.waRecipient !== from) return;
    if (!(await this.unschedule(batchId))) {
      await this.text(from, statusMessage(batch.status));
      return;
    }
    await this.text(
      from,
      'Schedule cancel ho gaya, kuch post nahi hoga. Dobara chunna ho to kisi option pe "Post this" dabaiye.',
    );
  }

  async startEdit(batchId: string, position: number, from: string, mode: EditMode = 'IMAGE') {
    const batch = await this.prisma.storyBatch.findUnique({
      where: { id: batchId },
      include: { options: { where: { position }, select: { id: true } } },
    });
    if (!batch || batch.waRecipient !== from) return;
    if (!PICKABLE.includes(batch.status)) {
      await this.text(from, statusMessage(batch.status));
      return;
    }
    const option = batch.options[0];
    if (!option) return;
    await this.prisma.storyBatch.update({
      where: { id: batch.id },
      data: { editingOptionId: option.id, editingMode: mode, editingStartedAt: new Date() },
    });
    const body =
      mode === 'CAPTION'
        ? `Option ${position} ka naya caption likh kar bhejiye. Hashtags hum khud jod denge.`
        : `Option ${position} me kya badalna hai? Likh kar bhejiye, jaise:\n` +
          '"background golden karo", "dulhan ki lehenga red karo", "flowers hatao".\n' +
          'Sirf caption badalna ho to aise likhiye: "caption: Aaj book karo, 20% off!"';
    await this.promptWithCancel(from, batch.id, body);
  }

  /** The edit prompt, with an "Edit cancel" button; typing "rehne do" works too. */
  private async promptWithCancel(to: string, batchId: string, body: string) {
    const sender = this.sender();
    if (!sender) return;
    const sent = await this.metaPublisher.sendInteractiveButtonMessage(
      sender.phoneNumberId,
      to,
      'Edit',
      body,
      'Man badal gaya? "rehne do" likhiye',
      [{ id: `${EDIT_CANCEL_PREFIX}${batchId}`, title: 'Edit cancel' }],
      sender.accessToken,
    );
    if (!sent) await this.text(to, `${body}\n\nMan badal gaya to "rehne do" likhiye.`);
  }

  private clearEdit(batchId: string) {
    return this.prisma.storyBatch.updateMany({
      where: { id: batchId, editingOptionId: { not: null } },
      data: NO_EDIT,
    });
  }

  /** "Edit cancel" / "rehne do": leaves the option exactly as it was. */
  async cancelEdit(batchId: string, from: string) {
    const batch = await this.prisma.storyBatch.findUnique({
      where: { id: batchId },
      select: { waRecipient: true },
    });
    if (!batch || batch.waRecipient !== from) return;
    const cleared = await this.clearEdit(batchId);
    await this.text(
      from,
      cleared.count
        ? 'Theek hai, edit cancel. Post jaisi thi waisi hi hai.'
        : 'Koi edit chal nahi raha tha, post jaisi thi waisi hi hai.',
    );
  }

  async applyEdit(batchId: string, optionId: string, instruction: string, from: string, mode: EditMode = 'IMAGE') {
    // Clear the flag first so a retried webhook does not run the edit twice.
    const claimed = await this.prisma.storyBatch.updateMany({
      where: { id: batchId, editingOptionId: optionId },
      data: NO_EDIT,
    });
    if (claimed.count === 0) return;

    if (mode === 'CAPTION' || CAPTION_EDIT.test(instruction)) {
      const caption = instruction.replace(CAPTION_EDIT, '').trim().slice(0, 1000);
      if (!caption) {
        await this.text(from, 'Caption khaali hai. "Edit" dabakar "caption: naya caption" likhiye.');
        return;
      }
      const updated = await this.prisma.storyOption.update({
        where: { id: optionId },
        data: { caption },
      });
      const batch = await this.prisma.storyBatch.findUnique({
        where: { id: batchId },
        select: { status: true, selectedOptionId: true },
      });
      if (batch?.status === 'SCHEDULED' && batch.selectedOptionId === optionId) {
        // Already scheduled: show the new preview; the schedule stays.
        await this.confirmScheduled(from, batchId, updated.position, optionId, 'Caption badal diya. Schedule wahi hai.');
      } else {
        await this.text(from, 'Caption badal diya.');
        await this.sendOption(batchId, updated, from);
      }
      return;
    }

    const option = await this.prisma.storyOption.findUnique({
      where: { id: optionId },
    });
    if (!option?.imageData) return;

    await this.text(from, 'Badlav kar rahe hain, ek minute...');
    try {
      const updated = await this.editOptionImage(option.id, Buffer.from(option.imageData), instruction);
      await this.sendOption(batchId, updated, from);
    } catch (e: any) {
      this.logger.warn(`Edit failed for option ${option.id}: ${e.message}`);
      await this.text(from, 'Yeh badlav nahi ho paya. Thoda alag shabdon me dobara "Edit" dabakar likhiye.');
    }
  }

  private async editOptionImage(optionId: string, image: Buffer, instruction: string) {
    const edited = await toStoryJpeg(
      await this.withRetry(() => this.gemini.editImage(image, 'image/jpeg', instruction)),
    );
    return this.prisma.storyOption.update({
      where: { id: optionId },
      data: {
        imageData: new Uint8Array(edited),
        finalImageData: null,
        revision: { increment: 1 },
      },
    });
  }

  // ------------------------------------------------------ the seller's photos

  /** A photo the seller sent to our WhatsApp number becomes a post they can schedule. */
  async receiveOwnPhoto(msg: any) {
    const from = String(msg?.from || '');
    const sender = this.sender();
    if (!sender) return;
    const settings = await this.prisma.storySettings.findFirst({
      where: { whatsappNumber: from },
      select: { orgId: true },
    });
    if (!settings) return;
    try {
      const media = await this.metaPublisher.downloadWhatsAppMedia(String(msg.image.id), sender.accessToken);
      await this.text(from, 'Photo mil gayi, post taiyaar kar rahe hain...');
      await this.addOwnPost(settings.orgId, media.data, {
        caption: msg.image.caption || null,
        notifyTo: from,
      });
    } catch (e: any) {
      this.logger.warn(`Own photo from ${from} failed: ${e.message}`);
      await this.text(from, 'Yeh photo post ke liye taiyaar nahi ho payi. Dobara bhejiye.');
    }
  }

  /**
   * Turns the seller's own photo into a post: kept as it is (no AI lettering),
   * given a caption and keyword, and either scheduled for `at` or offered on
   * WhatsApp with Post this / Edit like the daily ideas.
   */
  async addOwnPost(
    orgId: string,
    image: Buffer,
    opts: { caption?: string | null; at?: Date | null; notifyTo?: string | null } = {},
    now = new Date(),
  ) {
    const [settings, org, profile, products] = await Promise.all([
      this.prisma.storySettings.findUnique({ where: { orgId } }),
      this.prisma.organization.findUnique({ where: { id: orgId } }),
      this.prisma.businessProfile.findUnique({ where: { orgId } }).catch(() => null),
      this.prisma.offering.findMany({
        where: { orgId, isActive: true },
        orderBy: { updatedAt: 'desc' },
        take: 40,
        select: { id: true, title: true },
      }),
    ]);
    if (!org) throw new NotFoundException('Organization not found');
    const tz = org.timezone || 'Asia/Kolkata';
    const draft = await toPaddedStoryJpeg(image);
    const sellerCaption = opts.caption?.trim().slice(0, 1000) || null;

    let details = {
      title: sellerCaption ? sellerCaption.split('\n')[0].slice(0, 24) : 'Aaj ki post',
      caption: sellerCaption || '',
      seedKeyword:
        settings?.nicheKeywords?.[0] || (profile?.industry ? humanIndustry(profile.industry) : 'new arrival'),
      offeringId: null as string | null,
    };
    if (this.gemini.isConfigured()) {
      try {
        const d = await this.gemini.describeOwnPhoto(
          { data: draft, mimeType: 'image/jpeg' },
          {
            brandName: profile?.businessName || org.name,
            description: settings?.businessDescription || profile?.description,
            products,
            sellerCaption,
          },
        );
        details = {
          title: d.title || details.title,
          caption: d.caption || details.caption,
          seedKeyword: d.seedKeyword || details.seedKeyword,
          offeringId: d.offeringId,
        };
      } catch (e: any) {
        this.logger.warn(`Describing own photo failed: ${e.message}`);
      }
    }

    const batch = await this.prisma.storyBatch.create({
      data: {
        orgId,
        forDate: localDate(tz, opts.at || now),
        kind: 'OWN',
        status: 'AWAITING_PICK',
        waRecipient: settings?.whatsappNumber || null,
      },
    });
    const option = await this.prisma.storyOption.create({
      data: {
        batchId: batch.id,
        position: 1,
        title: details.title,
        label: 'Your photo',
        idea: sellerCaption ? 'Aapki bheji hui photo' : 'Aapki photo, AI caption ke saath',
        caption: details.caption || null,
        imagePrompt: '',
        seedKeyword: details.seedKeyword,
        source: 'OWN',
        offeringId: details.offeringId,
        imageData: new Uint8Array(draft),
      },
    });
    if (opts.at) await this.choose(batch.id, option.id, opts.at, now);

    if (opts.notifyTo) {
      await this.sendOption(batch.id, option, opts.notifyTo);
      const postTime = settings?.postTime || '19:00';
      await this.text(
        opts.notifyTo,
        `"Post this" dabaiye to yeh ${postTime} baje ${destinationsText(destinationsOf(settings))} pe jaayegi. ` +
          'Caption badalna ho to "Edit" dabaiye.',
      );
    }
    const saved = await this.prisma.storyBatch.findUnique({
      where: { id: batch.id },
      include: { options: { orderBy: { position: 'asc' }, select: OPTION_FIELDS } },
    });
    return saved ? this.batchView(saved) : null;
  }

  // ------------------------------------------------------------ dashboard

  private async batchForOrg(orgId: string, batchId: string, position?: number) {
    const batch = await this.prisma.storyBatch.findFirst({
      where: { id: batchId, orgId },
      include: {
        options: { where: position ? { position } : undefined, select: { id: true, imageData: true } },
      },
    });
    if (!batch) throw new NotFoundException('Post not found');
    return batch;
  }

  /**
   * Picks an option from the dashboard. `at` schedules it for any moment in the
   * next 30 days; `when` is "now", "tomorrow" (the posting time) or, by
   * default, today's posting time, which must still be ahead.
   */
  async pickFromDashboard(
    orgId: string,
    batchId: string,
    position: number,
    input: { when?: 'now' | 'tomorrow' | 'scheduled'; at?: string | null },
    now = new Date(),
  ) {
    const batch = await this.batchForOrg(orgId, batchId, position);
    if (!PICKABLE.includes(batch.status)) throw new BadRequestException(statusMessage(batch.status));
    const option = batch.options[0];
    if (!option) throw new NotFoundException(`Option ${position} not found`);
    const { postTime, timezone } = await this.postingInfo(orgId);

    let at: When;
    if (input.at) {
      at = parseScheduleTime(input.at, now);
    } else if (input.when === 'now') {
      at = 'now';
    } else if (input.when === 'tomorrow') {
      at = zonedDateTime(nextDate(localDate(timezone, now)), postTime, timezone);
    } else {
      at = zonedDateTime(batch.forDate, postTime, timezone);
      if (at.getTime() <= now.getTime()) {
        throw new BadRequestException({
          message: `Today's posting time (${postTime}) has passed. Post it now or schedule it for later.`,
          code: 'TIME_PASSED',
        });
      }
    }
    if (!(await this.choose(batch.id, option.id, at, now))) {
      throw new BadRequestException('This post can no longer be changed');
    }
    if (at === 'now') {
      // Instagram takes a while to process; the dashboard polls the result.
      setImmediate(() => void this.publishBatch(batch.id).catch(() => undefined));
      return { status: 'PUBLISHING', scheduledFor: now };
    }
    // Same preview as on WhatsApp: the hashtags that will go live, shown on the card.
    let hashtags: string[] = [];
    try {
      const full = await this.prisma.storyOption.findUnique({
        where: { id: option.id },
        select: {
          id: true,
          seedKeyword: true,
          hashtags: true,
          keywords: true,
          batch: { select: { orgId: true, trendKeywords: true } },
        },
      });
      if (full) hashtags = (await this.ensureHashtags(full)).hashtags;
    } catch (e: any) {
      this.logger.warn(`Hashtag research for option ${option.id} failed: ${e.message}`);
    }
    return { status: 'SCHEDULED', scheduledFor: at, hashtags };
  }

  async cancelFromDashboard(orgId: string, batchId: string) {
    await this.batchForOrg(orgId, batchId);
    if (!(await this.unschedule(batchId))) {
      throw new BadRequestException('Only a scheduled post can be cancelled');
    }
    return { status: 'AWAITING_PICK' };
  }

  async editFromDashboard(orgId: string, batchId: string, position: number, instruction: string) {
    const text = String(instruction || '').trim();
    if (!text) throw new BadRequestException('Describe what to change');
    const batch = await this.batchForOrg(orgId, batchId, position);
    if (!PICKABLE.includes(batch.status)) throw new BadRequestException(statusMessage(batch.status));
    const option = batch.options[0];
    if (!option?.imageData) throw new NotFoundException(`Option ${position} not found`);
    if (!this.gemini.isConfigured()) throw new BadRequestException('Image editing is not set up');
    const updated = await this.editOptionImage(option.id, Buffer.from(option.imageData), text.slice(0, 500));
    return { id: updated.id, revision: updated.revision, imageUrl: this.mediaUrl(updated.id, 'draft', updated.revision) };
  }

  async setCaption(orgId: string, batchId: string, position: number, caption: string | null) {
    const batch = await this.batchForOrg(orgId, batchId, position);
    if (!PICKABLE.includes(batch.status)) throw new BadRequestException(statusMessage(batch.status));
    const option = batch.options[0];
    if (!option) throw new NotFoundException(`Option ${position} not found`);
    return this.prisma.storyOption.update({
      where: { id: option.id },
      data: { caption: caption?.trim().slice(0, 1000) || null },
      select: { id: true, caption: true },
    });
  }

  /** A photo uploaded from the dashboard (data URL or base64), optionally scheduled. */
  async uploadOwnPost(
    orgId: string,
    input: { image?: string; caption?: string | null; at?: string | null },
    now = new Date(),
  ) {
    const image = decodeImage(input.image);
    const at = input.at ? parseScheduleTime(input.at, now) : null;
    return this.addOwnPost(orgId, image, { caption: input.caption, at }, now);
  }

  // ------------------------------------------------------------ publishing

  /** Publishes every scheduled batch whose time has come. */
  async publishDue(now = new Date()): Promise<number> {
    const due = await this.prisma.storyBatch.findMany({
      where: { status: 'SCHEDULED', scheduledFor: { lte: now } },
      select: { id: true },
      take: 50,
    });
    let published = 0;
    for (const b of due) {
      if (await this.publishBatch(b.id).catch(() => false)) published += 1;
    }
    return published;
  }

  /**
   * Claims the batch atomically (so a double tap or overlapping cron tick
   * publishes once), posts the picked option everywhere the merchant chose and
   * reports each result on WhatsApp.
   */
  async publishBatch(batchId: string): Promise<boolean> {
    const batch = await this.prisma.storyBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch?.selectedOptionId) return false;
    const claimed = await this.prisma.storyBatch.updateMany({
      where: { id: batch.id, status: { in: PICKABLE } },
      data: { status: 'PUBLISHING', error: undefined },
    });
    if (claimed.count === 0) return false;
    const to = batch.waRecipient || '';

    try {
      const result = await this.publishOption(batch.orgId, batch.selectedOptionId);
      const entries = Object.entries(result.targets) as Array<[Destination, TargetResult]>;
      const ok = entries.filter(([, r]) => r.ok);
      const failed = entries.filter(([, r]) => !r.ok);
      await this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: {
          status: ok.length ? 'PUBLISHED' : 'FAILED',
          publishedMediaId: ok[0]?.[1].id ?? null,
          publishedTargets: result.targets,
          ...(ok.length
            ? {}
            : {
                error: {
                  stage: 'publish',
                  message: failed.map(([, r]) => r.error).join('; '),
                },
              }),
        },
      });
      const lines = [
        ok.length
          ? `Post live hai: ${ok.map(([d]) => DESTINATION_NAMES[d]).join(', ')}.`
          : 'Post publish nahi ho payi.',
        ...failed.map(([d, r]) => `${DESTINATION_NAMES[d]}: ${r.error}`),
        result.keywords.length ? `Keywords: ${result.keywords.join(', ')}` : '',
        result.hashtags.length ? `Hashtags: ${result.hashtags.join(' ')}` : '',
        ok.length ? '' : 'Dobara try karne ke liye "Post this" phir se dabaiye.',
      ];
      if (to) await this.text(to, lines.filter(Boolean).join('\n'));
      return ok.length > 0;
    } catch (e: any) {
      this.logger.error(`Post publish failed for batch ${batch.id}: ${e.message}`);
      await this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: {
          status: 'FAILED',
          error: { stage: 'publish', message: e.message },
        },
      });
      if (to)
        await this.text(
          to,
          `Post publish nahi ho payi: ${e.message}\nDobara try karne ke liye "Post this" phir se dabaiye.`,
        );
      return false;
    }
  }

  /**
   * Researches hashtags for the option, letters the story version, and posts it
   * to each chosen destination independently: one failing does not stop the rest.
   * Every post that went out is remembered with its caption and catalog item,
   * so the first comments on it already get the right answer.
   */
  async publishOption(orgId: string, optionId: string) {
    const option = await this.prisma.storyOption.findUnique({
      where: { id: optionId },
      include: { batch: { select: { orgId: true, trendKeywords: true } } },
    });
    if (!option?.imageData) throw new Error('Post image is missing');
    const settings = await this.prisma.storySettings.findUnique({
      where: { orgId },
    });
    const destinations = destinationsOf(settings);

    // The hashtags shown in the WhatsApp preview, when the merchant saw one.
    const { keywords, hashtags } = await this.ensureHashtags(option);
    const draft = Buffer.from(option.imageData);

    let finalImage: Buffer | null = null;
    if (destinations.includes('IG_STORY') || destinations.includes('IG_REEL')) {
      if (option.source === 'OWN') {
        // The seller's own photo goes out as they sent it.
        finalImage = draft;
      } else {
        try {
          finalImage = await toStoryJpeg(await this.gemini.addTextToImage(draft, 'image/jpeg', option.title, hashtags));
        } catch (e: any) {
          this.logger.warn(`Gemini lettering failed, using overlay: ${e.message}`);
          finalImage = await overlayText(draft, option.title, hashtags);
        }
      }
    }
    // The Reel is the lettered story image with a slow zoom. Made before any
    // publishing so a failure only costs the Reel, not the other destinations.
    let reelError: string | null = null;
    let reel: Buffer | null = null;
    if (destinations.includes('IG_REEL')) {
      try {
        reel = await toReelMp4(finalImage || draft);
      } catch (e: any) {
        reelError = e.message;
        this.logger.warn(`Reel video for option ${option.id} failed: ${e.message}`);
      }
    }
    await this.prisma.storyOption.update({
      where: { id: option.id },
      data: {
        keywords,
        hashtags,
        ...(finalImage ? { finalImageData: new Uint8Array(finalImage) } : {}),
        ...(reel ? { reelVideoData: new Uint8Array(reel) } : {}),
      },
    });

    const caption = [option.caption || option.title, hashtags.join(' ')].filter(Boolean).join('\n\n');
    const targets: Partial<Record<Destination, TargetResult>> = {};
    const published: Array<{ postId: string; platform: string; channelId: string }> = [];
    const attempt = async (d: Destination, channelId: string, run: () => Promise<string>) => {
      try {
        const id = await run();
        targets[d] = { ok: true, id };
        published.push({ postId: id, platform: d === 'FB_FEED' ? 'FACEBOOK' : 'INSTAGRAM', channelId });
      } catch (e: any) {
        this.logger.warn(`Publishing ${d} for option ${option.id} failed: ${e.message}`);
        targets[d] = { ok: false, error: e.message };
      }
    };

    if (destinations.some((d) => d.startsWith('IG_'))) {
      const ig = await this.instagramChannel(orgId, settings?.instagramChannelId);
      for (const d of destinations.filter((x) => x.startsWith('IG_'))) {
        if (!ig) {
          targets[d] = {
            ok: false,
            error: 'Instagram account is not connected any more',
          };
          continue;
        }
        if (d === 'IG_REEL' && !reel) {
          targets[d] = { ok: false, error: reelError || 'Reel video could not be made' };
          continue;
        }
        const token = this.crypto.decrypt(ig.accessTokenEncrypted);
        await attempt(d, ig.id, () =>
          d === 'IG_STORY'
            ? this.metaPublisher.publishInstagramStory(ig.channelIdentifier, this.mediaUrl(option.id, 'final'), token)
            : d === 'IG_REEL'
              ? this.metaPublisher.publishInstagramReel(
                  ig.channelIdentifier,
                  this.mediaUrl(option.id, 'reel', option.revision),
                  caption,
                  token,
                )
              : this.metaPublisher.publishInstagramFeed(
                  ig.channelIdentifier,
                  this.mediaUrl(option.id, 'feed'),
                  caption,
                  token,
                ),
        );
      }
    }
    if (destinations.includes('FB_FEED')) {
      const fb = await this.facebookChannel(orgId, settings?.facebookChannelId);
      if (!fb)
        targets.FB_FEED = {
          ok: false,
          error: 'Facebook Page is not connected any more',
        };
      else {
        const token = this.crypto.decrypt(fb.accessTokenEncrypted);
        await attempt('FB_FEED', fb.id, () =>
          this.metaPublisher.publishFacebookPhoto(
            fb.channelIdentifier,
            this.mediaUrl(option.id, 'feed'),
            caption,
            token,
          ),
        );
      }
    }
    await this.rememberPublished(orgId, option.offeringId, caption, published);
    return { targets, keywords, hashtags };
  }

  /** Stores each published post's caption, and links it to its catalog item as confirmed. */
  private async rememberPublished(
    orgId: string,
    offeringId: string | null,
    caption: string,
    published: Array<{ postId: string; platform: string; channelId: string }>,
  ) {
    const now = new Date();
    for (const p of published) {
      try {
        await this.prisma.socialPost.upsert({
          where: { orgId_postId: { orgId, postId: p.postId } },
          create: {
            orgId,
            postId: p.postId,
            platform: p.platform,
            channelId: p.channelId,
            caption: caption.slice(0, 2000),
            source: 'DAILY_POST',
            taggedAt: now,
          },
          update: { caption: caption.slice(0, 2000), taggedAt: now },
        });
        if (offeringId) {
          await this.prisma.postOfferingLink.upsert({
            where: { postId_offeringId: { postId: p.postId, offeringId } },
            create: {
              orgId,
              postId: p.postId,
              platform: p.platform,
              offeringId,
              caption: caption.slice(0, 1000),
              status: 'SELLER_CONFIRMED',
              confidence: 1,
              reason: 'Published from daily posts',
            },
            update: {},
          });
        }
      } catch (e: any) {
        this.logger.warn(`Could not remember published post ${p.postId}: ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------------ media

  /** `revision` changes the URL after an edit, so caches (and WhatsApp) fetch the new image. */
  mediaUrl(optionId: string, variant: MediaVariant, revision?: number | null): string {
    const base = (process.env.STORY_MEDIA_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:5002').replace(
      /\/$/,
      '',
    );
    const ext = variant === 'reel' ? 'mp4' : 'jpg';
    const url = `${base}/api/stories/media/${optionId}/${variant}/${this.sign(optionId, variant)}.${ext}`;
    return revision ? `${url}?v=${revision}` : url;
  }

  async getMedia(optionId: string, variant: string, signature: string): Promise<Buffer> {
    if (!['draft', 'final', 'feed', 'reel'].includes(variant)) throw new NotFoundException();
    if (!timingSafeEqualString(signature.replace(/\.(jpg|mp4)$/, ''), this.sign(optionId, variant))) {
      throw new NotFoundException();
    }
    if (variant === 'reel') {
      const reel = await this.prisma.storyOption.findUnique({
        where: { id: optionId },
        select: { reelVideoData: true },
      });
      if (!reel?.reelVideoData) throw new NotFoundException();
      return Buffer.from(reel.reelVideoData);
    }
    const option = await this.prisma.storyOption.findUnique({
      where: { id: optionId },
      select: { imageData: true, finalImageData: true },
    });
    if (variant === 'feed') {
      // Feed crops the clean draft: the story lettering sits where a 4:5 crop cuts.
      if (!option?.imageData) throw new NotFoundException();
      return toFeedJpeg(Buffer.from(option.imageData));
    }
    const data = variant === 'final' ? option?.finalImageData : option?.imageData;
    if (!data) throw new NotFoundException();
    return Buffer.from(data);
  }

  private sign(optionId: string, variant: string): string {
    const secret = process.env.STORY_MEDIA_SECRET || process.env.ENCRYPTION_SECRET || '';
    return crypto.createHmac('sha256', secret).update(`${optionId}:${variant}`).digest('base64url').slice(0, 32);
  }

  // ---------------------------------------------------------------- helpers

  /** The Reel2Real WhatsApp number that messages merchants. */
  private sender(): WaSender | null {
    return reel2realSender();
  }

  private instagramChannel(orgId: string, preferredId?: string | null) {
    return this.activeChannel(orgId, 'INSTAGRAM', preferredId);
  }

  private facebookChannel(orgId: string, preferredId?: string | null) {
    return this.activeChannel(orgId, 'FACEBOOK', preferredId);
  }

  private activeChannel(orgId: string, platform: string, preferredId?: string | null) {
    return this.prisma.channel.findFirst({
      where: {
        orgId,
        platform,
        isActive: true,
        status: 'ACTIVE',
        ...(preferredId ? { id: preferredId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async text(to: string, body: string) {
    const sender = this.sender();
    if (!sender) return;
    await this.metaPublisher.sendWhatsAppMessage(sender.phoneNumberId, to, body, sender.accessToken);
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      this.logger.warn(`Retrying after: ${e.message}`);
      return fn();
    }
  }
}

const OPTION_FIELDS = {
  id: true,
  position: true,
  title: true,
  label: true,
  idea: true,
  caption: true,
  revision: true,
  seedKeyword: true,
  keywords: true,
  hashtags: true,
  source: true,
  offeringId: true,
} as const;

// Everything that marks a batch as "in edit mode".
const NO_EDIT = { editingOptionId: null, editingMode: null, editingStartedAt: null };

const PICK_VERB = String.raw`(?:post|pick|select|chuno|choose|lagao|laga\s*do|daalo|dalo|daal\s*do|final)`;
const PICK_TEXT = [
  // "2", "option 2", "2 post karo", "no. 3 wala post kar do", "2 please"
  new RegExp(
    String.raw`^(?:option|opt|no\.?|number|#)?\s*([1-5])\s*(?:wala|wali|waala|waali|vala|vali)?\s*${PICK_VERB}?\s*(?:karo|kar\s*do|kardo|kijiye|please|pls)?[.!\s]*$`,
    'i',
  ),
  // "post 2", "post option 3", "chuno 1"
  new RegExp(String.raw`^${PICK_VERB}\s*(?:option|opt|no\.?|number|#)?\s*([1-5])[.!\s]*$`, 'i'),
];

/** The option number in "2", "option 2 post karo", "post 3"; null for anything else. */
export function pickIntent(text: string): number | null {
  const t = String(text || '').trim();
  for (const re of PICK_TEXT) {
    const m = re.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}

function editingMode(value: string | null | undefined): EditMode {
  return value === 'CAPTION' ? 'CAPTION' : 'IMAGE';
}

function replyId(msg: any): string | undefined {
  return msg?.button?.payload || msg?.interactive?.list_reply?.id || msg?.interactive?.button_reply?.id;
}

function statusMessage(status: string): string {
  if (status === 'PUBLISHING') return 'Aapki chuni hui post abhi publish ho rahi hai.';
  if (status === 'PUBLISHED') return 'Aaj ki post already lag chuki hai. Kal naye ideas aayenge.';
  if (status === 'GENERATING') return 'Aaj ke ideas abhi ban rahe hain, thodi der me bhejte hain.';
  if (status === 'AWAITING_PICK' || status === 'NOTIFIED') return 'Yeh post schedule nahi thi.';
  return 'Ye ideas ab available nahi hain. Kal naye ideas aayenge.';
}

function regenerateBlockedMessage(status: string): string {
  if (status === 'GENERATING') return "Today's ideas are still being made. They reach WhatsApp in a few minutes.";
  if (status === 'PUBLISHED') return "Today's post is already live. New ideas come tomorrow.";
  if (status === 'PUBLISHING') return "Today's post is being published right now.";
  return "Today's picked post is scheduled. Cancel it first if you want new ideas.";
}

/** Brand voice for the ideas: the org's saved persona plus the setup answers. */
function brandPersona(
  saved: unknown,
  style: { tone?: string | null; language?: string | null; audience?: string | null },
): Record<string, unknown> | null {
  const base = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...base };
  if (style.tone) merged.tone = style.tone;
  if (style.language) merged.language = style.language;
  if (style.audience) merged.audience = style.audience;
  return Object.keys(merged).length ? merged : null;
}

function destinationsOf(settings?: { destinations?: string[] | null } | null): Destination[] {
  const list = (settings?.destinations || []).filter((d): d is Destination =>
    (DESTINATIONS as readonly string[]).includes(d),
  );
  return list.length ? list : ['IG_STORY'];
}

function destinationsText(list: Destination[]): string {
  return list.map((d) => DESTINATION_NAMES[d]).join(', ');
}

function clampCount(n?: number | null): number {
  const v = Number(n) || OPTION_COUNT;
  return Math.min(MAX_OPTIONS, Math.max(MIN_OPTIONS, v));
}

function humanIndustry(industry: string): string {
  return industry.toLowerCase().replace(/_/g, ' ');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** A future moment within the next 30 days, from an ISO string. */
export function parseScheduleTime(input: string, now = new Date()): Date {
  const at = new Date(input);
  if (Number.isNaN(at.getTime())) throw new BadRequestException('Choose a valid date and time');
  if (at.getTime() < now.getTime() + MIN_SCHEDULE_AHEAD_MS) {
    throw new BadRequestException('Choose a time at least a few minutes from now');
  }
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) {
    throw new BadRequestException('Posts can be scheduled up to 30 days ahead');
  }
  return at;
}

/** Image bytes from a data URL or bare base64; JPEG, PNG or WebP up to 8 MB. */
export function decodeImage(input?: string | null): Buffer {
  const m = /^(?:data:(image\/(?:jpeg|png|webp));base64,)?([A-Za-z0-9+/=\s]+)$/.exec(String(input || ''));
  if (!m) throw new BadRequestException('Upload a JPEG, PNG or WebP photo');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) throw new BadRequestException('The photo is empty');
  if (data.length > MAX_UPLOAD_BYTES) throw new BadRequestException('The photo must be under 8 MB');
  return data;
}

/** The day after a YYYY-MM-DD date. */
export function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Accepts "9:5", "09:05", "9.05"; returns "HH:MM" or null. */
export function normalizeTime(input: string): string | null {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(input || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Digits only, with country code. Ten-digit numbers are assumed Indian (+91). */
export function normalizeWhatsAppNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length < 11 || digits.length > 15) {
    throw new BadRequestException('Enter the WhatsApp number with country code, e.g. +91 98765 43210');
  }
  return digits;
}

/** YYYY-MM-DD for `now` in the given IANA timezone. */
export function localDate(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(now);
  }
}

/** "HH:MM" wall-clock time for `now` in the given timezone. */
export function localTime(timeZone: string, now = new Date()): string {
  const parts = zonedParts(timeZone, now);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/** The instant at which the wall clock in `timeZone` reads `date` `time`. */
export function zonedDateTime(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = zonedParts(timeZone, new Date(guess));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
  return new Date(guess - offset);
}

function zonedParts(timeZone: string, at: Date) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch {
    return zonedParts('Asia/Kolkata', at);
  }
  const get = (type: string) => Number(fmt.formatToParts(at).find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}
