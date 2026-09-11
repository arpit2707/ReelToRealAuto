import { Controller, Post, Get, Body, Query, HttpStatus, HttpException, UseGuards } from '@nestjs/common';
import { MetaOAuthService } from './meta-oauth.service';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';

@Controller('api/meta')
@UseGuards(JwtAuthGuard, RolesGuard)
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
  @Roles('OWNER', 'ADMIN')
  async connectChannel(
    @CurrentUser() user: JwtPayload,
    @Body('channel')
    channel: {
      platform: 'INSTAGRAM' | 'FACEBOOK' | 'WHATSAPP';
      channelIdentifier: string;
      name: string;
      accessToken: string;
      permissions?: string[];
    },
  ) {
    if (!channel) {
      throw new HttpException('channel payload required', HttpStatus.BAD_REQUEST);
    }
    const connected = await this.metaOAuth.connectChannel(user.orgId, channel);
    return { status: 'success', channel: connected };
  }

  @Get('channels')
  async getChannels(@CurrentUser() user: JwtPayload) {
    const channels = await this.metaOAuth.listChannels(user.orgId);
    return { channels };
  }

  @Get('health-audit')
  async auditHealth(@CurrentUser() user: JwtPayload) {
    return this.metaOAuth.auditChannelsHealth(user.orgId);
  }
}
