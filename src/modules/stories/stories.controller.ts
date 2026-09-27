import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';
import { timingSafeEqualString } from '../../common/hmac';
import { StoriesService } from './stories.service';

@Controller('api/stories')
export class StoriesController {
  private readonly logger = new Logger(StoriesController.name);

  constructor(private readonly stories: StoriesService) {}

  /**
   * Called every 15 minutes by the scheduled GitHub Action: sends ideas to orgs
   * whose send time has passed and publishes picks that are due. Answers at once
   * and keeps working in the background, since generating images is slow.
   */
  @Post('cron/daily')
  @HttpCode(202)
  daily(@Headers('authorization') authorization?: string) {
    const secret = process.env.STORY_CRON_SECRET;
    if (!secret || !timingSafeEqualString(String(authorization || ''), `Bearer ${secret}`)) {
      throw new UnauthorizedException();
    }
    setImmediate(() => {
      this.stories
        .runDaily()
        .then((r) => this.logger.log(`Daily stories run finished: ${JSON.stringify(r)}`))
        .catch((e) => this.logger.error(`Daily stories run crashed: ${e.message}`));
    });
    return { accepted: true };
  }

  /** Public, signed image (and Reel video) URLs that WhatsApp and Instagram fetch. */
  @Get('media/:optionId/:variant/:signature')
  async media(
    @Param('optionId') optionId: string,
    @Param('variant') variant: string,
    @Param('signature') signature: string,
    @Res() res: Response,
  ) {
    const image = await this.stories.getMedia(optionId, variant, signature);
    res.setHeader('Content-Type', variant === 'reel' ? 'video/mp4' : 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(image);
  }

  @Get('settings')
  @UseGuards(JwtAuthGuard)
  settings(@CurrentUser() user: JwtPayload) {
    return this.stories.getSettings(user.orgId);
  }

  @Put('settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  updateSettings(
    @CurrentUser() user: JwtPayload,
    @Body()
    body: {
      enabled?: boolean;
      whatsappNumber?: string | null;
      instagramChannelId?: string | null;
      facebookChannelId?: string | null;
      businessDescription?: string | null;
      keywordDatabase?: string;
      sendTime?: string;
      postTime?: string;
      optionCount?: number;
      destinations?: string[];
      nicheKeywords?: string[];
    },
  ) {
    return this.stories.updateSettings(user.orgId, body || {});
  }

  @Get('batches')
  @UseGuards(JwtAuthGuard)
  batches(@CurrentUser() user: JwtPayload) {
    return this.stories.listBatches(user.orgId);
  }

  /** Scheduled posts, soonest first. */
  @Get('upcoming')
  @UseGuards(JwtAuthGuard)
  upcoming(@CurrentUser() user: JwtPayload) {
    return this.stories.listUpcoming(user.orgId);
  }

  @Post('batches/:id/options/:position/pick')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  pick(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('position', ParseIntPipe) position: number,
    @Body() body: { when?: 'now' | 'tomorrow' | 'scheduled'; at?: string | null },
  ) {
    return this.stories.pickFromDashboard(user.orgId, id, position, body || {});
  }

  @Post('batches/:id/options/:position/edit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  edit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('position', ParseIntPipe) position: number,
    @Body() body: { instruction?: string },
  ) {
    return this.stories.editFromDashboard(user.orgId, id, position, body?.instruction || '');
  }

  @Put('batches/:id/options/:position/caption')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  caption(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('position', ParseIntPipe) position: number,
    @Body() body: { caption?: string | null },
  ) {
    return this.stories.setCaption(user.orgId, id, position, body?.caption ?? null);
  }

  @Post('batches/:id/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.stories.cancelFromDashboard(user.orgId, id);
  }

  /** The seller's own photo, posted as it is; `at` schedules it. */
  @Post('own')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  own(
    @CurrentUser() user: JwtPayload,
    @Body() body: { image?: string; caption?: string | null; at?: string | null },
  ) {
    return this.stories.uploadOwnPost(user.orgId, body || {});
  }

  /**
   * Generates today's ideas right away (replacing today's batch). `via: "web"`
   * only makes them for picking in the dashboard; otherwise they also go to
   * WhatsApp when a number is set. Refused when today's pick is scheduled or
   * already posted.
   */
  @Post('run-now')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  async runNow(@CurrentUser() user: JwtPayload, @Body() body: { via?: 'whatsapp' | 'web' } = {}) {
    await this.stories.assertCanRegenerate(user.orgId);
    const settings = await this.stories.getSettings(user.orgId);
    const via = body?.via === 'web' || !settings.whatsappNumber ? 'web' : 'whatsapp';
    setImmediate(() => {
      this.stories
        .generateBatch(user.orgId, { force: true, via })
        .catch((e) => this.logger.error(`Run-now failed for org ${user.orgId}: ${e.message}`));
    });
    return { accepted: true, via };
  }
}
