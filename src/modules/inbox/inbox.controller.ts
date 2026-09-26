import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InboxService } from './inbox.service';
import { InboxSyncService } from './inbox-sync.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';

@Controller('api/inbox')
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly sync: InboxSyncService,
  ) {}

  @Get('channels')
  listChannels(@CurrentUser() user: JwtPayload) {
    return this.inbox.listChannels(user.orgId);
  }

  // Pulls existing Messenger / Instagram chats from Meta into the inbox.
  @Post('sync')
  syncFromMeta(@CurrentUser() user: JwtPayload, @Query('platform') platform?: string) {
    return this.sync.syncOrg(user.orgId, platform);
  }

  @Get('activity')
  activity(@CurrentUser() user: JwtPayload) {
    return this.inbox.listActivity(user.orgId);
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
