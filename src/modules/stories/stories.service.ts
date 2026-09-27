import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { timingSafeEqualString } from '../../common/hmac';
import { GeminiClient } from './gemini.client';
import { KeywordResearchService } from './keyword-research.service';
import { overlayText, toFeedJpeg, toStoryJpeg } from './story-image';

export const OPTION_COUNT = 5;
const MIN_OPTIONS = 4;
const MAX_OPTIONS = 5;
const SHOW_PREFIX = 'STORY_SHOW_';
// Legacy list picker rows; still honoured for batches sent before the buttons.
const PICK_PREFIX = 'STORY_PICK_';
const POST_PREFIX = 'STORY_POST_';
const EDIT_PREFIX = 'STORY_EDIT_';
// Statuses from which the merchant may still pick (or re-pick); FAILED lets them retry.
const PICKABLE = ['NOTIFIED', 'AWAITING_PICK', 'SCHEDULED', 'FAILED'];
const PICK_WINDOW_MS = 36 * 60 * 60 * 1000;
export const DESTINATIONS = ['IG_STORY', 'IG_FEED', 'FB_FEED'] as const;
export type Destination = (typeof DESTINATIONS)[number];
const DESTINATION_NAMES: Record<Destination, string> = {
  IG_STORY: 'Instagram story',
  IG_FEED: 'Instagram post',
  FB_FEED: 'Facebook post',
};

type Sender = { phoneNumberId: string; accessToken: string };
export type MediaVariant = 'draft' | 'final' | 'feed';
type TargetResult = { ok: boolean; id?: string; error?: string };

/**
 * Daily post ideas: research what is trending in the merchant's niche, turn it
 * into four or five labelled images, deliver them on WhatsApp from the
 * Reel2Real number with Post this / Edit buttons, and publish the picked one at
 * the merchant's posting time to their Instagram story, Instagram feed and/or
 * Facebook Page.
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

  async listBatches(orgId: string, take = 7) {
    const batches = await this.prisma.storyBatch.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take,
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
            revision: true,
            seedKeyword: true,
            keywords: true,
            hashtags: true,
          },
        },
      },
    });
    return batches.map((b) => ({
      ...b,
      options: b.options.map((o) => ({
        ...o,
        imageUrl: this.mediaUrl(o.id, 'draft'),
        finalImageUrl: b.selectedOptionId === o.id && b.status === 'PUBLISHED' ? this.mediaUrl(o.id, 'final') : null,
      })),
    }));
  }

  // ------------------------------------------------------------ generation

  /**
   * Entry point for the cron, which now runs every 15 minutes: sends today's
   * ideas to each org whose send time has passed, then publishes picks that are
   * due. Both steps are idempotent, so a missed or repeated tick is harmless.
   */
  async runDaily(now = new Date()): Promise<{ started: boolean; orgs: number; published: number }> {
    if (this.dailyRunning) return { started: false, orgs: 0, published: 0 };
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
        const today = await this.prisma.storyBatch.findUnique({
          where: {
            orgId_forDate: { orgId: s.orgId, forDate: localDate(tz, now) },
          },
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
      return { started: true, orgs, published };
    } finally {
      this.dailyRunning = false;
    }
  }

  /**
   * Creates today's batch for one org and notifies the merchant. Idempotent per
   * day: an existing batch is kept unless it failed or `force` is set.
   */
  async generateBatch(orgId: string, opts: { force?: boolean } = {}) {
    const sender = this.sender();
    if (!sender) throw new Error('Story WhatsApp sender is not configured');
    if (!this.gemini.isConfigured()) throw new Error('GEMINI_API_KEY is not set');

    const settings = await this.prisma.storySettings.findUnique({
      where: { orgId },
    });
    if (!settings?.whatsappNumber) throw new Error('No WhatsApp number set for daily posts');
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
    const existing = await this.prisma.storyBatch.findUnique({
      where: { orgId_forDate: { orgId, forDate } },
    });
    if (existing && existing.status !== 'FAILED' && !opts.force) return existing;
    if (existing) await this.prisma.storyBatch.delete({ where: { id: existing.id } });

    const batch = await this.prisma.storyBatch.create({
      data: {
        orgId,
        forDate,
        status: 'GENERATING',
        waRecipient: settings.whatsappNumber,
      },
    });

    try {
      const [products, recent, profile] = await Promise.all([
        this.prisma.offering
          .findMany({
            where: { orgId, isActive: true },
            orderBy: { updatedAt: 'desc' },
            take: 10,
            select: { title: true, priceMin: true, currency: true },
          })
          .then((rows) =>
            rows.map((r) => ({
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
      ]);
      const description = settings.businessDescription || profile?.description || null;

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
          persona: org.brandPersona,
          products,
          recentTitles: recent.map((r) => r.title),
          forDate,
          trendKeywords,
        },
        count,
      );

      for (let i = 0; i < ideas.length; i++) {
        const idea = ideas[i];
        const image = await toStoryJpeg(await this.withRetry(() => this.gemini.generateImage(idea.imagePrompt)));
        await this.prisma.storyOption.create({
          data: {
            batchId: batch.id,
            position: i + 1,
            ...idea,
            label: idea.label || `Trending: ${idea.seedKeyword}`.slice(0, 30),
            imageData: new Uint8Array(image),
          },
        });
      }

      const sent = await this.metaPublisher.sendWhatsAppTemplate(
        sender.phoneNumberId,
        settings.whatsappNumber,
        process.env.STORY_WA_TEMPLATE || 'daily_story_ideas',
        process.env.STORY_WA_TEMPLATE_LANG || 'en',
        [
          { type: 'body', parameters: [{ type: 'text', text: org.name }] },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: `${SHOW_PREFIX}${batch.id}` }],
          },
        ],
        sender.accessToken,
      );
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

  // -------------------------------------------------------- WhatsApp replies

  /** True for inbound messages this service owns; checked before the generic inbox/AI path. */
  async isStoryReply(msg: any, phoneNumberId: string): Promise<boolean> {
    const id = replyId(msg);
    if (id && [SHOW_PREFIX, PICK_PREFIX, POST_PREFIX, EDIT_PREFIX].some((p) => id.startsWith(p))) return true;
    const sender = this.sender();
    if (!sender || phoneNumberId !== sender.phoneNumberId) return false;
    const text = String(msg?.text?.body || '').trim();
    if (/^[1-5]$/.test(text)) return true;
    // Free text is ours only while the merchant is describing an edit.
    if (!text) return false;
    const editing = await this.prisma.storyBatch.findFirst({
      where: {
        waRecipient: String(msg?.from || ''),
        editingOptionId: { not: null },
        status: { in: PICKABLE },
        createdAt: { gt: new Date(Date.now() - PICK_WINDOW_MS) },
      },
      select: { id: true },
    });
    return Boolean(editing);
  }

  async handleWhatsAppReply(msg: any): Promise<void> {
    const from = String(msg?.from || '');
    const id = replyId(msg);
    if (id?.startsWith(SHOW_PREFIX)) {
      return this.showOptions(id.slice(SHOW_PREFIX.length), from);
    }
    for (const prefix of [POST_PREFIX, PICK_PREFIX, EDIT_PREFIX]) {
      if (!id?.startsWith(prefix)) continue;
      const rest = id.slice(prefix.length);
      const sep = rest.lastIndexOf('_');
      const batchId = rest.slice(0, sep);
      const position = Number(rest.slice(sep + 1));
      return prefix === EDIT_PREFIX ? this.startEdit(batchId, position, from) : this.pick(batchId, position, from);
    }

    const text = String(msg?.text?.body || '').trim();
    const batch = await this.prisma.storyBatch.findFirst({
      where: {
        waRecipient: from,
        status: { in: PICKABLE },
        createdAt: { gt: new Date(Date.now() - PICK_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!batch) return;
    if (batch.editingOptionId && !/^[1-5]$/.test(text)) {
      return this.applyEdit(batch.id, batch.editingOptionId, text, from);
    }
    return this.pick(batch.id, Number(text), from);
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

  private async sendOption(
    batchId: string,
    o: {
      id: string;
      position: number;
      title: string;
      label?: string | null;
      idea: string;
    },
    to: string,
  ) {
    const sender = this.sender();
    if (!sender) return;
    const body = `${o.position}. ${o.label ? `[${o.label}] ` : ''}*${o.title}*\n${o.idea}`;
    const sent = await this.metaPublisher.sendWhatsAppImageButtons(
      sender.phoneNumberId,
      to,
      this.mediaUrl(o.id, 'draft'),
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
        this.mediaUrl(o.id, 'draft'),
        `${body}\n\nIse chunne ke liye ${o.position} bhejiye.`,
        sender.accessToken,
      );
    }
  }

  /**
   * "Post this": schedules the option for the merchant's posting time, or
   * publishes right away when that time has already passed today. Picking
   * another option before then replaces the pick.
   */
  async pick(batchId: string, position: number, from: string, now = new Date()) {
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

    const [settings, org] = await Promise.all([
      this.prisma.storySettings.findUnique({ where: { orgId: batch.orgId } }),
      this.prisma.organization.findUnique({
        where: { id: batch.orgId },
        select: { timezone: true },
      }),
    ]);
    const postTime = settings?.postTime || '19:00';
    const scheduledFor = zonedDateTime(batch.forDate, postTime, org?.timezone || 'Asia/Kolkata');
    const destinations = destinationsText(destinationsOf(settings));

    if (scheduledFor.getTime() > now.getTime()) {
      const claimed = await this.prisma.storyBatch.updateMany({
        where: { id: batch.id, status: { in: PICKABLE } },
        data: {
          status: 'SCHEDULED',
          selectedOptionId: option.id,
          scheduledFor,
          editingOptionId: null,
        },
      });
      if (claimed.count === 0) {
        await this.text(from, statusMessage(batch.status));
        return;
      }
      await this.text(
        from,
        `Option ${position} chuna gaya. Yeh aaj ${postTime} baje ${destinations} pe post hoga.\n` +
          'Badalna ho to kisi aur option pe "Post this" dabaiye, ya "Edit" se isme badlav kijiye.',
      );
      return;
    }

    await this.prisma.storyBatch.updateMany({
      where: { id: batch.id, status: { in: PICKABLE } },
      data: {
        selectedOptionId: option.id,
        scheduledFor: now,
        editingOptionId: null,
      },
    });
    await this.text(
      from,
      `Option ${position} chuna gaya. ${postTime} nikal chuka hai, isliye abhi post kar rahe hain...`,
    );
    await this.publishBatch(batch.id);
  }

  async startEdit(batchId: string, position: number, from: string) {
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
      data: { editingOptionId: option.id },
    });
    await this.text(
      from,
      `Option ${position} me kya badalna hai? Likh kar bhejiye, jaise:\n` +
        '"background golden karo", "dulhan ki lehenga red karo", "flowers hatao".',
    );
  }

  async applyEdit(batchId: string, optionId: string, instruction: string, from: string) {
    // Clear the flag first so a retried webhook does not run the edit twice.
    const claimed = await this.prisma.storyBatch.updateMany({
      where: { id: batchId, editingOptionId: optionId },
      data: { editingOptionId: null },
    });
    if (claimed.count === 0) return;
    const option = await this.prisma.storyOption.findUnique({
      where: { id: optionId },
    });
    if (!option?.imageData) return;

    await this.text(from, 'Badlav kar rahe hain, ek minute...');
    try {
      const edited = await toStoryJpeg(
        await this.withRetry(() => this.gemini.editImage(Buffer.from(option.imageData!), 'image/jpeg', instruction)),
      );
      const updated = await this.prisma.storyOption.update({
        where: { id: option.id },
        data: {
          imageData: new Uint8Array(edited),
          finalImageData: null,
          revision: { increment: 1 },
        },
      });
      await this.sendOption(batchId, updated, from);
    } catch (e: any) {
      this.logger.warn(`Edit failed for option ${option.id}: ${e.message}`);
      await this.text(from, 'Yeh badlav nahi ho paya. Thoda alag shabdon me dobara "Edit" dabakar likhiye.');
    }
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
   */
  async publishOption(orgId: string, optionId: string) {
    const option = await this.prisma.storyOption.findUnique({
      where: { id: optionId },
      include: { batch: { select: { trendKeywords: true } } },
    });
    if (!option?.imageData) throw new Error('Post image is missing');
    const settings = await this.prisma.storySettings.findUnique({
      where: { orgId },
    });
    const destinations = destinationsOf(settings);

    const research = await this.keywords.research(option.seedKeyword, settings?.keywordDatabase || 'in');
    const keywords = unique([...research.keywords, ...(option.batch?.trendKeywords || [])]).slice(0, 5);
    const hashtags = research.hashtags;
    const draft = Buffer.from(option.imageData);

    let finalImage: Buffer | null = null;
    if (destinations.includes('IG_STORY')) {
      try {
        finalImage = await toStoryJpeg(await this.gemini.addTextToImage(draft, 'image/jpeg', option.title, hashtags));
      } catch (e: any) {
        this.logger.warn(`Gemini lettering failed, using overlay: ${e.message}`);
        finalImage = await overlayText(draft, option.title, hashtags);
      }
    }
    await this.prisma.storyOption.update({
      where: { id: option.id },
      data: {
        keywords,
        hashtags,
        ...(finalImage ? { finalImageData: new Uint8Array(finalImage) } : {}),
      },
    });

    const caption = [option.caption || option.title, hashtags.join(' ')].filter(Boolean).join('\n\n');
    const targets: Partial<Record<Destination, TargetResult>> = {};
    const attempt = async (d: Destination, run: () => Promise<string>) => {
      try {
        targets[d] = { ok: true, id: await run() };
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
        const token = this.crypto.decrypt(ig.accessTokenEncrypted);
        await attempt(d, () =>
          d === 'IG_STORY'
            ? this.metaPublisher.publishInstagramStory(ig.channelIdentifier, this.mediaUrl(option.id, 'final'), token)
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
        await attempt('FB_FEED', () =>
          this.metaPublisher.publishFacebookPhoto(
            fb.channelIdentifier,
            this.mediaUrl(option.id, 'feed'),
            caption,
            token,
          ),
        );
      }
    }
    return { targets, keywords, hashtags };
  }

  // ------------------------------------------------------------------ media

  mediaUrl(optionId: string, variant: MediaVariant): string {
    const base = (process.env.STORY_MEDIA_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:5002').replace(
      /\/$/,
      '',
    );
    return `${base}/api/stories/media/${optionId}/${variant}/${this.sign(optionId, variant)}.jpg`;
  }

  async getMedia(optionId: string, variant: string, signature: string): Promise<Buffer> {
    if (variant !== 'draft' && variant !== 'final' && variant !== 'feed') throw new NotFoundException();
    if (!timingSafeEqualString(signature.replace(/\.jpg$/, ''), this.sign(optionId, variant))) {
      throw new NotFoundException();
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
  private sender(): Sender | null {
    const phoneNumberId = process.env.STORY_WA_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.STORY_WA_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    return phoneNumberId && accessToken ? { phoneNumberId, accessToken } : null;
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

function replyId(msg: any): string | undefined {
  return msg?.button?.payload || msg?.interactive?.list_reply?.id || msg?.interactive?.button_reply?.id;
}

function statusMessage(status: string): string {
  if (status === 'PUBLISHING') return 'Aapki chuni hui post abhi publish ho rahi hai.';
  if (status === 'PUBLISHED') return 'Aaj ki post already lag chuki hai. Kal naye ideas aayenge.';
  if (status === 'GENERATING') return 'Aaj ke ideas abhi ban rahe hain, thodi der me bhejte hain.';
  return 'Ye ideas ab available nahi hain. Kal naye ideas aayenge.';
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
