import { Controller, Post, Get, Body, Query, HttpStatus, HttpException } from '@nestjs/common';
import { MetaOAuthService } from './meta-oauth.service';

@Controller('api/meta')
export class MetaOAuthController {
  constructor(private readonly metaOAuth: MetaOAuthService) {}

  @Post('exchange-token')
  async exchangeToken(@Body('short_lived_token') token: string) {
    if (!token) {
      throw new HttpException('short_lived_token is required', HttpStatus.BAD_REQUEST);
    }
    const longLived = await this.metaOAuth.exchangeForLongLivedToken(token);
    return { long_lived_token: longLived };
  }

  @Post('list-pages')
  async listPages(@Body('user_token') token: string) {
    if (!token) {
      throw new HttpException('user_token is required', HttpStatus.BAD_REQUEST);
    }
    const pages = await this.metaOAuth.fetchUserPages(token);
    return { pages };
  }

  @Post('connect-channel')
  async connectChannel(
    @Body('org_id') orgId: string,
    @Body('channel')
    channel: {
      platform: 'INSTAGRAM' | 'FACEBOOK' | 'WHATSAPP';
      channelIdentifier: string;
      name: string;
      accessToken: string;
    },
  ) {
    if (!orgId || !channel) {
      throw new HttpException('org_id and channel payload required', HttpStatus.BAD_REQUEST);
    }
    const connected = await this.metaOAuth.connectChannel(orgId, channel);
    return { status: 'success', channel: connected };
  }

  @Get('channels')
  async getChannels(@Query('org_id') orgId: string) {
    if (!orgId) {
      return { channels: [] };
    }
    const channels = await this.metaOAuth.listChannels(orgId);
    return { channels };
  }
}
