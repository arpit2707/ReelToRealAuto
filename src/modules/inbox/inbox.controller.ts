import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InboxService } from './inbox.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';

@Controller('api/inbox')
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get('channels')
  listChannels(@CurrentUser() user: JwtPayload) {
    return this.inbox.listChannels(user.orgId);
  }

  @Get('threads')
  listThreads(@CurrentUser() user: JwtPayload, @Query('platform') platform = 'WHATSAPP') {
    return this.inbox.listThreads(user.orgId, platform);
  }

  @Get('threads/:senderId/messages')
  listMessages(
    @CurrentUser() user: JwtPayload,
    @Param('senderId') senderId: string,
    @Query('platform') platform = 'WHATSAPP',
  ) {
    return this.inbox.listMessages(user.orgId, platform, senderId);
  }

  @Post('threads/:senderId/reply')
  reply(
    @CurrentUser() user: JwtPayload,
    @Param('senderId') senderId: string,
    @Body() body: { platform: string; text: string },
  ) {
    return this.inbox.reply(user, body.platform || 'WHATSAPP', senderId, body.text);
  }
}
