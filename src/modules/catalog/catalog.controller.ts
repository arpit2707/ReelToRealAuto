import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';
import {
  CatalogService,
  type OfferingInput,
  type PageProfileInput,
  type ProfileInput,
} from './catalog.service';
import { PostTaggingService } from './post-tagging.service';
import { LeadsService } from './leads.service';
import { ReplyEngineService } from './reply-engine.service';
import { PostAiGateService } from './post-ai-gate.service';
import { DmSpotlightService, type SpotlightInput } from './dm-spotlight.service';

@Controller('api/catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly tagging: PostTaggingService,
    private readonly engine: ReplyEngineService,
    private readonly gate: PostAiGateService,
    private readonly spotlight: DmSpotlightService,
  ) {}

  @Get('profile')
  profile(@CurrentUser() user: JwtPayload) {
    return this.catalog.getProfile(user.orgId);
  }

  @Put('profile')
  @Roles('OWNER', 'ADMIN')
  saveProfile(@CurrentUser() user: JwtPayload, @Body() body: ProfileInput) {
    return this.catalog.saveProfile(user.orgId, body || {});
  }

  /** Turns automation on once the business setup is complete. */
  @Post('profile/activate')
  @Roles('OWNER', 'ADMIN')
  activate(@CurrentUser() user: JwtPayload) {
    return this.catalog.activate(user.orgId);
  }

  @Post('profile/deactivate')
  @Roles('OWNER', 'ADMIN')
  deactivate(@CurrentUser() user: JwtPayload) {
    return this.catalog.deactivate(user.orgId);
  }

  @Get('offerings')
  offerings(@CurrentUser() user: JwtPayload, @Query('all') all?: string) {
    return this.catalog.listOfferings(user.orgId, {
      includeInactive: all === '1' || all === 'true',
    });
  }

  @Post('offerings')
  @Roles('OWNER', 'ADMIN')
  create(@CurrentUser() user: JwtPayload, @Body() body: OfferingInput) {
    return this.catalog.createOffering(user.orgId, body);
  }

  @Put('offerings/:id')
  @Roles('OWNER', 'ADMIN')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: OfferingInput,
  ) {
    return this.catalog.updateOffering(user.orgId, id, body);
  }

  @Delete('offerings/:id')
  @Roles('OWNER', 'ADMIN')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.catalog.deleteOffering(user.orgId, id);
  }

  @Post('import/csv')
  @Roles('OWNER', 'ADMIN')
  importCsv(@CurrentUser() user: JwtPayload, @Body() body: { csv?: string }) {
    return this.catalog.importCsv(user.orgId, body?.csv || '');
  }

  @Post('sync/shopify')
  @Roles('OWNER', 'ADMIN')
  syncShopify(@CurrentUser() user: JwtPayload) {
    return this.catalog.syncShopify(user.orgId);
  }

  @Get('offerings/:id/blocked-dates')
  blocked(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.catalog.listBlockedDates(user.orgId, id);
  }

  @Put('offerings/:id/blocked-dates/:date')
  @Roles('OWNER', 'ADMIN')
  block(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('date') date: string,
    @Body() body: { booked?: number | null; note?: string },
  ) {
    return this.catalog.setBlockedDate(
      user.orgId,
      id,
      date,
      body?.booked ?? null,
      body?.note,
    );
  }

  @Delete('offerings/:id/blocked-dates/:date')
  @Roles('OWNER', 'ADMIN')
  unblock(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('date') date: string,
  ) {
    return this.catalog.clearBlockedDate(user.orgId, id, date);
  }

  // ai=on|off|untagged|needs_context narrows the list.
  @Get('post-tags')
  postTags(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('ai') ai?: string,
  ) {
    return this.tagging.listLinks(user.orgId, status || undefined, ai || undefined);
  }

  @Post('post-tags/run')
  @Roles('OWNER', 'ADMIN')
  runTagging(@CurrentUser() user: JwtPayload) {
    return this.tagging.run(user.orgId);
  }

  @Post('post-tags')
  @Roles('OWNER', 'ADMIN')
  addTag(
    @CurrentUser() user: JwtPayload,
    @Body()
    body: {
      postId: string;
      platform: string;
      offeringId: string;
      caption?: string;
      mediaUrl?: string;
      permalink?: string;
    },
  ) {
    return this.tagging.addLink(user.orgId, body);
  }

  @Put('post-tags/:id')
  @Roles('OWNER', 'ADMIN')
  setTag(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: { status: string },
  ) {
    return this.tagging.setStatus(user.orgId, id, body?.status);
  }

  /** Every post of a page, 10 at a time from Meta, with its note, items and AI switch. */
  @Get('posts')
  browsePosts(
    @CurrentUser() user: JwtPayload,
    @Query('channelId') channelId?: string,
    @Query('after') after?: string,
    @Query('before') before?: string,
  ) {
    return this.tagging.browsePosts(user.orgId, {
      channelId: channelId || undefined,
      after: after || undefined,
      before: before || undefined,
    });
  }

  /** The post's AI switch. Turning it on needs a confirmed item or a note. */
  @Put('posts/:postId/ai')
  @Roles('OWNER', 'ADMIN')
  setPostAi(
    @CurrentUser() user: JwtPayload,
    @Param('postId') postId: string,
    @Body() body: { enabled?: boolean },
  ) {
    return this.gate.setPostAi(user.orgId, postId, body?.enabled === true, user.sub);
  }

  @Put('posts/:postId/note')
  @Roles('OWNER', 'ADMIN')
  setPostNote(
    @CurrentUser() user: JwtPayload,
    @Param('postId') postId: string,
    @Body()
    body: {
      note?: string | null;
      platform?: string;
      channelId?: string | null;
      caption?: string | null;
      mediaUrl?: string | null;
      permalink?: string | null;
    },
  ) {
    return this.tagging.setNote(user.orgId, postId, body || {});
  }

  @Get('pages')
  pages(@CurrentUser() user: JwtPayload) {
    return this.catalog.listPageProfiles(user.orgId);
  }

  @Put('pages/:channelId')
  @Roles('OWNER', 'ADMIN')
  savePage(
    @CurrentUser() user: JwtPayload,
    @Param('channelId') channelId: string,
    @Body() body: PageProfileInput,
  ) {
    return this.catalog.savePageProfile(user.orgId, channelId, body || {});
  }

  /** Posts highlighted in plain DMs on this page, with their live status. */
  @Get('pages/:channelId/spotlight')
  pageSpotlight(
    @CurrentUser() user: JwtPayload,
    @Param('channelId') channelId: string,
  ) {
    return this.spotlight.list(user.orgId, channelId);
  }

  /** Replaces the page's whole Spotlight list (max 5, AI-on posts only). */
  @Put('pages/:channelId/spotlight')
  @Roles('OWNER', 'ADMIN')
  savePageSpotlight(
    @CurrentUser() user: JwtPayload,
    @Param('channelId') channelId: string,
    @Body() body: { posts?: SpotlightInput[] },
  ) {
    return this.spotlight.replace(user.orgId, channelId, body?.posts || []);
  }

  @Get('ad-picks')
  adPicks(@CurrentUser() user: JwtPayload) {
    return this.tagging.adPicks(user.orgId);
  }

  /** Try the AI on a sample message without sending anything to anyone. */
  @Post('preview-reply')
  preview(
    @CurrentUser() user: JwtPayload,
    @Body()
    body: {
      text: string;
      postId?: string;
      channelId?: string;
      eventType?: 'comment' | 'dm';
    },
  ) {
    return this.engine.reply({
      orgId: user.orgId,
      brandName: 'Preview',
      platform: 'INSTAGRAM',
      eventType: body?.eventType === 'dm' ? 'dm' : 'comment',
      text: body?.text || '',
      senderId: 'preview',
      postId: body?.postId || null,
      channelId: body?.channelId || null,
      preview: true,
    }, { preview: true });
  }
}

@Controller('api/leads')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query('status') status?: string) {
    return this.leads.list(user.orgId, status || undefined);
  }

  @Put(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: { status?: string; notes?: string | null },
  ) {
    return this.leads.update(user.orgId, id, body || {});
  }
}
