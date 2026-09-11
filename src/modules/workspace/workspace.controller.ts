import { Controller, Get, UseGuards } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';

@Controller('api/workspace')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('products')
  products(@CurrentUser() user: JwtPayload) {
    return this.workspace.listProducts(user.orgId);
  }

  @Get('automation-rules')
  automationRules(@CurrentUser() user: JwtPayload) {
    return this.workspace.listAutomationRules(user.orgId);
  }

  @Get('campaigns')
  campaigns(@CurrentUser() user: JwtPayload) {
    return this.workspace.listCampaigns(user.orgId);
  }

  @Get('wallet')
  wallet(@CurrentUser() user: JwtPayload) {
    return this.workspace.getWallet(user.orgId);
  }
}
