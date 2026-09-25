import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { CommerceService } from './commerce.service';
import type { StoreSettingsInput } from './commerce.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from '../auth/jwt';

@Controller('api/commerce')
@UseGuards(JwtAuthGuard)
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Get('orders')
  orders(
    @CurrentUser() user: JwtPayload,
    @Query('codStatus') codStatus?: string,
    @Query('limit') limit?: string,
  ) {
    return this.commerce.listOrders(user.orgId, codStatus || undefined, Number(limit) || 50);
  }

  @Get('carts')
  carts(@CurrentUser() user: JwtPayload, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.commerce.listCarts(user.orgId, status || undefined, Number(limit) || 50);
  }

  @Get('stats')
  stats(@CurrentUser() user: JwtPayload, @Query('days') days?: string) {
    return this.commerce.stats(user.orgId, Number(days) || 30);
  }

  @Get('settings')
  settings(@CurrentUser() user: JwtPayload) {
    return this.commerce.getSettings(user.orgId);
  }

  @Patch('settings')
  updateSettings(@CurrentUser() user: JwtPayload, @Body() body: StoreSettingsInput) {
    return this.commerce.updateSettings(user.orgId, body || {});
  }
}
