import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import {
  AI_PROVIDERS,
  AI_SERVICES,
  defaultImageModel,
  defaultTextModel,
  ENV_KEYS,
  PROVIDER_LABELS,
  SERVICE_INFO,
  type AiProvider,
  type AiService,
  type ResolvedAi,
} from './ai-providers.types';

type KeyRow = {
  provider: string;
  apiKeyEnc: string;
  keyHint: string;
  model: string | null;
};

/**
 * Stores AI provider keys (platform and per workspace) and decides which
 * provider, key and model each AI service uses for a workspace.
 */
@Injectable()
export class AiProviderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * The platform picks the provider for each service. When it lets tenants
   * choose, a workspace's own pick (or its own key for the platform provider)
   * wins. Keys connected from the dashboard win over env keys.
   */
  async resolve(orgId: string | null, service: AiService): Promise<ResolvedAi | null> {
    const [platformKeys, platformSettings] = await Promise.all([
      this.keys(null),
      this.prisma.aiServiceSetting.findMany({ where: { orgId: null } }),
    ]);
    const platform = platformSettings.find((s) => s.service === service);
    const allowed = SERVICE_INFO[service].providers;

    if (orgId && platform?.tenantCanChoose) {
      const [orgKeys, orgSetting] = await Promise.all([
        this.keys(orgId),
        this.prisma.aiServiceSetting.findFirst({ where: { orgId, service } }),
      ]);
      const wanted = orgSetting?.provider || platform.provider;
      const own = orgKeys.find((k) => k.provider === wanted);
      if (own && allowed.includes(wanted as AiProvider)) {
        return this.build(own, service, orgSetting?.model || null, 'WORKSPACE');
      }
    }

    const order: AiProvider[] = platform
      ? [platform.provider as AiProvider]
      : // No choice saved yet: Gemini first, as before, then whatever is connected.
        (['GEMINI', 'OPENAI', 'CLAUDE'] as AiProvider[]).filter((p) => allowed.includes(p));
    for (const provider of order) {
      const key = platformKeys.find((k) => k.provider === provider);
      if (key) return this.build(key, service, platform?.model || null, 'PLATFORM');
      const env = process.env[ENV_KEYS[provider]];
      if (env) {
        return {
          provider,
          apiKey: env,
          model: platform?.model || modelFor(provider, service, null),
          source: 'ENV',
        };
      }
    }
    return null;
  }

  async isConfigured(orgId: string | null, service: AiService): Promise<boolean> {
    return Boolean(await this.resolve(orgId, service));
  }

  /** Keys and service choices for the superadmin dashboard (orgId null) or a workspace. */
  async overview(orgId: string | null) {
    const [keys, settings, platformSettings] = await Promise.all([
      this.keys(orgId),
      this.prisma.aiServiceSetting.findMany({ where: { orgId } }),
      orgId ? this.prisma.aiServiceSetting.findMany({ where: { orgId: null } }) : Promise.resolve(null),
    ]);
    const providers = AI_PROVIDERS.map((provider) => {
      const key = keys.find((k) => k.provider === provider);
      return {
        provider,
        label: PROVIDER_LABELS[provider],
        connected: Boolean(key),
        keyHint: key?.keyHint || null,
        model: key?.model || null,
        defaultModel: defaultTextModel(provider),
        // Only the platform view reports env keys; tenants never see them.
        envKey: orgId ? false : Boolean(process.env[ENV_KEYS[provider]]),
      };
    });
    const services = await Promise.all(
      AI_SERVICES.map(async (service) => {
        const own = settings.find((s) => s.service === service);
        const platform = orgId ? platformSettings!.find((s) => s.service === service) : own;
        const effective = await this.resolve(orgId, service);
        return {
          service,
          label: SERVICE_INFO[service].label,
          description: SERVICE_INFO[service].description,
          providers: SERVICE_INFO[service].providers,
          provider: own?.provider || null,
          model: own?.model || null,
          tenantCanChoose: Boolean(platform?.tenantCanChoose),
          platformProvider: platform?.provider || null,
          effective: effective
            ? {
                provider: effective.provider,
                model: effective.model,
                source: effective.source,
              }
            : null,
        };
      }),
    );
    return { providers, services };
  }

  async saveKey(orgId: string | null, provider: AiProvider, apiKey: string, model?: string | null) {
    const key = String(apiKey || '').trim();
    if (key.length < 12 || key.length > 400 || /\s/.test(key)) {
      throw new BadRequestException('That does not look like an API key');
    }
    const data = {
      apiKeyEnc: this.crypto.encrypt(key),
      keyHint: `…${key.slice(-4)}`,
      model: cleanModel(model),
    };
    const existing = await this.prisma.aiProviderKey.findFirst({
      where: { orgId, provider },
    });
    if (existing)
      await this.prisma.aiProviderKey.update({
        where: { id: existing.id },
        data,
      });
    else
      await this.prisma.aiProviderKey.create({
        data: { orgId, provider, ...data },
      });
    return { ok: true, keyHint: data.keyHint };
  }

  async setKeyModel(orgId: string | null, provider: AiProvider, model: string | null) {
    const res = await this.prisma.aiProviderKey.updateMany({
      where: { orgId, provider },
      data: { model: cleanModel(model) },
    });
    if (!res.count) throw new BadRequestException('Connect this provider first');
    return { ok: true };
  }

  async removeKey(orgId: string | null, provider: AiProvider) {
    await this.prisma.aiProviderKey.deleteMany({ where: { orgId, provider } });
    return { ok: true };
  }

  /** The stored key (or, for the platform, the env key) to test a connection with. */
  async keyFor(orgId: string | null, provider: AiProvider): Promise<string | null> {
    const row = (await this.keys(orgId)).find((k) => k.provider === provider);
    if (row) return this.crypto.decrypt(row.apiKeyEnc);
    return orgId ? null : process.env[ENV_KEYS[provider]] || null;
  }

  async saveService(
    orgId: string | null,
    service: AiService,
    input: {
      provider?: string | null;
      model?: string | null;
      tenantCanChoose?: boolean;
    },
  ) {
    if (orgId) {
      const platform = await this.prisma.aiServiceSetting.findFirst({
        where: { orgId: null, service },
      });
      if (!platform?.tenantCanChoose) {
        throw new BadRequestException('This service is managed by the platform');
      }
      if (!input.provider) {
        await this.prisma.aiServiceSetting.deleteMany({
          where: { orgId, service },
        });
        return { ok: true };
      }
    }
    const provider = input.provider as AiProvider;
    if (!SERVICE_INFO[service].providers.includes(provider)) {
      throw new BadRequestException(`${PROVIDER_LABELS[provider] || input.provider} cannot run this service`);
    }
    const data = {
      provider,
      model: cleanModel(input.model),
      // Only the platform row decides whether tenants may choose.
      tenantCanChoose: orgId ? false : Boolean(input.tenantCanChoose),
    };
    const existing = await this.prisma.aiServiceSetting.findFirst({
      where: { orgId, service },
    });
    if (existing)
      await this.prisma.aiServiceSetting.update({
        where: { id: existing.id },
        data,
      });
    else
      await this.prisma.aiServiceSetting.create({
        data: { orgId, service, ...data },
      });
    return { ok: true };
  }

  private keys(orgId: string | null): Promise<KeyRow[]> {
    return this.prisma.aiProviderKey.findMany({
      where: { orgId },
      select: { provider: true, apiKeyEnc: true, keyHint: true, model: true },
    });
  }

  private build(
    key: KeyRow,
    service: AiService,
    serviceModel: string | null,
    source: ResolvedAi['source'],
  ): ResolvedAi {
    const provider = key.provider as AiProvider;
    return {
      provider,
      apiKey: this.crypto.decrypt(key.apiKeyEnc),
      model: serviceModel || modelFor(provider, service, key.model),
      source,
    };
  }
}

function modelFor(provider: AiProvider, service: AiService, keyModel: string | null) {
  // A key's model is a text model; images always use the image model.
  if (service === 'POST_IMAGES') return defaultImageModel(provider);
  return keyModel || defaultTextModel(provider);
}

function cleanModel(model?: string | null): string | null {
  const m = String(model || '').trim();
  if (!m) return null;
  if (!/^[\w.:\-/@]{1,100}$/.test(m)) throw new BadRequestException('Model name has invalid characters');
  return m;
}
