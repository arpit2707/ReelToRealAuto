import { Injectable, Logger, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { MetaOAuthService } from '../meta-oauth/meta-oauth.service';
import { facebookDialogUrl, graphUrl, appsecretProof, graphVersion } from '../../common/graph';

type ConnectProvider = 'facebook' | 'instagram' | 'whatsapp';

const PAGE_FIELDS =
  'messages,messaging_postbacks,messaging_optins,message_reactions,message_deliveries,message_reads,feed,mention';

@Injectable()
export class ChannelConnectService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelConnectService.name);
  private healthTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly metaOAuth: MetaOAuthService,
  ) {}

  private appId() {
    return process.env.META_APP_ID || '';
  }
  private appSecret() {
    return process.env.META_APP_SECRET || '';
  }
  private publicBase() {
    return (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5002}`).replace(/\/$/, '');
  }
  private frontendBase() {
    return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  }
  redirectUri() {
    return `${this.publicBase()}/auth/meta/callback`;
  }

  async createStartUrl(provider: ConnectProvider, orgId: string, userId: string) {
    if (!this.appId() || !this.appSecret()) {
      throw new UnauthorizedException('META_APP_ID / META_APP_SECRET missing');
    }
    const state = crypto.randomBytes(24).toString('hex');
    await this.prisma.oauthState.create({
      data: {
        state,
        provider,
        intent: 'connect',
        userId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const params = new URLSearchParams({
      client_id: this.appId(),
      redirect_uri: this.redirectUri(),
      state,
      response_type: 'code',
      override_default_response_type: 'true',
    });
    const configId =
      provider === 'whatsapp' ? process.env.META_WA_ESU_CONFIG_ID : process.env.META_FB_LOGIN_CONFIG_ID;
    if (configId) {
      params.set('config_id', configId);
    } else {
      params.set('scope', this.scopesFor(provider));
    }
    return `${facebookDialogUrl()}?${params.toString()}`;
  }


  // Meta rejects the whole dialog with "Invalid Scopes" if the app asks for a
  // permission no enabled use case grants, so every name here is verified
  // against the OAuth dialog. The Instagram permissions come from the
  // "Manage messaging & content on Instagram" use case (API setup with
  // Facebook login), and business_management is required alongside them.
  // Note the permission is instagram_content_publishing, not ..._publish.
  // META_SCOPES_* allow tuning without a redeploy.
  private scopesFor(provider: ConnectProvider) {
    const override =
      provider === 'whatsapp'
        ? process.env.META_SCOPES_WHATSAPP
        : provider === 'instagram'
          ? process.env.META_SCOPES_INSTAGRAM
          : process.env.META_SCOPES_FACEBOOK;
    if (override?.trim()) return override.trim();

    if (provider === 'whatsapp') {
      return 'business_management,whatsapp_business_management,whatsapp_business_messaging';
    }
    if (provider === 'instagram') {
      return [
        'pages_show_list',
        'pages_manage_metadata',
        'pages_read_engagement',
        'business_management',
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_content_publishing',
      ].join(',');
    }
    return [
      'pages_show_list',
      'pages_messaging',
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_manage_engagement',
      'pages_manage_posts',
      'business_management',
      'instagram_basic',
      'instagram_manage_comments',
      'instagram_manage_messages',
    ].join(',');
  }

  async handleCallback(code?: string, state?: string) {
    const frontend = this.frontendBase();
    if (!code || !state) return `${frontend}/login?error=missing_code`;
    const row = await this.prisma.oauthState.findUnique({ where: { state } });
    if (!row || row.expiresAt < new Date() || !row.userId) {
      return `${frontend}/login?error=invalid_state`;
    }
    await this.prisma.oauthState.delete({ where: { id: row.id } }).catch(() => undefined);
    const member = await this.prisma.organizationMember.findFirst({ where: { userId: row.userId } });
    if (!member) return `${frontend}/login?error=no_workspace`;

    try {
      const shortLived = await this.exchangeCode(code);
      const longLived = await this.metaOAuth.exchangeForLongLivedToken(shortLived);
      const debug = await this.debugToken(longLived);
      const profile = await this.fetchMe(longLived);
      const provider =
        row.provider === 'whatsapp' ? 'WHATSAPP_ESU' : row.provider === 'instagram' ? 'INSTAGRAM_LOGIN' : 'FACEBOOK_BUSINESS';

      const connection = await this.prisma.metaConnection.upsert({
        where: {
          orgId_provider_metaUserId: {
            orgId: member.orgId,
            provider,
            metaUserId: profile.id,
          },
        },
        update: {
          userTokenEncrypted: this.crypto.encrypt(longLived),
          grantedScopes: debug.scopes,
          tokenExpiresAt: debug.expiresAt,
          dataAccessExpiresAt: debug.dataAccessExpiresAt,
          status: 'ACTIVE',
          lastCheckedAt: new Date(),
        },
        create: {
          orgId: member.orgId,
          provider,
          metaUserId: profile.id,
          userTokenEncrypted: this.crypto.encrypt(longLived),
          grantedScopes: debug.scopes,
          tokenExpiresAt: debug.expiresAt,
          dataAccessExpiresAt: debug.dataAccessExpiresAt,
          status: 'ACTIVE',
          lastCheckedAt: new Date(),
        },
      });

      return `${frontend}/?connected=${row.provider}&connectionId=${connection.id}`;
    } catch (err: any) {
      this.logger.error(`Channel connect callback failed: ${err.message}`);
      return `${frontend}/?connect_error=oauth_failed`;
    }
  }

  async listAssets(orgId: string, connectionId: string) {
    const connection = await this.prisma.metaConnection.findFirst({
      where: { id: connectionId, orgId },
    });
    if (!connection) throw new UnauthorizedException('Connection not found');
    const token = this.crypto.decrypt(connection.userTokenEncrypted);
    if (connection.provider === 'WHATSAPP_ESU') {
      return { connectionId, provider: connection.provider, whatsapp: await this.discoverWhatsApp(token) };
    }
    const pages = await this.metaOAuth.fetchUserPages(token);
    return { connectionId, provider: connection.provider, pages };
  }

  async confirmAssets(
    orgId: string,
    connectionId: string,
    selection: Array<{ platform: 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP'; id: string; name?: string; wabaId?: string }>,
  ) {
    const connection = await this.prisma.metaConnection.findFirst({
      where: { id: connectionId, orgId },
    });
    if (!connection) throw new UnauthorizedException('Connection not found');
    const userToken = this.crypto.decrypt(connection.userTokenEncrypted);
    const pages = connection.provider === 'WHATSAPP_ESU' ? [] : await this.metaOAuth.fetchUserPages(userToken);
    const created = [];

    for (const item of selection) {
      if (item.platform === 'FACEBOOK') {
        const page = pages.find((p) => p.id === item.id);
        if (!page?.access_token) continue;
        const channel = await this.metaOAuth.connectChannel(orgId, {
          platform: 'FACEBOOK',
          channelIdentifier: page.id,
          name: page.name,
          accessToken: page.access_token,
        });
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: { connectionId, graphVersion: graphVersion(), status: 'PENDING' },
        });
        const fields = await this.subscribePage(page.id, page.access_token);
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: { subscribedFields: fields, status: 'ACTIVE', lastHealthCheckAt: new Date() },
        });
        created.push(channel);
      }
      if (item.platform === 'INSTAGRAM') {
        const page = pages.find((p) => p.instagram_business_account?.id === item.id);
        if (!page?.access_token || !page.instagram_business_account) continue;
        const channel = await this.metaOAuth.connectChannel(orgId, {
          platform: 'INSTAGRAM',
          channelIdentifier: page.instagram_business_account.id,
          name: page.instagram_business_account.username || page.name,
          accessToken: page.access_token,
          metadata: { pageId: page.id, username: page.instagram_business_account.username },
        });
        await this.subscribePage(page.id, page.access_token);
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: {
            connectionId,
            graphVersion: graphVersion(),
            status: 'ACTIVE',
            handle: page.instagram_business_account.username,
            subscribedFields: PAGE_FIELDS.split(','),
          },
        });
        created.push(channel);
      }
      if (item.platform === 'WHATSAPP') {
        const channel = await this.metaOAuth.connectChannel(orgId, {
          platform: 'WHATSAPP',
          channelIdentifier: item.id,
          name: item.name || 'WhatsApp',
          accessToken: userToken,
          metadata: item.wabaId ? { wabaId: item.wabaId } : undefined,
        });
        await this.subscribeWaba(item.wabaId || item.id, userToken);
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: { connectionId, graphVersion: graphVersion(), status: 'ACTIVE' },
        });
        created.push(channel);
      }
    }
    return { connected: created.length, channels: created };
  }

  private async exchangeCode(code: string) {
    const url = new URL(graphUrl('/oauth/access_token'));
    url.searchParams.set('client_id', this.appId());
    url.searchParams.set('client_secret', this.appSecret());
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('code', code);
    const res = await fetch(url);
    const data = await res.json();
    if (!data.access_token) throw new Error(data.error?.message || 'code exchange failed');
    return data.access_token as string;
  }

  private async debugToken(userToken: string) {
    const url = new URL(graphUrl('/debug_token'));
    url.searchParams.set('input_token', userToken);
    url.searchParams.set('access_token', `${this.appId()}|${this.appSecret()}`);
    const res = await fetch(url);
    const json = await res.json();
    const d = json.data || {};
    return {
      scopes: (d.scopes || d.granular_scopes?.map((s: any) => s.scope) || []) as string[],
      expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null,
      dataAccessExpiresAt: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000) : null,
      isValid: !!d.is_valid,
    };
  }

  private async fetchMe(token: string) {
    const proof = appsecretProof(token, this.appSecret());
    const res = await fetch(`${graphUrl('/me')}?fields=id,name&access_token=${encodeURIComponent(token)}&appsecret_proof=${proof}`);
    const data = await res.json();
    if (!data.id) throw new Error(data.error?.message || 'me failed');
    return { id: String(data.id), name: data.name || 'Meta user' };
  }

  private async subscribePage(pageId: string, pageToken: string) {
    const fields = PAGE_FIELDS;
    const res = await fetch(graphUrl(`/${pageId}/subscribed_apps`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed_fields: fields.split(','), access_token: pageToken }),
    });
    if (!res.ok) {
      this.logger.warn(`subscribed_apps failed for page ${pageId}: ${await res.text()}`);
      return [];
    }
    const check = await fetch(`${graphUrl(`/${pageId}/subscribed_apps`)}?access_token=${encodeURIComponent(pageToken)}`);
    if (!check.ok) this.logger.warn(`subscribed_apps verify failed for page ${pageId}`);
    return fields.split(',');
  }

  private async subscribeWaba(wabaOrPhoneId: string, token: string) {
    const res = await fetch(graphUrl(`/${wabaOrPhoneId}/subscribed_apps`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    if (!res.ok) this.logger.warn(`WABA subscribed_apps failed: ${await res.text()}`);
  }

  private async discoverWhatsApp(token: string) {
    const bizRes = await fetch(`${graphUrl('/me/businesses')}?fields=id,name&access_token=${encodeURIComponent(token)}`);
    const bizJson = await bizRes.json();
    const out = [];
    for (const biz of bizJson.data || []) {
      const wabaRes = await fetch(
        `${graphUrl(`/${biz.id}/owned_whatsapp_business_accounts`)}?fields=id,name&access_token=${encodeURIComponent(token)}`,
      );
      const wabaJson = await wabaRes.json();
      for (const waba of wabaJson.data || []) {
        const phonesRes = await fetch(
          `${graphUrl(`/${waba.id}/phone_numbers`)}?fields=id,display_phone_number,verified_name,quality_rating&access_token=${encodeURIComponent(token)}`,
        );
        const phonesJson = await phonesRes.json();
        for (const phone of phonesJson.data || []) {
          out.push({
            platform: 'WHATSAPP',
            id: phone.id,
            name: phone.display_phone_number || phone.verified_name,
            wabaId: waba.id,
            qualityRating: phone.quality_rating,
          });
        }
      }
    }
    return out;
  }

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.healthTimer = setInterval(() => {
      this.runHealthChecks().catch((e) => this.logger.error(`Health cron failed: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  async disconnect(orgId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({ where: { id: channelId, orgId } });
    if (!channel) throw new UnauthorizedException('Channel not found');
    await this.unsubscribe(channel);
    const wiped = this.crypto.encrypt('REVOKED');
    await this.prisma.channel.update({
      where: { id: channel.id },
      data: {
        accessTokenEncrypted: wiped,
        isActive: false,
        status: 'DISCONNECTED',
        subscribedFields: [],
        lastError: { reason: 'user_disconnect' },
      },
    });
    return { ok: true, status: 'DISCONNECTED' };
  }

  async disconnectByMetaUserId(metaUserId: string) {
    const connections = await this.prisma.metaConnection.findMany({ where: { metaUserId } });
    let channels = 0;
    for (const connection of connections) {
      const rows = await this.prisma.channel.findMany({ where: { connectionId: connection.id } });
      for (const channel of rows) {
        await this.unsubscribe(channel);
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: {
            accessTokenEncrypted: this.crypto.encrypt('REVOKED'),
            isActive: false,
            status: 'DISCONNECTED',
            lastError: { reason: 'meta_deauthorize', metaUserId },
          },
        });
        channels += 1;
      }
      await this.prisma.metaConnection.update({
        where: { id: connection.id },
        data: { status: 'REVOKED', userTokenEncrypted: this.crypto.encrypt('REVOKED') },
      });
    }
    return { connections: connections.length, channels };
  }

  async runHealthChecks() {
    const channels = await this.prisma.channel.findMany({
      where: { isActive: true, status: { in: ['ACTIVE', 'NEEDS_REAUTH', 'RATE_LIMITED'] } },
    });
    let checked = 0;
    for (const channel of channels) {
      checked += 1;
      try {
        const token = this.crypto.decrypt(channel.accessTokenEncrypted);
        if (!token || token === 'REVOKED') {
          await this.markNeedsReauth(channel.id, { reason: 'missing_token' });
          continue;
        }
        const debug = await this.debugToken(token);
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: {
            lastHealthCheckAt: new Date(),
            dataAccessExpiresAt: debug.dataAccessExpiresAt,
            tokenExpiresAt: debug.expiresAt,
            status: debug.isValid ? 'ACTIVE' : 'NEEDS_REAUTH',
            lastError: debug.isValid ? undefined : { reason: 'debug_token_invalid' },
          },
        });
        if (debug.dataAccessExpiresAt) {
          const soon = Date.now() + 14 * 24 * 60 * 60 * 1000;
          if (debug.dataAccessExpiresAt.getTime() < soon && debug.isValid) {
            await this.prisma.channel.update({
              where: { id: channel.id },
              data: { lastError: { reason: 'data_access_expiring', at: debug.dataAccessExpiresAt } },
            });
          }
        }
      } catch (err: any) {
        await this.markNeedsReauth(channel.id, { reason: err.message });
      }
    }
    return { checked };
  }

  private async markNeedsReauth(channelId: string, lastError: object) {
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { status: 'NEEDS_REAUTH', lastError, lastHealthCheckAt: new Date() },
    });
  }

  private async unsubscribe(channel: { platform: string; channelIdentifier: string; accessTokenEncrypted: string }) {
    try {
      const token = this.crypto.decrypt(channel.accessTokenEncrypted);
      if (!token || token === 'REVOKED') return;
      await fetch(graphUrl(`/${channel.channelIdentifier}/subscribed_apps`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      });
    } catch (err: any) {
      this.logger.warn(`unsubscribe failed for ${channel.channelIdentifier}: ${err.message}`);
    }
  }
}
