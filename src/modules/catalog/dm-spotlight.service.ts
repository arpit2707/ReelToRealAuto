import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PostsService } from '../posts/posts.service';
import { PostAiGateService } from './post-ai-gate.service';

export const MAX_SPOTLIGHT = 5;
const MAX_LABEL = 60;

export type SpotlightStatus =
  | 'ACTIVE'
  | 'POST_AI_OFF'
  | 'SCHEDULED'
  | 'EXPIRED'
  | 'ITEM_INACTIVE'
  | 'POST_MISSING';

export type SpotlightInput = {
  postId: string;
  label?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
};

// What the AI gets for a plain DM (same shape as the AI service's SpotlightPost).
export type SpotlightForAi = {
  post_id: string;
  label: string | null;
  caption: string | null;
  permalink: string | null;
  offering_ids: string[];
};

type Row = {
  postId: string;
  position: number;
  label: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  missingAt: Date | null;
};

/** Pure rule: why a Spotlight post is (not) shown in plain DMs right now. */
export function spotlightStatus(
  row: Pick<Row, 'startsAt' | 'endsAt' | 'missingAt'>,
  input: { aiOn: boolean; inactiveItems: number },
  now = new Date(),
): SpotlightStatus {
  if (row.missingAt) return 'POST_MISSING';
  if (!input.aiOn) return 'POST_AI_OFF';
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  // Still shown, minus the inactive item; the dashboard warns.
  if (input.inactiveItems) return 'ITEM_INACTIVE';
  return 'ACTIVE';
}

const SHOWN: SpotlightStatus[] = ['ACTIVE', 'ITEM_INACTIVE'];

/**
 * The posts a seller highlights in plain DMs ("hi", "price list"), per page.
 * Only AI-on posts of the same page, at most 5, each with an optional label
 * and schedule. A post whose AI is switched off stops being shown at once and
 * comes back when it is on again.
 */
@Injectable()
export class DmSpotlightService {
  private readonly logger = new Logger(DmSpotlightService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: PostAiGateService,
    @Optional() private readonly posts?: PostsService,
  ) {}

  private async channel(orgId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, orgId, platform: { in: ['INSTAGRAM', 'FACEBOOK'] } },
      select: { id: true, platform: true },
    });
    if (!channel) throw new NotFoundException('Page not found');
    return channel;
  }

  private rows(orgId: string, channelId: string): Promise<Row[]> {
    return this.prisma.dmSpotlight.findMany({
      where: { orgId, channelId },
      orderBy: { position: 'asc' },
      select: {
        postId: true,
        position: true,
        label: true,
        startsAt: true,
        endsAt: true,
        missingAt: true,
      },
    });
  }

  /** Each post with its details, items and live status, in order. */
  private async describe(orgId: string, rows: Row[], now = new Date()) {
    const ids = rows.map((r) => r.postId);
    if (!ids.length) return [];
    const [socials, links, on] = await Promise.all([
      this.prisma.socialPost.findMany({
        where: { orgId, postId: { in: ids } },
        select: { postId: true, caption: true, mediaUrl: true, permalink: true, note: true },
      }),
      this.prisma.postOfferingLink.findMany({
        where: { orgId, postId: { in: ids }, status: 'SELLER_CONFIRMED' },
        select: {
          postId: true,
          offering: { select: { id: true, title: true, isActive: true } },
        },
      }),
      this.gate.onPosts(orgId, ids),
    ]);
    const social = new Map(socials.map((s) => [s.postId, s]));
    return rows.map((r) => {
      const sp = social.get(r.postId);
      const items = links
        .filter((l) => l.postId === r.postId && l.offering)
        .map((l) => l.offering as { id: string; title: string; isActive: boolean });
      const status = spotlightStatus(
        r,
        { aiOn: on.has(r.postId), inactiveItems: items.filter((i) => !i.isActive).length },
        now,
      );
      return {
        postId: r.postId,
        position: r.position,
        label: r.label,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        caption: sp?.caption || null,
        note: sp?.note || null,
        mediaUrl: sp?.mediaUrl || null,
        permalink: sp?.permalink || null,
        items: items.map((i) => ({ id: i.id, title: i.title, isActive: i.isActive })),
        status,
        shown: SHOWN.includes(status),
      };
    });
  }

  async list(orgId: string, channelId: string) {
    await this.channel(orgId, channelId);
    const posts = await this.describe(orgId, await this.rows(orgId, channelId));
    return {
      posts,
      max: MAX_SPOTLIGHT,
      // Edge case: nothing is shown, so plain DMs use only the page context.
      warning: posts.length && !posts.some((p) => p.shown) ? 'none_active' : null,
    };
  }

  /** Replaces the page's whole list (order = position). */
  async replace(orgId: string, channelId: string, input: SpotlightInput[]) {
    const channel = await this.channel(orgId, channelId);
    const list = Array.isArray(input) ? input : [];
    if (list.length > MAX_SPOTLIGHT)
      throw new BadRequestException(`At most ${MAX_SPOTLIGHT} posts can be in the Spotlight`);
    const ids = list.map((p) => String(p?.postId || '').trim());
    if (ids.some((id) => !id)) throw new BadRequestException('Every Spotlight entry needs a postId');
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('A post can be in the Spotlight only once');

    const socials = ids.length
      ? await this.prisma.socialPost.findMany({
          where: { orgId, postId: { in: ids } },
          select: { postId: true, channelId: true, platform: true },
        })
      : [];
    const social = new Map(socials.map((s) => [s.postId, s]));
    const on = await this.gate.onPosts(orgId, ids);
    const data = list.map((p, position) => {
      const postId = ids[position];
      const sp = social.get(postId);
      if (!sp) throw new BadRequestException(`Post ${postId} is not known yet`);
      const samePage = sp.channelId ? sp.channelId === channel.id : sp.platform === channel.platform;
      if (!samePage) throw new BadRequestException(`Post ${postId} belongs to another page`);
      if (!on.has(postId))
        throw new BadRequestException(`Switch the AI on for post ${postId} before adding it to the Spotlight`);
      const startsAt = toDate(p.startsAt, 'start');
      const endsAt = toDate(p.endsAt, 'end');
      if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime())
        throw new BadRequestException('The end date must be after the start date');
      return {
        orgId,
        channelId: channel.id,
        postId,
        position,
        label: p.label?.trim().slice(0, MAX_LABEL) || null,
        startsAt,
        endsAt,
      };
    });

    await this.prisma.$transaction([
      this.prisma.dmSpotlight.deleteMany({ where: { orgId, channelId: channel.id } }),
      ...(data.length ? [this.prisma.dmSpotlight.createMany({ data })] : []),
    ]);
    return this.list(orgId, channelId);
  }

  /** Shown posts for a plain DM on this page (AI-on, in schedule, max 5). */
  async forDm(orgId: string, channelId: string, now = new Date()): Promise<SpotlightForAi[]> {
    const rows = await this.rows(orgId, channelId);
    const posts = await this.describe(orgId, rows, now);
    return posts
      .filter((p) => p.shown)
      .slice(0, MAX_SPOTLIGHT)
      .map((p) => ({
        post_id: p.postId,
        label: p.label,
        caption: (p.caption || p.note || '').slice(0, 500) || null,
        permalink: p.permalink,
        offering_ids: p.items.filter((i) => i.isActive).map((i) => i.id),
      }));
  }

  /**
   * After a posts refresh: a Spotlight post missing from the listing is looked
   * up once; if Meta says it no longer exists it is marked missing (and
   * skipped), and a post that is back clears the mark.
   */
  async checkMissing(orgId: string, channelId: string, listedIds: string[]) {
    const rows = await this.rows(orgId, channelId);
    const listed = new Set(listedIds);
    let missing = 0;
    for (const r of rows) {
      let gone = false;
      if (!listed.has(r.postId)) {
        if (!this.posts) continue;
        try {
          await this.posts.getPost(orgId, channelId, r.postId);
        } catch (e: any) {
          // Only Meta's "does not exist" counts; a network error changes nothing.
          if (!/does not exist|cannot be loaded|unsupported get request/i.test(String(e?.message))) continue;
          gone = true;
        }
      }
      if (gone === Boolean(r.missingAt)) continue;
      await this.prisma.dmSpotlight.updateMany({
        where: { orgId, channelId, postId: r.postId },
        data: { missingAt: gone ? new Date() : null },
      });
      if (gone) missing += 1;
    }
    if (missing) this.logger.log(`${missing} Spotlight post(s) of ${channelId} no longer exist on Meta`);
    return missing;
  }
}

function toDate(v: string | null | undefined, which: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${which} date`);
  return d;
}
