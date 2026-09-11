import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ChannelConnectService } from '../channels/channel-connect.service';
import { parseFacebookSignedRequest } from '../../common/hmac';

@Controller()
export class MetaComplianceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelConnectService,
  ) {}

  @Post('auth/facebook/deauthorize')
  async deauthorize(@Body() body: { signed_request?: string }) {
    const userId = this.userIdFrom(body?.signed_request);
    if (!userId) return { ok: false };
    await this.channels.disconnectByMetaUserId(userId);
    return { ok: true };
  }

  @Post('auth/facebook/data-deletion')
  async dataDeletion(@Body() body: { signed_request?: string }) {
    const userId = this.userIdFrom(body?.signed_request);
    const confirmationCode = crypto.randomBytes(12).toString('hex');
    if (userId) {
      await this.channels.disconnectByMetaUserId(userId);
    }
    await this.prisma.dataDeletionRequest.create({
      data: {
        confirmationCode,
        metaUserId: userId,
        status: 'completed',
        completedAt: new Date(),
      },
    });
    const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:5002').replace(/\/$/, '');
    return {
      url: `${base}/auth/facebook/data-deletion/${confirmationCode}`,
      confirmation_code: confirmationCode,
    };
  }

  @Get('auth/facebook/data-deletion/:code')
  async dataDeletionStatus(@Param('code') code: string) {
    const row = await this.prisma.dataDeletionRequest.findUnique({ where: { confirmationCode: code } });
    if (!row) return { status: 'unknown' };
    return { confirmation_code: row.confirmationCode, status: row.status, completed_at: row.completedAt };
  }

  private userIdFrom(signedRequest?: string): string | undefined {
    const secret = process.env.META_APP_SECRET || '';
    if (!signedRequest || !secret) return undefined;
    const parsed = parseFacebookSignedRequest(signedRequest, secret);
    const id = parsed?.user_id;
    return id != null ? String(id) : undefined;
  }
}
