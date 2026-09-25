import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
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
   * Called once a day by the scheduled GitHub Action. Answers at once and keeps
   * working in the background, since generating images for every org is slow.
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

  /** Public, signed image URLs that WhatsApp and Instagram fetch. */
  @Get('media/:optionId/:variant/:signature')
  async media(
    @Param('optionId') optionId: string,
    @Param('variant') variant: string,
    @Param('signature') signature: string,
    @Res() res: Response,
  ) {
    const image = await this.stories.getMedia(optionId, variant, signature);
    res.setHeader('Content-Type', 'image/jpeg');
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
      businessDescription?: string | null;
      keywordDatabase?: string;
    },
  ) {
    return this.stories.updateSettings(user.orgId, body || {});
  }

  @Get('batches')
  @UseGuards(JwtAuthGuard)
  batches(@CurrentUser() user: JwtPayload) {
    return this.stories.listBatches(user.orgId);
  }

  /** Generates today's ideas right away (replacing today's batch) so a merchant can try it. */
  @Post('run-now')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  runNow(@CurrentUser() user: JwtPayload) {
    setImmediate(() => {
      this.stories
        .generateBatch(user.orgId, { force: true })
        .catch((e) => this.logger.error(`Run-now failed for org ${user.orgId}: ${e.message}`));
    });
    return { accepted: true };
  }
}
