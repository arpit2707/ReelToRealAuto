import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { timingSafeEqualString } from '../../common/hmac';
import { GeminiClient } from './gemini.client';
import { KeywordResearchService } from './keyword-research.service';
import { overlayText, toStoryJpeg } from './story-image';

export const OPTION_COUNT = 4;
const SHOW_PREFIX = 'STORY_SHOW_';
const PICK_PREFIX = 'STORY_PICK_';
// Statuses from which the merchant may still pick; FAILED lets them retry a failed publish.
const PICKABLE = ['NOTIFIED', 'AWAITING_PICK', 'FAILED'];
const PICK_WINDOW_MS = 36 * 60 * 60 * 1000;

type Sender = { phoneNumberId: string; accessToken: string };
export type MediaVariant = 'draft' | 'final';

/**
 * Daily story ideas: generate four options per merchant, deliver them on
 * WhatsApp from the Reel2Real number, and publish the one they pick to
 * Instagram with researched keywords lettered on it.
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
        businessDescription: null,
        keywordDatabase: 'in',
      }
    );
  }

  async updateSettings(
    orgId: string,
    input: {
      enabled?: boolean;
      whatsappNumber?: string | null;
      instagramChannelId?: string | null;
      businessDescription?: string | null;
      keywordDatabase?: string;
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
    if (input.instagramChannelId !== undefined) {
      if (input.instagramChannelId) {
        const channel = await this.prisma.channel.findFirst({
          where: { id: input.instagramChannelId, orgId, platform: 'INSTAGRAM' },
        });
        if (!channel) throw new BadRequestException('That Instagram account is not connected to this workspace');
      }
      data.instagramChannelId = input.instagramChannelId || null;
    }
    const merged = { ...(await this.getSettings(orgId)), ...data };
    if (merged.enabled && !merged.whatsappNumber) {
      throw new BadRequestException('Add a WhatsApp number before turning daily stories on');
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
            idea: true,
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

  /** Entry point for the daily cron. Runs every enabled org one at a time. */
  async runDaily(): Promise<{ started: boolean; orgs: number }> {
    if (this.dailyRunning) return { started: false, orgs: 0 };
    this.dailyRunning = true;
    try {
      const settings = await this.prisma.storySettings.findMany({
        where: { enabled: true, whatsappNumber: { not: null } },
        select: { orgId: true },
      });
      for (const { orgId } of settings) {
        try {
          await this.generateBatch(orgId);
        } catch (e: any) {
          this.logger.error(`Daily stories failed for org ${orgId}: ${e.message}`);
        }
      }
      return { started: true, orgs: settings.length };
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
    if (!settings?.whatsappNumber) throw new Error('No WhatsApp number set for daily stories');
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org) throw new NotFoundException('Organization not found');
    const igChannel = await this.instagramChannel(orgId, settings.instagramChannelId);
    if (!igChannel) throw new Error('No active Instagram account connected');

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
      const [products, recent] = await Promise.all([
        this.prisma.product.findMany({
          where: { orgId },
          orderBy: { updatedAt: 'desc' },
          take: 10,
          select: { title: true, price: true, currency: true },
        }),
        this.prisma.storyOption.findMany({
          where: { batch: { orgId, id: { not: batch.id } } },
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: { title: true },
        }),
      ]);

      const ideas = await this.gemini.generateIdeas(
        {
          brandName: org.name,
          instagramHandle: igChannel.handle,
          description: settings.businessDescription,
          persona: org.brandPersona,
          products,
          recentTitles: recent.map((r) => r.title),
          forDate,
        },
        OPTION_COUNT,
      );

      for (let i = 0; i < ideas.length; i++) {
        const idea = ideas[i];
        const image = await toStoryJpeg(await this.withRetry(() => this.gemini.generateImage(idea.imagePrompt)));
        await this.prisma.storyOption.create({
          data: {
            batchId: batch.id,
            position: i + 1,
            ...idea,
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

  // -------------------------------------------------------- WhatsApp replies

  /** True for inbound messages this service owns; checked before the generic inbox/AI path. */
  isStoryReply(msg: any, phoneNumberId: string): boolean {
    const id = replyId(msg);
    if (id && (id.startsWith(SHOW_PREFIX) || id.startsWith(PICK_PREFIX))) return true;
    const sender = this.sender();
    return Boolean(
      sender && phoneNumberId === sender.phoneNumberId && /^[1-4]$/.test(String(msg?.text?.body || '').trim()),
    );
  }

  async handleWhatsAppReply(msg: any): Promise<void> {
    const from = String(msg?.from || '');
    const id = replyId(msg);
    if (id?.startsWith(SHOW_PREFIX)) {
      return this.showOptions(id.slice(SHOW_PREFIX.length), from);
    }
    if (id?.startsWith(PICK_PREFIX)) {
      const rest = id.slice(PICK_PREFIX.length);
      const sep = rest.lastIndexOf('_');
      return this.pick(rest.slice(0, sep), Number(rest.slice(sep + 1)), from);
    }
    const position = Number(String(msg?.text?.body || '').trim());
    const batch = await this.prisma.storyBatch.findFirst({
      where: {
        waRecipient: from,
        status: { in: PICKABLE },
        createdAt: { gt: new Date(Date.now() - PICK_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (batch) return this.pick(batch.id, position, from);
  }

  async showOptions(batchId: string, from: string) {
    const sender = this.sender();
    if (!sender) return;
    const batch = await this.prisma.storyBatch.findUnique({
      where: { id: batchId },
      include: {
        options: {
          orderBy: { position: 'asc' },
          select: { id: true, position: true, title: true, idea: true },
        },
      },
    });
    if (!batch || batch.waRecipient !== from) return;
    if (!PICKABLE.includes(batch.status) || batch.options.length === 0) {
      await this.text(from, statusMessage(batch.status));
      return;
    }

    for (const o of batch.options) {
      await this.metaPublisher.sendWhatsAppImage(
        sender.phoneNumberId,
        from,
        this.mediaUrl(o.id, 'draft'),
        `${o.position}. ${o.title}\n${o.idea}`,
        sender.accessToken,
      );
    }
    await this.metaPublisher.sendWhatsAppList(
      sender.phoneNumberId,
      from,
      'Kaunsi story aaj Instagram pe lagani hai? Neeche se chuniye, ya bas 1 se 4 tak number bhej dijiye.',
      'Story chuniye',
      batch.options.map((o) => ({
        id: `${PICK_PREFIX}${batch.id}_${o.position}`,
        title: `${o.position}. ${o.title}`,
        description: o.idea,
      })),
      sender.accessToken,
    );
    if (batch.status === 'NOTIFIED') {
      await this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: { status: 'AWAITING_PICK' },
      });
    }
  }

  async pick(batchId: string, position: number, from: string) {
    const batch = await this.prisma.storyBatch.findUnique({
      where: { id: batchId },
      include: { options: { where: { position }, select: { id: true } } },
    });
    if (!batch || batch.waRecipient !== from) return;
    const option = batch.options[0];
    if (!option) {
      await this.text(from, `Option ${position} nahi mila. 1 se ${OPTION_COUNT} ke beech number bhejiye.`);
      return;
    }

    // Claim atomically so a double tap or a webhook retry publishes once.
    const claimed = await this.prisma.storyBatch.updateMany({
      where: { id: batch.id, status: { in: PICKABLE } },
      data: {
        status: 'PUBLISHING',
        selectedOptionId: option.id,
        error: undefined,
      },
    });
    if (claimed.count === 0) {
      await this.text(from, statusMessage(batch.status));
      return;
    }

    await this.text(
      from,
      `Option ${position} chuna gaya. Best keywords dhoondh kar story Instagram pe laga rahe hain...`,
    );
    try {
      const result = await this.publishOption(batch.orgId, option.id);
      await this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: { status: 'PUBLISHED', publishedMediaId: result.mediaId },
      });
      await this.text(
        from,
        `Story Instagram pe live hai.\nKeywords: ${result.keywords.join(', ')}\nHashtags: ${result.hashtags.join(' ')}`,
      );
    } catch (e: any) {
      this.logger.error(`Story publish failed for batch ${batch.id}: ${e.message}`);
      await this.prisma.storyBatch.update({
        where: { id: batch.id },
        data: {
          status: 'FAILED',
          error: { stage: 'publish', message: e.message },
        },
      });
      await this.text(
        from,
        `Story publish nahi ho payi: ${e.message}\nDobara try karne ke liye phir se number bhejiye.`,
      );
    }
  }

  /** Researches keywords, letters them on the chosen image, and posts it as a story. */
  async publishOption(orgId: string, optionId: string) {
    const option = await this.prisma.storyOption.findUnique({
      where: { id: optionId },
    });
    if (!option?.imageData) throw new Error('Story image is missing');
    const settings = await this.prisma.storySettings.findUnique({
      where: { orgId },
    });
    const channel = await this.instagramChannel(orgId, settings?.instagramChannelId);
    if (!channel) throw new Error('Instagram account is not connected any more');
    const token = this.crypto.decrypt(channel.accessTokenEncrypted);

    const research = await this.keywords.research(option.seedKeyword, settings?.keywordDatabase || 'in');
    const draft = Buffer.from(option.imageData);
    let finalImage: Buffer;
    try {
      finalImage = await toStoryJpeg(
        await this.gemini.addTextToImage(draft, 'image/jpeg', option.title, research.hashtags),
      );
    } catch (e: any) {
      this.logger.warn(`Gemini lettering failed, using overlay: ${e.message}`);
      finalImage = await overlayText(draft, option.title, research.hashtags);
    }
    await this.prisma.storyOption.update({
      where: { id: option.id },
      data: {
        keywords: research.keywords,
        hashtags: research.hashtags,
        finalImageData: new Uint8Array(finalImage),
      },
    });

    const mediaId = await this.metaPublisher.publishInstagramStory(
      channel.channelIdentifier,
      this.mediaUrl(option.id, 'final'),
      token,
    );
    return { mediaId, ...research };
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
    if (variant !== 'draft' && variant !== 'final') throw new NotFoundException();
    if (!timingSafeEqualString(signature.replace(/\.jpg$/, ''), this.sign(optionId, variant))) {
      throw new NotFoundException();
    }
    const option = await this.prisma.storyOption.findUnique({
      where: { id: optionId },
      select: { imageData: true, finalImageData: true },
    });
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
    return this.prisma.channel.findFirst({
      where: {
        orgId,
        platform: 'INSTAGRAM',
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
  if (status === 'PUBLISHING') return 'Aapki chuni hui story abhi publish ho rahi hai.';
  if (status === 'PUBLISHED') return 'Aaj ki story already Instagram pe lag chuki hai. Kal naye ideas aayenge.';
  if (status === 'GENERATING') return 'Aaj ke ideas abhi ban rahe hain, thodi der me bhejte hain.';
  return 'Ye ideas ab available nahi hain. Kal naye ideas aayenge.';
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
