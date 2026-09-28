import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { SuperAdminGuard } from '../auth/superadmin';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';
import { AiProviderService } from '../ai-providers/ai-provider.service';
import { isProvider, isService } from '../ai-providers/ai-providers.types';
import { LlmClient } from '../ai-providers/llm.client';
import { AdminService } from './admin.service';

/** The superadmin dashboard: every workspace, platform AI keys and services. */
@Controller('api/admin')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly providers: AiProviderService,
    private readonly llm: LlmClient,
  ) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('workspaces')
  workspaces(@Query('q') q?: string) {
    return this.admin.workspaces(q);
  }

  @Post('impersonate')
  impersonate(@CurrentUser() user: JwtPayload, @Body() body: { orgId?: string; userId?: string }) {
    return this.admin.impersonate(user, String(body?.orgId || ''), body?.userId || undefined);
  }

  @Get('audit')
  audit() {
    return this.admin.auditLog();
  }

  @Get('ai')
  ai() {
    return this.providers.overview(null);
  }

  @Put('ai/keys/:provider')
  async saveKey(
    @CurrentUser() user: JwtPayload,
    @Param('provider') provider: string,
    @Body() body: { apiKey?: string; model?: string | null },
  ) {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    const result = body?.apiKey
      ? await this.providers.saveKey(null, provider, body.apiKey, body.model)
      : await this.providers.setKeyModel(null, provider, body?.model ?? null);
    await this.admin.audit(user, body?.apiKey ? 'AI_KEY_CONNECT' : 'AI_KEY_MODEL', {
      meta: { provider, model: body?.model || null },
    });
    return result;
  }

  @Delete('ai/keys/:provider')
  async removeKey(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    const result = await this.providers.removeKey(null, provider);
    await this.admin.audit(user, 'AI_KEY_DISCONNECT', { meta: { provider } });
    return result;
  }

  @Post('ai/keys/:provider/test')
  async testKey(@Param('provider') provider: string) {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    const key = await this.providers.keyFor(null, provider);
    if (!key) return { ok: false, error: 'Not connected' };
    return this.llm.testKey(provider, key);
  }

  @Put('ai/services/:service')
  async saveService(
    @CurrentUser() user: JwtPayload,
    @Param('service') service: string,
    @Body() body: { provider?: string; model?: string | null; tenantCanChoose?: boolean },
  ) {
    if (!isService(service)) throw new BadRequestException('Unknown service');
    if (!isProvider(body?.provider)) throw new BadRequestException('Pick a provider');
    const result = await this.providers.saveService(null, service, body);
    await this.admin.audit(user, 'AI_SERVICE', { meta: { service, ...body } });
    return result;
  }
}
