import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversationService } from '../conversations/conversation.service';
import { PostAiGateService } from '../catalog/post-ai-gate.service';
import { PostTaggingService } from '../catalog/post-tagging.service';
import { isCrisis } from '../catalog/crisis';
import { CommentQueueService } from './comment-queue.service';
import {
  isJunkComment,
  isRootComment,
  type NormalizedComment,
} from './comments';

export type CommentChannel = {
  id: string;
  orgId: string;
  // Instagram account id or Facebook Page id: comments from it are our own.
  channelIdentifier: string;
};

export type CommentOutcome =
  | 'own'
  | 'no_author'
  | 'crisis'
  | 'post_ai_off'
  | 'junk'
  | 'queued'
  | 'duplicate'
  | 'deleted'
  | 'ignored';

/**
 * Every comment on an Instagram or Facebook post comes through here, the same
 * code for both platforms: saved to the inbox, then (only on AI-on posts, and
 * only if it asks something) queued for a tagged public reply and, for the
 * first root comment of a person on a post, a Private Reply DM.
 */
@Injectable()
export class CommentPipelineService {
  private readonly logger = new Logger(CommentPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
    private readonly gate: PostAiGateService,
    private readonly queue: CommentQueueService,
    @Optional() private readonly tagging?: PostTaggingService,
  ) {}

  async handle(
    channel: CommentChannel,
    c: NormalizedComment,
  ): Promise<CommentOutcome> {
    if (c.verb === 'remove') return this.removed(channel, c);
    // Edits are ignored: the first version was already answered (or not).
    if (c.verb === 'edited' || c.verb === 'hide' || c.verb === 'unhide')
      return 'ignored';
    if (!c.text.trim() || !c.postId) return 'ignored';

    // 2. Our own replies, and the page commenting on its own post.
    if (await this.isOwn(channel, c)) return 'own';
    if (!c.authorId) return 'no_author';

    // 3. Every comment lands in the commenter's inbox chat.
    const conversation = await this.conversations
      .attachComment({
        orgId: channel.orgId,
        channelId: channel.id,
        platform: c.platform,
        authorId: c.authorId,
        authorName: c.authorName,
        text: c.text,
        commentId: c.commentId,
        postId: c.postId,
        parentId: c.parentId,
      })
      .catch((e) => {
        this.logger.error(
          `Could not save comment ${c.commentId} to the inbox: ${e.message}`,
        );
        return null;
      });

    const root = isRootComment(c);
    // 4. Safety first, whatever the post's switch says.
    if (isCrisis(c.text)) {
      const thread = await this.thread(channel, c, root);
      const queued = await this.queue.enqueue({
        orgId: channel.orgId,
        channelId: channel.id,
        threadId: thread.id,
        conversationId: conversation?.id || null,
        comment: c,
        isRoot: root,
        kind: 'CRISIS',
      });
      return queued ? 'crisis' : 'duplicate';
    }

    // 5. The AI speaks only on posts the seller switched on.
    if (!(await this.gate.isPostAiOn(channel.orgId, c.postId))) {
      // Learn the post (and ask the seller about it) in the background.
      if (this.tagging)
        void this.tagging
          .ensurePostContext(channel.orgId, channel.id, c.postId)
          .catch((e) =>
            this.logger.warn(
              `Post context for ${c.postId} failed: ${e.message}`,
            ),
          );
      return 'post_ai_off';
    }

    // 6. "nice", emoji, tagging a friend.
    if (isJunkComment(c.text)) return 'junk';

    // 7. One record per root comment; replies join it.
    const thread = await this.thread(channel, c, root);
    const queued = await this.queue.enqueue({
      orgId: channel.orgId,
      channelId: channel.id,
      threadId: thread.id,
      conversationId: conversation?.id || null,
      comment: c,
      isRoot: root,
      kind: 'REPLY',
    });
    return queued ? 'queued' : 'duplicate';
  }

  /** Our reply (by id, or by text on this post) or the page's own comment. */
  private async isOwn(
    channel: CommentChannel,
    c: NormalizedComment,
  ): Promise<boolean> {
    if (c.authorId && c.authorId === channel.channelIdentifier) return true;
    const ours = await this.prisma.commentReplyJob.findFirst({
      where: {
        orgId: channel.orgId,
        OR: [
          { replyCommentId: c.commentId },
          {
            status: 'SENT',
            publicReply: c.text,
            thread: { postId: c.postId || undefined },
            sentAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        ],
      },
      select: { id: true },
    });
    return Boolean(ours);
  }

  /**
   * Root comments open a record; a reply joins its parent's record, or an
   * "adopted" one when the parent was never seen (before the post's AI was
   * on, or deleted since).
   */
  private async thread(
    channel: CommentChannel,
    c: NormalizedComment,
    root: boolean,
  ) {
    const rootCommentId = root ? c.commentId : (c.parentId as string);
    const existing = await this.prisma.commentThread.findUnique({
      where: { orgId_rootCommentId: { orgId: channel.orgId, rootCommentId } },
    });
    if (existing) {
      if (!root) {
        return this.prisma.commentThread.update({
          where: { id: existing.id },
          data: { replyCount: { increment: 1 }, lastReplyAt: new Date() },
        });
      }
      return existing;
    }
    return this.prisma.commentThread
      .create({
        data: {
          orgId: channel.orgId,
          channelId: channel.id,
          platform: c.platform,
          postId: c.postId as string,
          rootCommentId,
          rootAuthorId: root ? c.authorId : null,
          rootAuthorName: root ? c.authorName : null,
          status: root ? 'OPEN' : 'ADOPTED',
          replyCount: root ? 0 : 1,
          lastReplyAt: root ? null : new Date(),
        },
      })
      .catch(async (e) => {
        // Two webhooks for the same thread at once: the other one created it.
        const again = await this.prisma.commentThread.findUnique({
          where: {
            orgId_rootCommentId: { orgId: channel.orgId, rootCommentId },
          },
        });
        if (!again) throw e;
        return again;
      });
  }

  /** A deleted comment: its thread (if a root) is closed and pending answers stop. */
  private async removed(
    channel: CommentChannel,
    c: NormalizedComment,
  ): Promise<CommentOutcome> {
    const thread = await this.prisma.commentThread.findUnique({
      where: {
        orgId_rootCommentId: {
          orgId: channel.orgId,
          rootCommentId: c.commentId,
        },
      },
      select: { id: true },
    });
    if (thread) {
      await this.prisma.commentThread.update({
        where: { id: thread.id },
        data: { status: 'DELETED' },
      });
    }
    await this.prisma.commentReplyJob.updateMany({
      where: {
        orgId: channel.orgId,
        status: 'QUEUED',
        OR: [
          { commentId: c.commentId },
          ...(thread ? [{ threadId: thread.id }] : []),
        ],
      },
      data: { status: 'SKIPPED', error: 'comment_deleted' },
    });
    return 'deleted';
  }
}
