import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';
import { ChannelConnectService } from './channel-connect.service';

@Controller('api/channels')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChannelConnectController {
  constructor(private readonly connect: ChannelConnectService) {}

  @Get('oauth/:provider/start')
  @Roles('OWNER', 'ADMIN')
  async start(@Param('provider') provider: string, @CurrentUser() user: JwtPayload) {
    const p = provider === 'whatsapp' || provider === 'instagram' ? provider : 'facebook';
    const url = await this.connect.createStartUrl(p, user.orgId, user.sub);
    return { url };
  }

  @Get('assets')
  @Roles('OWNER', 'ADMIN')
  listAssets(@CurrentUser() user: JwtPayload, @Query('connectionId') connectionId: string) {
    return this.connect.listAssets(user.orgId, connectionId);
  }

  @Post('confirm')
  @Roles('OWNER', 'ADMIN')
  confirm(
    @CurrentUser() user: JwtPayload,
    @Body()
    body: {
      connectionId: string;
      selection: Array<{ platform: 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP'; id: string; name?: string; wabaId?: string }>;
    },
  ) {
    return this.connect.confirmAssets(user.orgId, body.connectionId, body.selection || []);
  }

  @Post('health-check')
  @Roles('OWNER', 'ADMIN')
  healthCheck() {
    return this.connect.runHealthChecks();
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  disconnect(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.connect.disconnect(user.orgId, id);
  }
}
