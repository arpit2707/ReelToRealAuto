export const AI_PROVIDERS = ['OPENAI', 'GEMINI', 'CLAUDE'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_SERVICES = ['POST_TEXT', 'POST_IMAGES', 'POST_TAGGING', 'DM_REPLIES'] as const;
export type AiService = (typeof AI_SERVICES)[number];

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  OPENAI: 'OpenAI (ChatGPT / Codex)',
  GEMINI: 'Google Gemini',
  CLAUDE: 'Anthropic Claude',
};

export const SERVICE_INFO: Record<AiService, { label: string; description: string; providers: AiProvider[] }> = {
  POST_TEXT: {
    label: 'Daily post ideas and captions',
    description: 'Post ideas, trend keywords, captions, brand kit and past-post insights.',
    providers: ['GEMINI', 'OPENAI', 'CLAUDE'],
  },
  // Claude does not draw images, so it cannot run this one.
  POST_IMAGES: {
    label: 'Post images',
    description: 'Drawing, editing and lettering the post and story images.',
    providers: ['GEMINI', 'OPENAI'],
  },
  POST_TAGGING: {
    label: 'Catalog tagging of posts',
    description: 'Matching each Instagram post to the catalog items it shows.',
    providers: ['GEMINI', 'OPENAI', 'CLAUDE'],
  },
  DM_REPLIES: {
    label: 'DM and comment replies',
    description: 'AI answers to customer DMs and comments.',
    providers: ['GEMINI', 'OPENAI', 'CLAUDE'],
  },
};

/** Env keys that keep working when no key was connected from the dashboard. */
export const ENV_KEYS: Record<AiProvider, string> = {
  OPENAI: 'OPENAI_API_KEY',
  GEMINI: 'GEMINI_API_KEY',
  CLAUDE: 'ANTHROPIC_API_KEY',
};

export function defaultTextModel(provider: AiProvider): string {
  switch (provider) {
    case 'OPENAI':
      return process.env.OPENAI_TEXT_MODEL || 'gpt-5-mini';
    case 'CLAUDE':
      return process.env.ANTHROPIC_TEXT_MODEL || 'claude-sonnet-5-5';
    default:
      return process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';
  }
}

export function defaultImageModel(provider: AiProvider): string {
  return provider === 'OPENAI'
    ? process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'
    : process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
}

export function isProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

export function isService(value: unknown): value is AiService {
  return typeof value === 'string' && (AI_SERVICES as readonly string[]).includes(value);
}

/** The provider, key and model one call should use, and where the key came from. */
export type ResolvedAi = {
  provider: AiProvider;
  apiKey: string;
  model: string;
  source: 'WORKSPACE' | 'PLATFORM' | 'ENV';
};
