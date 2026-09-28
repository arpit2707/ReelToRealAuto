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
export type Service = ServiceCode;

export const SERVICE_CODES = ['DM_REPLY', 'COMMENT_REPLY', 'WHATSAPP_REPLY'] as const;

// Values the AI service accepts for brand_persona.tone and language_mode.
export const TONES = ['friendly', 'formal', 'casual', 'playful', 'gen_z'];
export const LANGUAGES = ['hinglish', 'english', 'hindi', 'auto'];

export const REPLY_TONES = [
  'formal',
  'casual',
  'friendly',
  'playful',
  'gen_z',
] as const;
export const REPLY_LANGUAGES = ['auto', 'english', 'hinglish', 'hindi'] as const;

export const MIN_DESCRIPTION = 20;
export const MIN_DESCRIPTION_LENGTH = 30;

export type ProfileLike = {
  offerType?: string | null;
  businessName?: string | null;
  description?: string | null;
  industry?: string | null;
  services?: string[] | null;
  onboardedAt?: Date | string | null;
  activatedAt?: Date | string | null;
} | null;

export function serviceFor(
  platform: 'INSTAGRAM' | 'FACEBOOK' | 'WHATSAPP',
  eventType: 'comment' | 'dm',
): ServiceCode {
  if (platform === 'WHATSAPP') return 'WHATSAPP_REPLY';
  return eventType === 'comment' ? 'COMMENT_REPLY' : 'DM_REPLY';
}

/** What the seller still has to fill in before automation can be switched on. */
export function missingForActivation(profile: ProfileLike) {
  const missing: string[] = [];
  if (!profile?.businessName?.trim()) missing.push('businessName');
  if ((profile?.description?.trim().length || 0) < MIN_DESCRIPTION_LENGTH)
    missing.push('description');
  if (!profile?.services?.some((s) => (SERVICE_CODES as readonly string[]).includes(s)))
    missing.push('services');
  return missing;
}

/** What is still missing before setup can be finished. */
export function missingForOnboarding(p: ProfileLike): string[] {
  const missing: string[] = [];
  if (!p?.industry) missing.push('industry');
  if ((p?.description || '').trim().length < MIN_DESCRIPTION)
    missing.push('description');
  return missing;
}

export function onboardingStatus(p: ProfileLike) {
  const isComplete = Boolean(p?.onboardedAt || p?.activatedAt);
  return {
    complete: isComplete,
    active: isComplete,
    missing: missingForOnboarding(p),
    services: p?.services || [],
  };
}

/** Why an automated reply must not go out, or null when it may. */
export function replyBlockedReason(
  p: ProfileLike,
  service: ServiceCode,
): string | null {
  if (!p?.onboardedAt && !p?.activatedAt) return 'setup_incomplete';
  if (!(p.services || []).includes(service)) return 'service_off';
  return null;
}

/** Null when automation may answer this event, otherwise why it may not. */
export function automationBlock(
  profile: ProfileLike,
  service: ServiceCode,
): 'NOT_ONBOARDED' | 'SERVICE_OFF' | null {
  if (!profile?.activatedAt && !profile?.onboardedAt) return 'NOT_ONBOARDED';
  if (!(profile.services || []).includes(service)) return 'SERVICE_OFF';
  return null;
}
