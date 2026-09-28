import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// A note shorter than this is not enough for the AI to talk about a post.
export const MIN_POST_CONTEXT = 20;

export type PostAiStatus = {
  postId: string;
  aiEnabled: boolean;
  // A confirmed catalog item, or the seller's note of 20+ characters. Daily
  // posts (published by us) need the note.
  hasContext: boolean;
  // Switch on, context present: the AI answers comments and uses the post.
  on: boolean;
  source: string;
};

type SocialLike = {
  postId: string;
  aiEnabled: boolean;
  aiEnabledAt: Date | null;
  note: string | null;
  source: string;
};

/** Pure rule, shared with the daily-post flow (which cannot inject this service). */
export function postHasContext(
  social: { note: string | null; source: string } | null,
  confirmedItems: number,
): boolean {
  const noted = (social?.note?.trim().length || 0) >= MIN_POST_CONTEXT;
  if (social?.source === 'DAILY_POST') return noted;
  return noted || confirmedItems > 0;
}

/**
 * Decides whether the AI may talk about a post. Comments are answered only on
 * posts where it is on; a DM about a post that is off is answered like a plain
 * DM. Crisis messages are the exception and are handled before this.
 */
@Injectable()
export class PostAiGateService {
  private readonly logger = new Logger(PostAiGateService.name);

  constructor(private readonly prisma: PrismaService) {}

  private confirmedItems(orgId: string, postId: string) {
    return this.prisma.postOfferingLink.count({
      where: {
        orgId,
        postId,
        status: 'SELLER_CONFIRMED',
        offering: { isActive: true },
      },
    });
  }

  private social(orgId: string, postId: string) {
    return this.prisma.socialPost.findUnique({
      where: { orgId_postId: { orgId, postId } },
      select: {
        postId: true,
        aiEnabled: true,
        aiEnabledAt: true,
        note: true,
        source: true,
      },
    });
  }

  private toStatus(
    postId: string,
    social: SocialLike | null,
    items: number,
  ): PostAiStatus {
    const hasContext = postHasContext(social, items);
    const aiEnabled = Boolean(social?.aiEnabled);
    return {
      postId,
      aiEnabled,
      hasContext,
      on: aiEnabled && hasContext,
      source: social?.source || 'META',
    };
  }

  async status(orgId: string, postId: string): Promise<PostAiStatus> {
    const [social, items] = await Promise.all([
      this.social(orgId, postId),
      this.confirmedItems(orgId, postId),
    ]);
    return this.toStatus(postId, social, items);
  }

  async isPostAiOn(
    orgId: string,
    postId: string | null | undefined,
  ): Promise<boolean> {
    if (!postId) return false;
    return (await this.status(orgId, postId)).on;
  }

  /** Which of these posts have the AI on (one query each for posts and links). */
  async onPosts(orgId: string, postIds: string[]): Promise<Set<string>> {
    if (!postIds.length) return new Set();
    const [socials, links] = await Promise.all([
      this.prisma.socialPost.findMany({
        where: { orgId, postId: { in: postIds }, aiEnabled: true },
        select: {
          postId: true,
          aiEnabled: true,
          aiEnabledAt: true,
          note: true,
          source: true,
        },
      }),
      this.prisma.postOfferingLink.findMany({
        where: {
          orgId,
          postId: { in: postIds },
          status: 'SELLER_CONFIRMED',
          offering: { isActive: true },
        },
        select: { postId: true },
      }),
    ]);
    const confirmed = new Map<string, number>();
    for (const l of links)
      confirmed.set(l.postId, (confirmed.get(l.postId) || 0) + 1);
    return new Set(
      socials
        .filter((s) => postHasContext(s, confirmed.get(s.postId) || 0))
        .map((s) => s.postId),
    );
  }

  /** The seller's switch. Turning it on needs context first. */
  async setPostAi(orgId: string, postId: string, enabled: boolean, by: string) {
    let social = await this.social(orgId, postId);
    const items = await this.confirmedItems(orgId, postId);
    if (!social) {
      // A post known only from its tags (tagged before posts were stored).
      const link = await this.prisma.postOfferingLink.findFirst({
        where: { orgId, postId },
        select: {
          platform: true,
          caption: true,
          mediaUrl: true,
          permalink: true,
        },
      });
      if (!link) throw new NotFoundException('Post not found');
      social = await this.prisma.socialPost.create({
        data: {
          orgId,
          postId,
          platform: link.platform,
          caption: link.caption,
          mediaUrl: link.mediaUrl,
          permalink: link.permalink,
        },
        select: {
          postId: true,
          aiEnabled: true,
          aiEnabledAt: true,
          note: true,
          source: true,
        },
      });
    }
    if (enabled && !postHasContext(social, items)) {
      throw new BadRequestException(
        social.source === 'DAILY_POST'
          ? 'Pehle is post ka context likhein (kam se kam 20 akshar)'
          : 'Pehle item confirm karein ya context likhein',
      );
    }
    await this.prisma.socialPost.update({
      where: { orgId_postId: { orgId, postId } },
      data: { aiEnabled: enabled, aiEnabledAt: new Date(), aiEnabledBy: by },
    });
    return this.status(orgId, postId);
  }

  /**
   * Called after a tag is confirmed or rejected, an item is added, or the
   * note changes. A post the seller never switched gets the AI once it has
   * context (a daily post once its note arrives); a post that lost all its
   * context (every item rejected, no note) goes off.
   */
  async onContextChanged(orgId: string, postId: string, by = 'SYSTEM') {
    const [social, items] = await Promise.all([
      this.social(orgId, postId),
      this.confirmedItems(orgId, postId),
    ]);
    if (!social) return this.toStatus(postId, null, items);
    const hasContext = postHasContext(social, items);
    let aiEnabled = social.aiEnabled;
    if (hasContext && !social.aiEnabled && !social.aiEnabledAt)
      aiEnabled = true;
    if (!hasContext && social.aiEnabled) aiEnabled = false;
    if (aiEnabled !== social.aiEnabled) {
      await this.prisma.socialPost.update({
        where: { orgId_postId: { orgId, postId } },
        data: {
          aiEnabled,
          // Losing context is not the seller's choice: leave room to come back on.
          aiEnabledAt: aiEnabled ? new Date() : null,
          aiEnabledBy: by,
        },
      });
      this.logger.log(
        `AI ${aiEnabled ? 'on' : 'off'} for post ${postId} (org ${orgId}) after a context change`,
      );
    }
    return this.toStatus(postId, { ...social, aiEnabled }, items);
  }
}
