import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { reel2realSender } from '../../common/wa-sender';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { PostsService, type ChannelPost } from '../posts/posts.service';
import { GeminiClient } from '../stories/gemini.client';
import { ReplyContextService } from './reply-context.service';
import { priceLabel } from './industries';
import { MIN_POST_CONTEXT, PostAiGateService } from './post-ai-gate.service';
import { DmSpotlightService } from './dm-spotlight.service';

const MAX_CANDIDATES = 60;
const MAX_TAGS_PER_POST = 3;
const LINK_STATUSES = ['AI_SUGGESTED', 'SELLER_CONFIRMED', 'SELLER_REJECTED'];
const DAY_MS = 24 * 60 * 60 * 1000;
// How often the scheduler checks which orgs are due; each org still runs once a day.
const TICK_MS = 60 * 60 * 1000;
const MAX_NOTE = 500;
// Auto-match sends only this many of the newest posts to the AI per run.
const AI_MATCH_NEWEST = 12;
const MAX_PAGE_SIZE = 50;
// WhatsApp "is this the item?" buttons on a fresh post's best AI tag.
const TAG_YES_PREFIX = 'TAG_YES_';
const TAG_NO_PREFIX = 'TAG_NO_';
// Only posts this new are worth a question; older ones wait for the dashboard.
const FRESH_POST_MS = 3 * DAY_MS;
// A seller who posts a lot should not get a stream of questions.
const MAX_ASKS_PER_DAY = 3;

type Suggestion = { offeringId: string; confidence: number; reason: string };

/**
 * Works out which catalog items each Instagram or Facebook post shows, so a
 * comment on a post gets that item's price. The AI only suggests; replies use
 * a suggestion straight away only when it is confident, and the seller can
 * confirm or reject every tag in the dashboard.
 */
@Injectable()
export class PostTaggingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostTaggingService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly gemini: GeminiClient,
    private readonly context: ReplyContextService,
    private readonly metaPublisher: MetaPublisherService,
    @Optional() private readonly gate?: PostAiGateService,
    @Optional() private readonly spotlight?: DmSpotlightService,
  ) {}

  /** Re-checks the post's AI switch after its context changed; never fails the caller. */
  private async contextChanged(orgId: string, postId: string, by = 'SELLER') {
    if (!this.gate) return null;
    return this.gate.onContextChanged(orgId, postId, by).catch((e) => {
      this.logger.warn(`Post AI check for ${postId} failed: ${e.message}`);
      return null;
    });
  }

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    // Hourly check against the last saved run, so a restart does not push the
    // daily run back by a day (a 24h timer restarts from zero on every deploy).
    // The same tick picks up new Instagram posts, which have no webhook.
    this.timer = setInterval(() => {
      void this.runDue();
      void this.scanNewPosts().catch((e) => this.logger.error(`New post scan failed: ${e.message}`));
    }, TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs tagging for every auto-tagging org whose last run is a day old. */
  async runDue(now = new Date()) {
    const orgs = await this.prisma.businessProfile.findMany({
      where: { autoTagPosts: true },
      select: { orgId: true },
    });
    let ran = 0;
    for (const { orgId } of orgs) {
      const last = await this.prisma.postTagRun.findFirst({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (last && now.getTime() - last.createdAt.getTime() < DAY_MS) continue;
      ran += 1;
      await this.run(orgId).catch((e) =>
        this.logger.error(`Auto-tagging failed for ${orgId}: ${e.message}`),
      );
    }
    return ran;
  }

  /**
   * Makes sure a post that was just commented on is known: its caption is
   * stored for the reply, and (when auto-tagging is on) it is matched to the
   * catalog now instead of at the next daily run. Safe to call on every comment.
   */
  async ensurePostContext(orgId: string, channelId: string, postId: string) {
    const known = await this.prisma.socialPost.findUnique({
      where: { orgId_postId: { orgId, postId } },
      select: { taggedAt: true },
    });
    if (known?.taggedAt) return;
    const [channel, profile, offeringCount] = await Promise.all([
      this.prisma.channel.findFirst({
        where: { id: channelId, orgId },
        select: { id: true, platform: true },
      }),
      this.prisma.businessProfile.findUnique({
        where: { orgId },
        select: { autoTagPosts: true },
      }),
      this.prisma.offering.count({ where: { orgId, isActive: true } }),
    ]);
    if (!channel) return;
    const autoTag = profile?.autoTagPosts !== false && offeringCount > 0;
    // Without tagging, the caption only needs fetching once.
    if (known && !autoTag) return;
    const post = await this.posts.getPost(orgId, channelId, postId);
    if (autoTag) {
      await this.tagPost(orgId, channel, post);
    } else {
      await this.rememberPost(orgId, channel, post, null);
    }
  }

  /**
   * Brings in every post of the connected pages (no AI), and when the seller
   * keeps auto-match on, also matches the newest ones to the catalog. With
   * auto-match off the seller tags posts and writes their context by hand.
   */
  async run(orgId: string) {
    const [channels, offeringCount, profile] = await Promise.all([
      this.prisma.channel.findMany({
        where: {
          orgId,
          isActive: true,
          platform: { in: ['INSTAGRAM', 'FACEBOOK'] },
          status: { not: 'DISCONNECTED' },
        },
        select: { id: true, platform: true },
      }),
      this.prisma.offering.count({ where: { orgId, isActive: true } }),
      this.prisma.businessProfile.findUnique({
        where: { orgId },
        select: { autoTagPosts: true },
      }),
    ]);
    if (!channels.length)
      throw new BadRequestException(
        'Connect an Instagram account or Facebook Page first',
      );
    const autoTag = profile?.autoTagPosts !== false && offeringCount > 0;

    const run = await this.prisma.postTagRun.create({ data: { orgId } });
    let seen = 0;
    let suggested = 0;
    const errors: string[] = [];
    for (const ch of channels) {
      let posts: ChannelPost[] = [];
      try {
        posts = await this.posts.allPosts(orgId, ch.id);
      } catch (err: any) {
        errors.push(`${ch.platform}: ${err.message}`);
        continue;
      }
      // Spotlight posts deleted on Meta are skipped from now on.
      if (this.spotlight)
        await this.spotlight
          .checkMissing(orgId, ch.id, posts.map((p) => p.id))
          .catch((e) => this.logger.warn(`Spotlight check for ${ch.id} failed: ${e.message}`));
      for (const [i, post] of posts.entries()) {
        seen += 1;
        try {
          // The AI only looks at the newest posts; older ones are just listed.
          if (autoTag && i < AI_MATCH_NEWEST)
            suggested += await this.tagPost(orgId, ch, post);
          else await this.rememberPost(orgId, ch, post, null);
        } catch (err: any) {
          this.logger.warn(`Tagging post ${post.id} failed: ${err.message}`);
        }
      }
    }
    return this.prisma.postTagRun.update({
      where: { id: run.id },
      data: {
        status: errors.length && !seen ? 'FAILED' : 'DONE',
        postsSeen: seen,
        suggested,
        error: errors.length ? errors.join('; ').slice(0, 500) : null,
        finishedAt: new Date(),
      },
    });
  }

  /** Returns how many new suggestions were stored for this post. */
  private async tagPost(
    orgId: string,
    channel: { id: string; platform: string },
    post: ChannelPost,
  ): Promise<number> {
    const platform = channel.platform;
    const [known, existing] = await Promise.all([
      this.prisma.socialPost.findUnique({
        where: { orgId_postId: { orgId, postId: post.id } },
        select: { taggedAt: true },
      }),
      this.prisma.postOfferingLink.count({ where: { orgId, postId: post.id } }),
    ]);
    if (known?.taggedAt || existing) {
      // Already tagged (or reviewed, or matched nothing): only refresh what
      // changes on Meta's side. A post that matched nothing is not sent to the
      // AI again every day.
      await this.prisma.postOfferingLink.updateMany({
        where: { orgId, postId: post.id },
        data: {
          likes: post.likes,
          commentsCount: post.commentsCount,
          caption: post.text,
          mediaUrl: post.mediaUrl,
        },
      });
      await this.rememberPost(orgId, channel, post, known?.taggedAt || new Date());
      return 0;
    }

    // Listed first, so the seller sees the post even if the AI call fails.
    await this.rememberPost(orgId, channel, post, null);
    const suggestions = await this.suggest(orgId, post);
    const created: Array<{ id: string; offeringId: string; confidence: number }> = [];
    for (const s of suggestions) {
      const link = await this.prisma.postOfferingLink.create({
        data: {
          orgId,
          postId: post.id,
          platform,
          caption: post.text?.slice(0, 1000) || null,
          mediaUrl: post.mediaUrl,
          permalink: post.permalink,
          offeringId: s.offeringId,
          status: 'AI_SUGGESTED',
          confidence: s.confidence,
          reason: s.reason.slice(0, 300),
          likes: post.likes,
          commentsCount: post.commentsCount,
        },
      });
      created.push({ id: link.id, offeringId: s.offeringId, confidence: s.confidence });
    }
    await this.rememberPost(orgId, channel, post, new Date());
    const best = created.sort((a, b) => b.confidence - a.confidence)[0];
    if (best && isFresh(post)) {
      await this.askSeller(orgId, post, best).catch((e) =>
        this.logger.warn(`Asking the seller about post ${post.id} failed: ${e.message}`),
      );
    }
    return suggestions.length;
  }

  // ------------------------------------------------ zero-click confirmation

  /**
   * Instagram sends no webhook for a new post, so each hour this looks at the
   * newest posts of orgs that can be asked on WhatsApp and tags the ones it has
   * not seen. Only fresh posts: the daily run covers the back catalogue.
   */
  async scanNewPosts(now = new Date()) {
    const orgs = await this.prisma.businessProfile.findMany({
      where: { autoTagPosts: true },
      select: { orgId: true },
    });
    let tagged = 0;
    for (const { orgId } of orgs) {
      if (!(await this.sellerNumber(orgId))) continue;
      if (!(await this.prisma.offering.count({ where: { orgId, isActive: true } }))) continue;
      const channels = await this.prisma.channel.findMany({
        where: { orgId, isActive: true, platform: 'INSTAGRAM', status: { not: 'DISCONNECTED' } },
        select: { id: true, platform: true },
      });
      for (const ch of channels) {
        try {
          const { posts } = await this.posts.listPosts(orgId, ch.id);
          const fresh = posts.filter((p) => isFresh(p, now));
          if (!fresh.length) continue;
          const known = new Set(
            (
              await this.prisma.socialPost.findMany({
                where: { orgId, postId: { in: fresh.map((p) => p.id) } },
                select: { postId: true },
              })
            ).map((k) => k.postId),
          );
          for (const post of fresh.filter((p) => !known.has(p.id))) {
            tagged += await this.tagPost(orgId, ch, post);
          }
        } catch (e: any) {
          this.logger.warn(`New post scan for ${orgId}/${ch.id} failed: ${e.message}`);
        }
      }
    }
    return tagged;
  }

  /**
   * "Aapne nayi post daali hai! Kya isme Kashmiri Silk Saree (₹2,499) hai?"
   * [Haan, yahi hai] [Nahi]. One question per post, a few per day at most.
   */
  private async askSeller(
    orgId: string,
    post: ChannelPost,
    best: { id: string; offeringId: string },
  ) {
    const sender = reel2realSender();
    const to = await this.sellerNumber(orgId);
    if (!sender || !to) return;
    const since = new Date(Date.now() - DAY_MS);
    const askedToday = await this.prisma.postOfferingLink.count({
      where: { orgId, askedAt: { gt: since } },
    });
    if (askedToday >= MAX_ASKS_PER_DAY) return;
    const alreadyAsked = await this.prisma.postOfferingLink.count({
      where: { orgId, postId: post.id, askedAt: { not: null } },
    });
    if (alreadyAsked) return;
    const offering = await this.prisma.offering.findFirst({
      where: { id: best.offeringId, orgId },
      select: { title: true, priceMode: true, priceMin: true, priceMax: true, currency: true },
    });
    if (!offering) return;

    // Claim first so two overlapping runs never ask twice.
    const claimed = await this.prisma.postOfferingLink.updateMany({
      where: { id: best.id, askedAt: null },
      data: { askedAt: new Date() },
    });
    if (!claimed.count) return;

    const item = `${offering.title} (${priceLabel(offering)})`;
    const snippet = post.text ? `: "${post.text.replace(/\s+/g, ' ').slice(0, 80)}${post.text.length > 80 ? '…' : ''}"` : '';
    const body =
      `Aapne nayi post daali hai${snippet}\n\n` +
      `Kya isme *${item}* hai? "Haan" dabate hi is post ke comments me isi ka price aur details bataye jayenge.`;
    const buttons = [
      { id: `${TAG_YES_PREFIX}${best.id}`, title: 'Haan, yahi hai' },
      { id: `${TAG_NO_PREFIX}${best.id}`, title: 'Nahi' },
    ];
    const isPhoto = post.mediaUrl && post.mediaType !== 'VIDEO';
    let sent = isPhoto
      ? await this.metaPublisher.sendWhatsAppImageButtons(sender.phoneNumberId, to, post.mediaUrl!, body, buttons, sender.accessToken)
      : await this.metaPublisher.sendInteractiveButtonMessage(
          sender.phoneNumberId,
          to,
          'Nayi post',
          body,
          'Reel2Real',
          buttons,
          sender.accessToken,
        );
    // Buttons only work inside WhatsApp's 24h window; outside it, an approved
    // template with the same two quick replies can carry the question.
    const template = process.env.POST_TAG_WA_TEMPLATE;
    if (!sent && template) {
      sent = await this.metaPublisher.sendWhatsAppTemplate(
        sender.phoneNumberId,
        to,
        template,
        process.env.STORY_WA_TEMPLATE_LANG || 'en',
        [
          { type: 'body', parameters: [{ type: 'text', text: item }] },
          ...buttons.map((b, index) => ({
            type: 'button',
            sub_type: 'quick_reply',
            index: String(index),
            parameters: [{ type: 'payload', payload: b.id }],
          })),
        ],
        sender.accessToken,
      );
    }
    if (!sent) {
      // Not asked after all; the tag stays in the dashboard for review.
      await this.prisma.postOfferingLink.updateMany({ where: { id: best.id }, data: { askedAt: null } });
    }
  }

  /** The seller's WhatsApp: the daily-posts number, else the lead alert number. */
  private async sellerNumber(orgId: string): Promise<string | null> {
    const [settings, profile] = await Promise.all([
      this.prisma.storySettings.findUnique({ where: { orgId }, select: { whatsappNumber: true } }),
      this.prisma.businessProfile.findUnique({ where: { orgId }, select: { alertPhone: true } }),
    ]);
    return settings?.whatsappNumber || profile?.alertPhone?.replace(/\D/g, '') || null;
  }

  /** True for the Haan / Nahi buttons of a tag question. */
  isTagAnswer(msg: any): boolean {
    const id = replyId(msg);
    return Boolean(id && (id.startsWith(TAG_YES_PREFIX) || id.startsWith(TAG_NO_PREFIX)));
  }

  /** "Haan" confirms the tag for the comment replies; "Nahi" rejects it. */
  async handleTagAnswer(msg: any) {
    const id = replyId(msg) || '';
    const yes = id.startsWith(TAG_YES_PREFIX);
    const linkId = id.slice((yes ? TAG_YES_PREFIX : TAG_NO_PREFIX).length);
    const from = String(msg?.from || '');
    const link = await this.prisma.postOfferingLink.findUnique({
      where: { id: linkId },
      include: { offering: { select: { title: true } } },
    });
    // Only the number we asked may answer for the org.
    if (!link || (await this.sellerNumber(link.orgId)) !== from) return;
    await this.setStatus(link.orgId, link.id, yes ? 'SELLER_CONFIRMED' : 'SELLER_REJECTED');
    if (yes) {
      await this.prisma.postOfferingLink.update({ where: { id: link.id }, data: { confidence: 1 } });
    }
    const sender = reel2realSender();
    if (!sender) return;
    await this.metaPublisher.sendWhatsAppMessage(
      sender.phoneNumberId,
      from,
      yes
        ? `Ho gaya! Is post ke comments me ab "${link.offering?.title}" ka price aur details bataye jayenge.`
        : 'Theek hai, yeh tag hata diya. Sahi item dashboard ke "Post tags" me chun sakte hain.',
      sender.accessToken,
    );
  }

  /** Stores the caption and media for the reply context; keeps the seller's note. */
  private rememberPost(
    orgId: string,
    channel: { id: string; platform: string },
    post: ChannelPost,
    taggedAt: Date | null,
  ) {
    const fields = {
      channelId: channel.id,
      platform: channel.platform,
      caption: post.text?.slice(0, 2000) || null,
      mediaUrl: post.mediaUrl,
      permalink: post.permalink,
      // A lookup that has no counts (a Facebook single post) keeps the last ones.
      postedAt: validDate(post.createdAt) ?? undefined,
      likes: post.likes ?? undefined,
      commentsCount: post.commentsCount ?? undefined,
    };
    return this.prisma.socialPost.upsert({
      where: { orgId_postId: { orgId, postId: post.id } },
      create: { orgId, postId: post.id, ...fields, taggedAt },
      update: { ...fields, ...(taggedAt ? { taggedAt } : {}) },
    });
  }

  private async suggest(
    orgId: string,
    post: ChannelPost,
  ): Promise<Suggestion[]> {
    // Narrow big catalogs to what the caption mentions, then fill with the
    // newest items so a caption-less photo can still be matched by the image.
    const byCaption = post.text
      ? await this.context.search(orgId, post.text, MAX_CANDIDATES)
      : [];
    const recent = await this.prisma.offering.findMany({
      where: { orgId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_CANDIDATES,
      select: { id: true },
    });
    const ids = [
      ...new Set([...byCaption.map((b) => b.id), ...recent.map((r) => r.id)]),
    ].slice(0, MAX_CANDIDATES);
    const candidates = await this.prisma.offering.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        type: true,
        description: true,
        priceMode: true,
        priceMin: true,
        priceMax: true,
        currency: true,
      },
    });
    if (!candidates.length) return [];

    if (!this.gemini.isConfigured()) {
      // Without Gemini, only a clear caption match counts, and never above the
      // confidence that replies use automatically.
      return byCaption.slice(0, 1).map((b) => ({
        offeringId: b.id,
        confidence: 0.55,
        reason: 'Caption mentions this item',
      }));
    }

    const image = await fetchImage(post.mediaUrl);
    const list = candidates
      .map(
        (c) =>
          `- ${c.id} | ${c.type} | ${c.title} | ${priceLabel(c)}${c.description ? ` | ${c.description.slice(0, 120)}` : ''}`,
      )
      .join('\n');
    const prompt = [
      'You match an Indian small business social media post to the catalog items it shows or promotes.',
      `Post caption: ${post.text ? post.text.slice(0, 1200) : '(no caption)'}`,
      image ? 'The post image is attached.' : 'No image is available.',
      'Catalog (id | type | title | price | description):',
      list,
      `Return up to ${MAX_TAGS_PER_POST} matches. A bridal look can match several services or one package.`,
      'Confidence: 0.9+ only when the caption names the item or the image clearly shows it; 0.6-0.8 for a likely match; omit weak guesses.',
      'Return an empty list when the post is not about any listed item (memes, greetings, announcements).',
    ].join('\n');
    const result = await this.gemini.generateJson<{
      matches: Array<{ id: string; confidence: number; reason: string }>;
    }>(
      prompt,
      {
        type: 'OBJECT',
        properties: {
          matches: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                id: { type: 'STRING' },
                confidence: { type: 'NUMBER' },
                reason: { type: 'STRING' },
              },
              required: ['id', 'confidence', 'reason'],
            },
          },
        },
        required: ['matches'],
      },
      image || undefined,
    );
    const valid = new Set(candidates.map((c) => c.id));
    return (result.matches || [])
      .filter((m) => valid.has(m.id) && m.confidence >= 0.4)
      .slice(0, MAX_TAGS_PER_POST)
      .map((m) => ({
        offeringId: m.id,
        confidence: Math.min(1, Math.max(0, m.confidence)),
        reason: m.reason || '',
      }));
  }

  // ------------------------------------------------------------ review API

  /**
   * Every known post with its tags and AI state, newest first. `ai` narrows it
   * (review | on | off | untagged | needs_context); with `page` the result is
   * one page of `limit` posts (default 10) plus the total.
   */
  async listLinks(
    orgId: string,
    status?: string,
    ai?: string,
    paging?: { page?: number; limit?: number },
  ) {
    const links = await this.prisma.postOfferingLink.findMany({
      where: { orgId, ...(status ? { status } : {}) },
      include: {
        offering: {
          select: { id: true, title: true, type: true, isActive: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
    });
    // Posts that matched nothing (and our own daily posts) still show up, so
    // the seller can add the right item or a note to them.
    const socials = await this.prisma.socialPost.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const social = new Map(socials.map((s) => [s.postId, s]));
    const posts = new Map<string, any>();
    const blank = (s: (typeof socials)[number]) => ({
      postId: s.postId,
      platform: s.platform,
      channelId: s.channelId,
      caption: s.caption,
      mediaUrl: s.mediaUrl,
      permalink: s.permalink,
      likes: s.likes ?? null,
      commentsCount: s.commentsCount ?? null,
      note: s.note,
      source: s.source,
      tags: [],
    });
    for (const l of links) {
      const s = social.get(l.postId);
      const p = posts.get(l.postId) || {
        postId: l.postId,
        platform: l.platform,
        channelId: s?.channelId ?? null,
        caption: l.caption ?? s?.caption ?? null,
        mediaUrl: l.mediaUrl ?? s?.mediaUrl ?? null,
        permalink: l.permalink ?? s?.permalink ?? null,
        likes: l.likes ?? s?.likes ?? null,
        commentsCount: l.commentsCount ?? s?.commentsCount ?? null,
        note: s?.note ?? null,
        source: s?.source ?? 'META',
        tags: [],
      };
      p.tags.push({
        id: l.id,
        offering: l.offering,
        status: l.status,
        confidence: l.confidence,
        reason: l.reason,
      });
      posts.set(l.postId, p);
    }
    if (!status) {
      for (const s of socials) if (!posts.has(s.postId)) posts.set(s.postId, blank(s));
    }
    const ids = [...posts.keys()];
    const [spotlit, answered, onSet] = await Promise.all([
      this.prisma.dmSpotlight.findMany({
        where: { orgId, postId: { in: ids } },
        select: { postId: true },
      }),
      this.prisma.commentReplyJob.findMany({
        where: { orgId, status: 'SENT', thread: { postId: { in: ids } } },
        select: { thread: { select: { postId: true } } },
      }),
      this.gate ? this.gate.onPosts(orgId, ids) : Promise.resolve(new Set<string>()),
    ]);
    const inSpotlight = new Set(spotlit.map((x) => x.postId));
    const answeredCount = new Map<string, number>();
    for (const j of answered)
      answeredCount.set(j.thread.postId, (answeredCount.get(j.thread.postId) || 0) + 1);
    let list = [...posts.values()].map((p) => {
      const sp = social.get(p.postId);
      const confirmed = p.tags.some(
        (t: any) => t.status === 'SELLER_CONFIRMED' && t.offering?.isActive !== false,
      );
      const noted = (p.note?.trim().length || 0) >= MIN_POST_CONTEXT;
      const hasContext = p.source === 'DAILY_POST' ? noted : noted || confirmed;
      return {
        ...p,
        aiEnabled: Boolean(sp?.aiEnabled),
        aiOn: onSet.has(p.postId),
        hasContext,
        // Daily posts wait for the seller's context before the AI can be on.
        needsContext: !hasContext && (p.source === 'DAILY_POST' || !p.tags.length),
        inSpotlight: inSpotlight.has(p.postId),
        answeredCount: answeredCount.get(p.postId) || 0,
      };
    });
    // Newest post first; a post we never saw on Meta goes by when we stored it.
    const when = (postId: string) => {
      const sp = social.get(postId);
      return (sp?.postedAt || sp?.createdAt)?.getTime() ?? 0;
    };
    list.sort((a, b) => when(b.postId) - when(a.postId));
    if (ai === 'review')
      list = list.filter((p) => p.tags.some((t: any) => t.status === 'AI_SUGGESTED'));
    else if (ai === 'on') list = list.filter((p) => p.aiOn);
    else if (ai === 'off') list = list.filter((p) => !p.aiOn);
    else if (ai === 'untagged') list = list.filter((p) => !p.tags.length);
    else if (ai === 'needs_context') list = list.filter((p) => p.needsContext);
    const [lastRun, profile] = await Promise.all([
      this.prisma.postTagRun.findFirst({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.businessProfile.findUnique({
        where: { orgId },
        select: { autoTagPosts: true },
      }),
    ]);
    const autoTagPosts = profile?.autoTagPosts !== false;
    const total = list.length;
    if (paging?.page) {
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(paging.limit || 10)));
      const page = Math.max(1, Math.floor(paging.page));
      list = list.slice((page - 1) * limit, page * limit);
      return { posts: list, lastRun, autoTagPosts, total, page, limit };
    }
    return { posts: list, lastRun, autoTagPosts, total };
  }

  /**
   * The seller's own context for one post ("offer valid till Sunday", "only
   * size 7 left"). The AI reads it with the caption; prices still come only
   * from the catalog.
   */
  async setNote(
    orgId: string,
    postId: string,
    input: {
      note?: string | null;
      platform?: string;
      caption?: string | null;
      mediaUrl?: string | null;
      permalink?: string | null;
    },
  ) {
    if (!postId) throw new BadRequestException('postId is required');
    const note = input.note?.trim().slice(0, MAX_NOTE) || null;
    const saved = await this.prisma.socialPost.upsert({
      where: { orgId_postId: { orgId, postId } },
      update: { note },
      create: {
        orgId,
        postId,
        platform: input.platform || 'INSTAGRAM',
        caption: input.caption?.slice(0, 2000) || null,
        mediaUrl: input.mediaUrl || null,
        permalink: input.permalink || null,
        note,
      },
    });
    const ai = await this.contextChanged(orgId, postId);
    return { ...saved, ...(ai ? { aiEnabled: ai.aiEnabled, aiOn: ai.on, hasContext: ai.hasContext } : {}) };
  }

  async setStatus(orgId: string, linkId: string, status: string) {
    if (!LINK_STATUSES.includes(status))
      throw new BadRequestException(
        `Status must be one of ${LINK_STATUSES.join(', ')}`,
      );
    const link = await this.prisma.postOfferingLink.findFirst({
      where: { id: linkId, orgId },
    });
    if (!link) throw new NotFoundException('Tag not found');
    const updated = await this.prisma.postOfferingLink.update({
      where: { id: linkId },
      data: { status },
    });
    // A confirmed item turns a never-switched post on; the last item rejected
    // (with no note) turns it off. The post needs a record for its switch.
    if (this.gate && status === 'SELLER_CONFIRMED') await this.ensureSocialPost(orgId, link);
    await this.contextChanged(orgId, link.postId);
    return updated;
  }

  private async ensureSocialPost(
    orgId: string,
    post: {
      postId: string;
      platform: string;
      caption?: string | null;
      mediaUrl?: string | null;
      permalink?: string | null;
    },
  ) {
    await this.prisma.socialPost
      .upsert({
        where: { orgId_postId: { orgId, postId: post.postId } },
        update: {},
        create: {
          orgId,
          postId: post.postId,
          platform: post.platform || 'INSTAGRAM',
          caption: post.caption?.slice(0, 2000) || null,
          mediaUrl: post.mediaUrl || null,
          permalink: post.permalink || null,
        },
      })
      .catch(() => undefined);
  }

  async addLink(
    orgId: string,
    input: {
      postId: string;
      platform: string;
      offeringId: string;
      caption?: string;
      mediaUrl?: string;
      permalink?: string;
    },
  ) {
    const offering = await this.prisma.offering.findFirst({
      where: { id: input.offeringId, orgId },
    });
    if (!offering) throw new NotFoundException('Offering not found');
    if (!input.postId) throw new BadRequestException('postId is required');
    const link = await this.prisma.postOfferingLink.upsert({
      where: {
        postId_offeringId: {
          postId: input.postId,
          offeringId: input.offeringId,
        },
      },
      update: { status: 'SELLER_CONFIRMED', confidence: 1 },
      create: {
        orgId,
        postId: input.postId,
        platform: input.platform || 'INSTAGRAM',
        offeringId: input.offeringId,
        caption: input.caption?.slice(0, 1000) || null,
        mediaUrl: input.mediaUrl || null,
        permalink: input.permalink || null,
        status: 'SELLER_CONFIRMED',
        confidence: 1,
        reason: 'Added by seller',
      },
    });
    if (this.gate) await this.ensureSocialPost(orgId, input);
    await this.contextChanged(orgId, input.postId);
    return link;
  }

  /**
   * The best-performing post for each item, as a starting point for ads.
   * Engagement weighs a comment as three likes, since comments are the buying
   * questions this product answers.
   */
  async adPicks(orgId: string, limit = 10) {
    const links = await this.prisma.postOfferingLink.findMany({
      where: {
        orgId,
        OR: [
          { status: 'SELLER_CONFIRMED' },
          { status: 'AI_SUGGESTED', confidence: { gte: 0.6 } },
        ],
        offering: { isActive: true },
      },
      include: {
        offering: {
          select: {
            id: true,
            title: true,
            priceMode: true,
            priceMin: true,
            priceMax: true,
            currency: true,
          },
        },
      },
    });
    const best = new Map<string, (typeof links)[number] & { score: number }>();
    for (const l of links) {
      const score = (l.likes || 0) + 3 * (l.commentsCount || 0);
      const cur = best.get(l.offeringId);
      if (!cur || score > cur.score) best.set(l.offeringId, { ...l, score });
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((l) => ({
        offering: {
          id: l.offering.id,
          title: l.offering.title,
          price: priceLabel(l.offering),
        },
        postId: l.postId,
        platform: l.platform,
        permalink: l.permalink,
        mediaUrl: l.mediaUrl,
        caption: l.caption,
        likes: l.likes,
        commentsCount: l.commentsCount,
        score: l.score,
      }));
  }
}

function validDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isFresh(post: { createdAt: string | null }, now = new Date()): boolean {
  if (!post.createdAt) return false;
  const at = new Date(post.createdAt).getTime();
  return !Number.isNaN(at) && now.getTime() - at < FRESH_POST_MS;
}

function replyId(msg: any): string | undefined {
  return msg?.button?.payload || msg?.interactive?.button_reply?.id;
}

async function fetchImage(
  url: string | null,
): Promise<{ data: Buffer; mimeType: string } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(
      ';',
    )[0];
    if (!mimeType.startsWith('image/')) return null;
    const data = Buffer.from(await res.arrayBuffer());
    return data.length > 7 * 1024 * 1024 ? null : { data, mimeType };
  } catch {
    return null;
  }
}
