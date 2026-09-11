import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { hashOpaqueToken, signAuthToken, type JwtPayload } from './jwt';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  private slugify(input: string) {
    return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `org-${Date.now()}`;
  }

  async register(email: string, password: string, name?: string, orgName?: string) {
    const existing = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) throw new ConflictException('Email already registered');
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        name: name || email.split('@')[0],
        authProvider: 'PASSWORD',
      },
    });
    const slug = this.slugify(orgName || `${user.name}-workspace`);
    const org = await this.prisma.organization.create({
      data: {
        name: orgName || `${user.name}'s workspace`,
        slug: `${slug}-${user.id.slice(0, 6)}`,
        members: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    return this.issueSession(user.id, org.id, 'OWNER', user.email);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user?.passwordHash) throw new UnauthorizedException('Invalid email or password');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid email or password');
    const membership = await this.prisma.organizationMember.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new UnauthorizedException('No workspace for this account');
    return this.issueSession(user.id, membership.orgId, membership.role, user.email);
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashOpaqueToken(refreshToken);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token invalid');
    }
    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    const membership = await this.prisma.organizationMember.findFirst({ where: { userId: row.userId } });
    if (!user || !membership) throw new UnauthorizedException('Session expired');
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return this.issueSession(user.id, membership.orgId, membership.role, user.email);
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) return { ok: true };
    const tokenHash = hashOpaqueToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async me(payload: JwtPayload) {
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId: payload.sub, orgId: payload.orgId },
      include: { user: true, org: true },
    });
    if (!member) throw new UnauthorizedException('Not a member of this workspace');
    const channels = await this.prisma.channel.findMany({
      where: { orgId: payload.orgId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      user: {
        id: member.user.id,
        email: member.user.email,
        name: member.user.name,
        avatarUrl: member.user.avatarUrl,
        authProvider: member.user.authProvider,
      },
      orgId: member.orgId,
      orgName: member.org.name,
      role: member.role,
      channels: channels.map((c) => ({
        id: c.id,
        platform: c.platform,
        channelIdentifier: c.channelIdentifier,
        name: c.name,
        status: c.status,
        isActive: c.isActive,
      })),
    };
  }

  private async issueSession(userId: string, orgId: string, role: string, email: string) {
    const accessToken = signAuthToken({ sub: userId, orgId, role, email });
    const refreshToken = crypto.randomBytes(32).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashOpaqueToken(refreshToken),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });
    return { accessToken, refreshToken, expiresIn: 15 * 60 };
  }
}
