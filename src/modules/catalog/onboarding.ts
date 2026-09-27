/**
 * Before any automation runs for a workspace, the seller tells us what the
 * business is about and which automations they want. Until they finish that,
 * the workspace stays inactive: messages are still saved to the inbox, but no
 * automatic reply goes out.
 */

export const SERVICES = ['DM_REPLY', 'COMMENT_REPLY', 'WHATSAPP_REPLY'] as const;
export type Service = (typeof SERVICES)[number];

export const REPLY_TONES = [
  'formal',
  'casual',
  'friendly',
  'playful',
  'gen_z',
] as const;
export const REPLY_LANGUAGES = ['auto', 'english', 'hinglish', 'hindi'] as const;

export const MIN_DESCRIPTION_LENGTH = 30;

type OnboardingFields = {
  businessName?: string | null;
  description?: string | null;
  services?: string[] | null;
  activatedAt?: Date | string | null;
};

/** What the seller still has to fill in before automation can be switched on. */
export function missingForActivation(profile: OnboardingFields | null) {
  const missing: string[] = [];
  if (!profile?.businessName?.trim()) missing.push('businessName');
  if ((profile?.description?.trim().length || 0) < MIN_DESCRIPTION_LENGTH)
    missing.push('description');
  if (!profile?.services?.some((s) => SERVICES.includes(s as Service)))
    missing.push('services');
  return missing;
}

/** Which service an incoming event needs before we may answer it. */
export function serviceFor(
  platform: 'INSTAGRAM' | 'FACEBOOK' | 'WHATSAPP',
  eventType: 'comment' | 'dm',
): Service {
  if (platform === 'WHATSAPP') return 'WHATSAPP_REPLY';
  return eventType === 'comment' ? 'COMMENT_REPLY' : 'DM_REPLY';
}

/** Null when automation may answer this event, otherwise why it may not. */
export function automationBlock(
  profile: OnboardingFields | null,
  service: Service,
): 'NOT_ONBOARDED' | 'SERVICE_OFF' | null {
  if (!profile?.activatedAt) return 'NOT_ONBOARDED';
  if (!profile.services?.includes(service)) return 'SERVICE_OFF';
  return null;
}
