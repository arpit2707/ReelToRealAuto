import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaPublisherService } from '../meta-publisher/meta-publisher.service';
import { graphUrl } from '../../common/graph';

export type PostComment = {
  id: string;
  text: string;
  author: string | null;
  createdAt: string | null;
};

export type ChannelPost = {
  id: string;
  text: string;
  mediaUrl: string | null;
  mediaType: string | null;
  permalink: string | null;
  createdAt: string | null;
  likes: number | null;
  commentsCount: number | null;
  comments: PostComment[] | null;
  // Why comments are missing, when they are (e.g. a permission not granted yet).
  commentsNote?: string;
};

const POST_LIMIT = 12;
const COMMENT_LIMIT = 10;

// Posts are read live from the Graph API rather than stored: Meta is the source
// of truth for captions, media URLs and counts, and nothing here needs history.
@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metaPublisher: MetaPublisherService,
  ) {}

  private async channelFor(orgId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, orgId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.platform !== 'FACEBOOK' && channel.platform !== 'INSTAGRAM') {
      throw new BadRequestException(
        'Posts are available for Facebook Pages and Instagram accounts only',
      );
    }
    if (!channel.isActive || channel.status === 'DISCONNECTED') {
      throw new BadRequestException(
        `${channel.name} is disconnected. Reconnect it in Channels.`,
      );
    }
    const token = this.crypto.decrypt(channel.accessTokenEncrypted);
    if (!token || token === 'REVOKED')
      throw new BadRequestException('Reconnect this channel to load its posts');
    return { channel, token };
  }

  private async graphGet(
    path: string,
    params: Record<string, string>,
    token: string,
  ) {
    const url = new URL(graphUrl(path));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const message =
        json?.error?.error_user_msg ||
        json?.error?.message ||
        `Graph API error ${res.status}`;
      throw new Error(message);
    }
    return json;
  }

  async listPosts(
    orgId: string,
    channelId: string,
  ): Promise<{ channelId: string; platform: string; posts: ChannelPost[] }> {
    const { channel, token } = await this.channelFor(orgId, channelId);
    try {
      const posts =
        channel.platform === 'FACEBOOK'
          ? await this.facebookPosts(channel.channelIdentifier, token)
          : await this.instagramPosts(channel.channelIdentifier, token);
      return { channelId: channel.id, platform: channel.platform, posts };
    } catch (err: any) {
      this.logger.warn(
        `Could not load posts for ${channel.platform} ${channel.channelIdentifier}: ${err.message}`,
      );
      throw new BadGatewayException(
        `Meta did not return posts: ${err.message}`,
      );
    }
  }

  private async facebookPosts(
    pageId: string,
    token: string,
  ): Promise<ChannelPost[]> {
    const base =
      'id,message,story,created_time,full_picture,permalink_url,reactions.summary(true).limit(0)';
    const comments = `comments.limit(${COMMENT_LIMIT}).summary(true).order(reverse_chronological)`;
    let json: any;
    let commentsNote: string | undefined;
    try {
      json = await this.graphGet(
        `/${pageId}/posts`,
        {
          fields: `${base},${comments}{id,message,from,created_time}`,
          limit: String(POST_LIMIT),
        },
        token,
      );
    } catch {
      // Commenter names need pages_read_user_content; fall back to the text alone.
      json = await this.graphGet(
        `/${pageId}/posts`,
        {
          fields: `${base},${comments}{id,message,created_time}`,
          limit: String(POST_LIMIT),
        },
        token,
      );
      commentsNote =
        'Commenter names need the pages_read_user_content permission.';
    }
    return (json.data || []).map((p: any) => ({
      id: String(p.id),
      text: p.message || p.story || '',
      mediaUrl: p.full_picture || null,
      mediaType: p.full_picture ? 'IMAGE' : null,
      permalink: p.permalink_url || null,
      createdAt: p.created_time || null,
      likes: p.reactions?.summary?.total_count ?? null,
      commentsCount:
        p.comments?.summary?.total_count ?? (p.comments?.data?.length || 0),
      comments: (p.comments?.data || []).map((c: any) => ({
        id: String(c.id),
        text: c.message || '',
        author: c.from?.name || null,
        createdAt: c.created_time || null,
      })),
      ...(commentsNote ? { commentsNote } : {}),
    }));
  }

  private async instagramPosts(
    igUserId: string,
    token: string,
  ): Promise<ChannelPost[]> {
    const json = await this.graphGet(
      `/${igUserId}/media`,
      {
        fields:
          'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit: String(POST_LIMIT),
      },
      token,
    );
    const media: any[] = json.data || [];
    return Promise.all(
      media.map(async (m) => {
        const post: ChannelPost = {
          id: String(m.id),
          text: m.caption || '',
          mediaUrl:
            m.media_type === 'VIDEO'
              ? m.thumbnail_url || null
              : m.media_url || null,
          mediaType: m.media_type || null,
          permalink: m.permalink || null,
          createdAt: m.timestamp || null,
          likes: m.like_count ?? null,
          commentsCount: m.comments_count ?? null,
          comments: [],
        };
        if (!m.comments_count) return post;
        try {
          const c = await this.graphGet(
            `/${m.id}/comments`,
            {
              fields: 'id,text,username,timestamp',
              limit: String(COMMENT_LIMIT),
            },
            token,
          );
          post.comments = (c.data || []).map((x: any) => ({
            id: String(x.id),
            text: x.text || '',
            author: x.username || null,
            createdAt: x.timestamp || null,
          }));
        } catch (err: any) {
          // Reading Instagram comments needs instagram_manage_comments, which
          // this app can only request after Meta App Review.
          post.comments = null;
          post.commentsNote = `Comments unavailable: ${err.message}`;
        }
        return post;
      }),
    );
  }

  async replyToComment(
    orgId: string,
    channelId: string,
    commentId: string,
    text: string,
  ) {
    if (!text?.trim()) throw new BadRequestException('Reply is empty');
    const { channel, token } = await this.channelFor(orgId, channelId);
    const failure: { message?: string } = {};
    const sent =
      channel.platform === 'FACEBOOK'
        ? await this.metaPublisher.replyToFacebookComment(
            commentId,
            text,
            token,
            failure,
          )
        : await this.metaPublisher.replyToComment(
            commentId,
            text,
            token,
            failure,
          );
    if (!sent)
      throw new BadGatewayException(
        `Meta did not post the reply: ${failure.message || 'unknown error'}`,
      );
    return { ok: true };
  }
}
