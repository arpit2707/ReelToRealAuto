// Pure rules for comments on Instagram and Facebook posts, shared by the
// pipeline (webhook time) and the queue (send time).

export type Platform = 'INSTAGRAM' | 'FACEBOOK';

export type NormalizedComment = {
  platform: Platform;
  commentId: string;
  postId: string | null;
  parentId: string | null;
  authorId: string | null;
  // Instagram username (for the @tag) or Facebook name.
  authorName: string | null;
  text: string;
  createdAt: Date | null;
  // add | edited | remove (Facebook sends all three; Instagram only adds)
  verb: string;
};

/** Instagram `comments` change value. */
export function normalizeInstagram(value: any): NormalizedComment | null {
  const commentId = value?.id ? String(value.id) : '';
  if (!commentId) return null;
  return {
    platform: 'INSTAGRAM',
    commentId,
    postId: value?.media?.id ? String(value.media.id) : null,
    parentId: value?.parent_id ? String(value.parent_id) : null,
    authorId: value?.from?.id ? String(value.from.id) : null,
    authorName: value?.from?.username || null,
    text: String(value?.text || ''),
    createdAt: value?.timestamp ? toDate(value.timestamp) : null,
    verb: 'add',
  };
}

/** Facebook Page `feed` change value with item "comment". */
export function normalizeFacebook(value: any): NormalizedComment | null {
  const commentId = value?.comment_id ? String(value.comment_id) : '';
  if (!commentId) return null;
  return {
    platform: 'FACEBOOK',
    commentId,
    postId: value?.post_id ? String(value.post_id) : null,
    parentId: value?.parent_id ? String(value.parent_id) : null,
    authorId: value?.from?.id ? String(value.from.id) : null,
    authorName: value?.from?.name || null,
    text: String(value?.message || ''),
    createdAt: value?.created_time ? toDate(value.created_time) : null,
    verb: String(value?.verb || 'add'),
  };
}

function toDate(v: unknown): Date | null {
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A top-level comment. Instagram replies carry parent_id; on Facebook a
 * top-level comment's parent_id is the post itself.
 */
export function isRootComment(
  c: Pick<NormalizedComment, 'platform' | 'parentId' | 'postId'>,
): boolean {
  if (!c.parentId) return true;
  return c.platform === 'FACEBOOK' && c.parentId === c.postId;
}

const SMALL_TALK = new Set(
  [
    'nice',
    'wow',
    'woww',
    'love',
    'love it',
    'loved it',
    'beautiful',
    'awesome',
    'superb',
    'cute',
    'gorgeous',
    'amazing',
    'great',
    'lovely',
    'so pretty',
    'pretty',
    'nice pic',
    'nice one',
    'osm',
    'mast',
    'badhiya',
    'sundar',
    'bahut sundar',
    'very nice',
    'so nice',
    'so cute',
    'wow nice',
    'op',
    'fire',
    'lit',
    'ok',
    'okay',
    'thanks',
    'thank you',
    'thanku',
    'thnx',
    'congrats',
    'congratulations',
    'best',
    'good',
    'very good',
    'too good',
    'excellent',
    'perfect',
    'stunning',
  ].map((s) => s.toLowerCase()),
);

/**
 * Comments that need no answer: only emoji, only tagging a friend, "nice",
 * festival wishes, or fewer than 3 real characters. A question never is.
 */
export function isJunkComment(text: string): boolean {
  const withoutTags = (text || '').replace(/@[\w.]+/g, ' ');
  if (/\?/.test(withoutTags)) return false;
  const letters = withoutTags
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (letters.replace(/\s/g, '').length < 3) return true;
  if (SMALL_TALK.has(letters)) return true;
  // "nice nice", "wow wow wow"
  const words = [...new Set(letters.split(' '))];
  if (words.length === 1 && SMALL_TALK.has(words[0])) return true;
  if (/^(?:happy|shubh|subh)\s+\p{L}+(?:\s+\p{L}+)?$/u.test(letters))
    return true;
  return false;
}

/**
 * The public reply with the commenter in front. Instagram tags by username;
 * the Facebook API cannot tag people, so a first name is written instead.
 */
export function withTag(
  platform: Platform,
  authorName: string | null,
  reply: string,
): string {
  const body = reply.replace(/^(?:\s*@[\w.]+[,:]?\s*)+/, '').trim();
  if (!authorName) return body;
  if (platform === 'INSTAGRAM')
    return `@${authorName.replace(/^@/, '')} ${body}`;
  const first = authorName.trim().split(/\s+/)[0];
  return first ? `${first}, ${body}` : body;
}

export const DM_CHECK_LINE = 'DM check karein ✨';
export const COMMENT_DM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const QUEUE_DM_MAX_WAIT_MS = 30 * 60 * 1000;

/**
 * A Private Reply goes only to a root comment, once per person per post,
 * while the comment is under 7 days old and the job did not wait in the
 * queue for more than 30 minutes.
 */
export function privateReplyAllowed(input: {
  isRoot: boolean;
  alreadySentOnPost: boolean;
  commentAt: Date | null;
  queuedAt: Date;
  now?: Date;
}): boolean {
  const now = input.now || new Date();
  if (!input.isRoot || input.alreadySentOnPost) return false;
  if (
    input.commentAt &&
    now.getTime() - input.commentAt.getTime() > COMMENT_DM_MAX_AGE_MS
  )
    return false;
  if (now.getTime() - input.queuedAt.getTime() > QUEUE_DM_MAX_WAIT_MS)
    return false;
  return true;
}
