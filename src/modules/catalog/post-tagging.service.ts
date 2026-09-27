import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PostsService, type ChannelPost } from '../posts/posts.service';
import { GeminiClient } from '../stories/gemini.client';
import { ReplyContextService } from './reply-context.service';
import { priceLabel } from './industries';

const MAX_CANDIDATES = 60;
const MAX_TAGS_PER_POST = 3;
const LINK_STATUSES = ['AI_SUGGESTED', 'SELLER_CONFIRMED', 'SELLER_REJECTED'];

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
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.runAll(), 24 * 60 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runAll() {
    const orgs = await this.prisma.businessProfile.findMany({
      where: { autoTagPosts: true },
      select: { orgId: true },
    });
    for (const { orgId } of orgs) {
      await this.run(orgId).catch((e) =>
        this.logger.error(`Auto-tagging failed for ${orgId}: ${e.message}`),
      );
    }
  }

  async run(orgId: string) {
    const [channels, offeringCount] = await Promise.all([
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
    ]);
    if (!channels.length)
      throw new BadRequestException(
        'Connect an Instagram account or Facebook Page first',
      );
    if (!offeringCount)
      throw new BadRequestException('Add items to your catalog first');

    const run = await this.prisma.postTagRun.create({ data: { orgId } });
    let seen = 0;
    let suggested = 0;
    const errors: string[] = [];
    for (const ch of channels) {
      let posts: ChannelPost[] = [];
      try {
        posts = (await this.posts.listPosts(orgId, ch.id)).posts;
      } catch (err: any) {
        errors.push(`${ch.platform}: ${err.message}`);
        continue;
      }
      for (const post of posts) {
        seen += 1;
        try {
          suggested += await this.tagPost(orgId, ch.platform, post);
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
    platform: string,
    post: ChannelPost,
  ): Promise<number> {
    const existing = await this.prisma.postOfferingLink.findMany({
      where: { orgId, postId: post.id },
    });
    if (existing.length) {
      // Already tagged (or reviewed): only refresh what changes on Meta's side.
      await this.prisma.postOfferingLink.updateMany({
        where: { orgId, postId: post.id },
        data: {
          likes: post.likes,
          commentsCount: post.commentsCount,
          caption: post.text,
          mediaUrl: post.mediaUrl,
        },
      });
      return 0;
    }

    const suggestions = await this.suggest(orgId, post);
    for (const s of suggestions) {
      await this.prisma.postOfferingLink.create({
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
    }
    return suggestions.length;
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

  async listLinks(orgId: string, status?: string) {
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
    const posts = new Map<string, any>();
    for (const l of links) {
      const p = posts.get(l.postId) || {
        postId: l.postId,
        platform: l.platform,
        caption: l.caption,
        mediaUrl: l.mediaUrl,
        permalink: l.permalink,
        likes: l.likes,
        commentsCount: l.commentsCount,
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
    const lastRun = await this.prisma.postTagRun.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });
    return { posts: [...posts.values()], lastRun };
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
    return this.prisma.postOfferingLink.update({
      where: { id: linkId },
      data: { status },
    });
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
    return this.prisma.postOfferingLink.upsert({
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
