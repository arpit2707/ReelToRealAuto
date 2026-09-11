import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';

export interface DiscoveredPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: {
    id: string;
    username: string;
    name?: string;
  };
}

@Injectable()
export class MetaOAuthService implements OnModuleInit {
  private readonly logger = new Logger(MetaOAuthService.name);
  private readonly appId = process.env.META_APP_ID || '';
  private readonly appSecret = process.env.META_APP_SECRET || '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit() {
    await this.seedEnvChannels();
  }

  async seedEnvChannels() {
    try {
      const defaultOrg = await this.prisma.organization.upsert({
        where: { slug: 'default-org' },
        update: {},
        create: {
          id: 'org_default',
          name: 'Primary Merchant Org',
          slug: 'default-org',
        },
      });

      if (process.env.PAGE_ID_MEME_WORLD && process.env.PAGE_TOKEN_MEME_WORLD) {
        await this.connectChannel(defaultOrg.id, {
          platform: 'FACEBOOK',
          channelIdentifier: process.env.PAGE_ID_MEME_WORLD,
          name: 'Meme World Official',
          accessToken: process.env.PAGE_TOKEN_MEME_WORLD,
          permissions: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_messaging', 'pages_manage_metadata'],
        });
        this.logger.log(`Synced Page Meme World (${process.env.PAGE_ID_MEME_WORLD}) to Supabase Channel Vault`);
      }

      if (process.env.PAGE_ID_DESI_MEME_FACTORY && process.env.PAGE_TOKEN_DESI_MEME_FACTORY) {
        await this.connectChannel(defaultOrg.id, {
          platform: 'FACEBOOK',
          channelIdentifier: process.env.PAGE_ID_DESI_MEME_FACTORY,
          name: 'Desi Meme Factory',
          accessToken: process.env.PAGE_TOKEN_DESI_MEME_FACTORY,
          permissions: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_messaging', 'pages_manage_metadata'],
        });
        this.logger.log(`Synced Page Desi Meme Factory (${process.env.PAGE_ID_DESI_MEME_FACTORY}) to Supabase Channel Vault`);
      }

      if (process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN) {
        await this.connectChannel(defaultOrg.id, {
          platform: 'WHATSAPP',
          channelIdentifier: process.env.WHATSAPP_PHONE_NUMBER_ID,
          name: 'WhatsApp Business',
          accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
          permissions: ['whatsapp_business_messaging', 'whatsapp_business_management'],
          metadata: { wabaId: process.env.WHATSAPP_WABA_ID || null },
        });
        this.logger.log(`Synced WhatsApp channel ${process.env.WHATSAPP_PHONE_NUMBER_ID}`);
      }

      if (process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ACCESS_TOKEN) {
        await this.prisma.shopifyStore.upsert({
          where: {
            orgId_shopDomain: {
              orgId: defaultOrg.id,
              shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
            },
          },
          update: {
            accessTokenEncrypted: this.crypto.encrypt(process.env.SHOPIFY_ACCESS_TOKEN),
            webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || undefined,
          },
          create: {
            orgId: defaultOrg.id,
            shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
            accessTokenEncrypted: this.crypto.encrypt(process.env.SHOPIFY_ACCESS_TOKEN),
            webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || null,
          },
        });
        this.logger.log(`Synced Shopify store ${process.env.SHOPIFY_SHOP_DOMAIN}`);
      }
    } catch (err: any) {
      this.logger.warn(`Could not seed env channels: ${err.message}`);
    }
  }

  async exchangeForLongLivedToken(shortLivedToken: string): Promise<string> {
    if (!this.appId || !this.appSecret || shortLivedToken.startsWith('mock_')) {
      this.logger.log('[SIMULATION] Generating simulated long-lived user token');
      return `llt_${shortLivedToken || 'simulated_user_token_long_lived'}`;
    }

    const url = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}/oauth/access_token?grant_type=fb_exchange_token&client_id=${this.appId}&client_secret=${this.appSecret}&fb_exchange_token=${shortLivedToken}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to exchange token: ${await res.text()}`);
    }
    const data = await res.json();
    return data.access_token;
  }

  async fetchUserPages(userToken: string): Promise<DiscoveredPage[]> {
    if (!this.appId || userToken.startsWith('llt_mock_') || userToken.startsWith('mock_')) {
      this.logger.log('[SIMULATION] Returning simulated merchant pages & IG accounts');
      return [
        {
          id: 'page_1001',
          name: 'Royal Apparel Official',
          access_token: 'mock_pat_page_1001',
          instagram_business_account: {
            id: 'ig_2001',
            username: 'royalapparel_official',
            name: 'Royal Apparel Co.',
          },
        },
        {
          id: 'page_1002',
          name: 'Royal Luxury Outlet',
          access_token: 'mock_pat_page_1002',
          instagram_business_account: {
            id: 'ig_2002',
            username: 'royal_outlet',
            name: 'Royal Outlet Deals',
          },
        },
      ];
    }

    const url = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v24.0'}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&access_token=${userToken}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch pages: ${await res.text()}`);
    }
    const data = await res.json();
    return data.data || [];
  }

  async connectChannel(
    orgId: string,
    payload: {
      platform: 'INSTAGRAM' | 'FACEBOOK' | 'WHATSAPP';
      channelIdentifier: string;
      name: string;
      accessToken: string;
      permissions?: string[];
      tokenExpiresAt?: Date;
      metadata?: any;
    },
  ) {
    // Ensure organization exists
    const cleanOrgId = orgId || 'org_default';
    const slug = cleanOrgId.toLowerCase().replace(/[^a-z0-9]/g, '-');
    await this.prisma.organization.upsert({
      where: { slug },
      update: {},
      create: {
        id: cleanOrgId,
        name: cleanOrgId === 'org_default' ? 'Primary Merchant Org' : cleanOrgId,
        slug,
      },
    });

    const encryptedToken = this.crypto.encrypt(payload.accessToken);
    const existing = await this.prisma.channel.findUnique({
      where: {
        platform_channelIdentifier: {
          platform: payload.platform,
          channelIdentifier: payload.channelIdentifier,
        },
      },
    });
    if (existing && existing.orgId !== cleanOrgId) {
      throw new Error('This Meta asset is already connected to another workspace');
    }

    return await this.prisma.channel.upsert({
      where: {
        platform_channelIdentifier: {
          platform: payload.platform,
          channelIdentifier: payload.channelIdentifier,
        },
      },
      update: {
        name: payload.name,
        accessTokenEncrypted: encryptedToken,
        permissions: payload.permissions || [],
        tokenExpiresAt: payload.tokenExpiresAt,
        metadata: payload.metadata,
        isActive: true,
        status: 'ACTIVE',
        orgId: cleanOrgId,
      },
      create: {
        orgId: cleanOrgId,
        platform: payload.platform,
        channelIdentifier: payload.channelIdentifier,
        name: payload.name,
        accessTokenEncrypted: encryptedToken,
        permissions: payload.permissions || [],
        tokenExpiresAt: payload.tokenExpiresAt,
        metadata: payload.metadata,
        isActive: true,
        status: 'ACTIVE',
      },
    });
  }

  async listChannels(orgId: string) {
    const channels = await this.prisma.channel.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });
    return channels.map((c) => ({
      id: c.id,
      platform: c.platform,
      channelIdentifier: c.channelIdentifier,
      name: c.name,
      permissions: c.permissions,
      tokenExpiresAt: c.tokenExpiresAt,
      metadata: c.metadata,
      isActive: c.isActive,
      createdAt: c.createdAt,
    }));
  }

  async auditChannelsHealth(orgId?: string) {
    const channels = await this.prisma.channel.findMany({
      where: orgId ? { orgId } : {},
      include: { org: true },
    });

    const identifierCounts = new Map<string, number>();
    for (const c of channels) {
      identifierCounts.set(c.channelIdentifier, (identifierCounts.get(c.channelIdentifier) || 0) + 1);
    }

    const REQUIRED_BY_PLATFORM: Record<string, string[]> = {
      FACEBOOK: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_messaging'],
      INSTAGRAM: ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages'],
      WHATSAPP: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    };

    let healthyCount = 0;
    let collisionRisk = false;

    const audited = channels.map((c) => {
      let tokenStatus = 'VALID';
      try {
        const decrypted = this.crypto.decrypt(c.accessTokenEncrypted);
        if (!decrypted) tokenStatus = 'DECRYPT_FAIL';
      } catch {
        tokenStatus = 'DECRYPT_FAIL';
      }

      if (c.tokenExpiresAt && new Date(c.tokenExpiresAt) < new Date()) {
        tokenStatus = 'EXPIRED';
      }

      const count = identifierCounts.get(c.channelIdentifier) || 1;
      const isCollisionFree = count === 1;
      if (!isCollisionFree) collisionRisk = true;

      const requiredScopes = REQUIRED_BY_PLATFORM[c.platform] || [];
      const currentScopes = c.permissions || [];
      const missingScopes = requiredScopes.filter((s) => !currentScopes.includes(s));

      const isHealthy = tokenStatus === 'VALID' && isCollisionFree && missingScopes.length === 0;
      if (isHealthy) healthyCount++;

      return {
        id: c.id,
        orgId: c.orgId,
        orgName: c.org?.name || 'Unknown',
        platform: c.platform,
        name: c.name,
        identifier: c.channelIdentifier,
        tokenStatus,
        isCollisionFree,
        activeScopes: currentScopes,
        missingScopes,
        isHealthy,
      };
    });

    return {
      totalChannels: channels.length,
      healthyChannels: healthyCount,
      collisionRiskDetected: collisionRisk,
      auditTimestamp: new Date().toISOString(),
      channels: audited,
    };
  }
}

