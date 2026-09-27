// A seller tells us what their page is about and which automations they want
// before any automated reply goes out. Until then messages still land in the
// inbox, but nothing answers them.

export const SERVICES = [
  {
    code: 'DM_REPLY',
    label: 'AI reply to Instagram and Facebook DMs',
  },
  {
    code: 'COMMENT_REPLY',
    label: 'AI reply to comments on posts (with a DM)',
  },
  {
    code: 'WHATSAPP_REPLY',
    label: 'AI reply to WhatsApp messages',
  },
] as const;

export type ServiceCode = (typeof SERVICES)[number]['code'];

// Values the AI service accepts for brand_persona.tone and language_mode.
export const TONES = ['friendly', 'formal', 'casual', 'playful', 'gen_z'];
export const LANGUAGES = ['hinglish', 'english', 'hindi', 'auto'];

export const MIN_DESCRIPTION = 20;

export function serviceFor(
  platform: 'INSTAGRAM' | 'FACEBOOK' | 'WHATSAPP',
  eventType: 'comment' | 'dm',
): ServiceCode {
  if (platform === 'WHATSAPP') return 'WHATSAPP_REPLY';
  return eventType === 'comment' ? 'COMMENT_REPLY' : 'DM_REPLY';
}

type ProfileLike = {
  description?: string | null;
  industry?: string | null;
  services?: string[] | null;
  onboardedAt?: Date | string | null;
} | null;

/** What is still missing before setup can be finished. */
export function missingForOnboarding(p: ProfileLike): string[] {
  const missing: string[] = [];
  if (!p?.industry) missing.push('industry');
  if ((p?.description || '').trim().length < MIN_DESCRIPTION)
    missing.push('description');
  return missing;
}

export function onboardingStatus(p: ProfileLike) {
  return {
    complete: !!p?.onboardedAt,
    missing: missingForOnboarding(p),
    services: p?.services || [],
  };
}

/** Why an automated reply must not go out, or null when it may. */
export function replyBlockedReason(
  p: ProfileLike,
  service: ServiceCode,
): string | null {
  if (!p?.onboardedAt) return 'setup_incomplete';
  if (!(p.services || []).includes(service)) return 'service_off';
  return null;
}
