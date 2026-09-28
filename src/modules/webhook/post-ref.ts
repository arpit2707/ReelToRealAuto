// Which post a DM is about, when Meta says: a story reply, an ad or ig.me /
// m.me link (referral), a postback from one, or a shared post / reel.

export type PostRef = {
  postId?: string;
  // A shared post sometimes arrives only as a link.
  permalink?: string;
  kind: 'story' | 'ad' | 'link' | 'share';
};

export function extractPostRef(event: any): PostRef | null {
  const m = event?.message || {};
  if (m.reply_to?.story?.id)
    return { postId: String(m.reply_to.story.id), kind: 'story' };
  const referral = m.referral || event?.referral || event?.postback?.referral;
  if (referral) {
    const adPost = referral.ads_context_data?.post_id;
    if (adPost) return { postId: String(adPost), kind: 'ad' };
    // ig.me/m.me links we hand out carry ref=post_<id>.
    const ref = String(referral.ref || '').match(/^post[:_](.+)$/i);
    if (ref) return { postId: ref[1], kind: 'link' };
  }
  for (const a of m.attachments || []) {
    const p = a?.payload || {};
    if (a?.type === 'ig_reel' && p.reel_video_id)
      return { postId: String(p.reel_video_id), kind: 'share' };
    if (a?.type === 'share' || a?.type === 'ig_post') {
      const id = p.ig_post_media_id || p.media_id || p.id;
      if (id) return { postId: String(id), kind: 'share' };
      if (p.url) return { permalink: String(p.url), kind: 'share' };
    }
  }
  return null;
}

/** What to show in the inbox for a message without text. */
export function describeAttachments(event: any): string | null {
  const m = event?.message || {};
  if (m.reply_to?.story?.id && !m.text) return '[Replied to your story]';
  const types: string[] = (m.attachments || []).map((a: any) =>
    String(a?.type || ''),
  );
  if (!types.length) return null;
  const t = types[0];
  if (t === 'share' || t === 'ig_post') return '[Shared a post]';
  if (t === 'ig_reel' || t === 'reel') return '[Shared a reel]';
  if (t === 'story_mention') return '[Mentioned you in a story]';
  if (t === 'image') return '[Photo]';
  if (t === 'video') return '[Video]';
  if (t === 'audio') return '[Voice message]';
  if (t === 'file') return '[File]';
  return `[${t || 'Attachment'}]`;
}

/** Permalink without query string or trailing slash, for matching. */
export function normalizePermalink(url: string): string {
  return url.split(/[?#]/)[0].replace(/\/+$/, '');
}
