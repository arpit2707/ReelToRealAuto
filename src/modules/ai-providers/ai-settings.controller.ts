import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';
import { AiProviderService } from './ai-provider.service';
import { isProvider, isService } from './ai-providers.types';
import { LlmClient } from './llm.client';

/** A workspace's own AI keys, for the services the superadmin lets tenants choose. */
@Controller('api/ai-settings')
@UseGuards(JwtAuthGuard)
export class AiSettingsController {
  constructor(
    private readonly providers: AiProviderService,
    private readonly llm: LlmClient,
  ) {}

  @Get()
  overview(@CurrentUser() user: JwtPayload) {
    return this.providers.overview(user.orgId);
  }

  @Put('keys/:provider')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  saveKey(
    @CurrentUser() user: JwtPayload,
    @Param('provider') provider: string,
    @Body() body: { apiKey?: string; model?: string | null },
  ) {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    if (body?.apiKey) return this.providers.saveKey(user.orgId, provider, body.apiKey, body.model);
    return this.providers.setKeyModel(user.orgId, provider, body?.model ?? null);
  }

  @Delete('keys/:provider')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  removeKey(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    return this.providers.removeKey(user.orgId, provider);
  }

  @Post('keys/:provider/test')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  async testKey(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    const key = await this.providers.keyFor(user.orgId, provider);
    if (!key) return { ok: false, error: 'Not connected' };
    return this.llm.testKey(provider, key);
  }

  @Put('services/:service')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  saveService(
    @CurrentUser() user: JwtPayload,
    @Param('service') service: string,
    @Body() body: { provider?: string | null; model?: string | null },
  ) {
    if (!isService(service)) throw new BadRequestException('Unknown service');
    return this.providers.saveService(user.orgId, service, { provider: body?.provider, model: body?.model });
  }
}
