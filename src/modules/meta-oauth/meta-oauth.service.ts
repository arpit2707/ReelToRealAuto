import { Injectable, Logger } from '@nestjs/common';
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
export class MetaOAuthService {
  private readonly logger = new Logger(MetaOAuthService.name);
  private readonly appId = process.env.META_APP_ID || '';
  private readonly appSecret = process.env.META_APP_SECRET || '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async exchangeForLongLivedToken(shortLivedToken: string): Promise<string> {
    if (!this.appId || !this.appSecret || shortLivedToken.startsWith('mock_')) {
      this.logger.log('[SIMULATION] Generating simulated long-lived user token');
      return `llt_${shortLivedToken || 'simulated_user_token_long_lived'}`;
    }

    const url = `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${this.appId}&client_secret=${this.appSecret}&fb_exchange_token=${shortLivedToken}`;
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

    const url = `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&access_token=${userToken}`;
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
    },
  ) {
    const encryptedToken = this.crypto.encrypt(payload.accessToken);
    return await this.prisma.channel.upsert({
      where: {
        orgId_channelIdentifier: {
          orgId,
          channelIdentifier: payload.channelIdentifier,
        },
      },
      update: {
        name: payload.name,
        accessTokenEncrypted: encryptedToken,
        isActive: true,
      },
      create: {
        orgId,
        platform: payload.platform,
        channelIdentifier: payload.channelIdentifier,
        name: payload.name,
        accessTokenEncrypted: encryptedToken,
        isActive: true,
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
      isActive: c.isActive,
      createdAt: c.createdAt,
    }));
  }
}
