import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { IMPERSONATION_SECONDS, signImpersonationToken, type JwtPayload } from '../auth/jwt';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [workspaces, users, channels, newWorkspaces, leads] = await Promise.all([
      this.prisma.organization.count(),
      this.prisma.user.count(),
      this.prisma.channel.count({ where: { status: { not: 'DISCONNECTED' } } }),
      this.prisma.organization.count({ where: { createdAt: { gte: since } } }),
      this.prisma.lead.count({ where: { createdAt: { gte: since } } }),
    ]);
    return { workspaces, users, channels, newWorkspaces, leadsThisWeek: leads };
  }

  /** Every workspace with its people and connected channels, newest first. */
  async workspaces(q?: string) {
    const term = String(q || '')
      .trim()
      .slice(0, 100);
    const rows = await this.prisma.organization.findMany({
      where: term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { slug: { contains: term, mode: 'insensitive' } },
              { members: { some: { user: { email: { contains: term, mode: 'insensitive' } } } } },
              { members: { some: { user: { name: { contains: term, mode: 'insensitive' } } } } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        members: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, email: true, name: true, createdAt: true } } },
        },
        channels: {
          where: { status: { not: 'DISCONNECTED' } },
          select: { platform: true, name: true, channelIdentifier: true },
        },
        _count: { select: { conversations: true, leads: true, offerings: true } },
      },
    });
    return rows.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      createdAt: o.createdAt,
      members: o.members.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
      })),
      channels: o.channels,
      counts: o._count,
    }));
  }

  /**
   * A one-hour session as a workspace member (its owner unless a user is
   * named). It is never refreshed, and every use is in the audit log.
   */
  async impersonate(admin: JwtPayload, orgId: string, userId?: string) {
    if (!orgId) throw new BadRequestException('orgId is required');
    const members = await this.prisma.organizationMember.findMany({
      where: { orgId, ...(userId ? { userId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: { user: true, org: { select: { name: true } } },
    });
    const member = members.find((m) => m.role === 'OWNER') || members[0];
    if (!member) throw new NotFoundException('No such member in this workspace');
    const accessToken = signImpersonationToken({
      sub: member.userId,
      orgId,
      role: member.role,
      email: member.user.email,
      imp: { sub: admin.sub, email: admin.email },
    });
    await this.audit(admin, 'IMPERSONATE', { targetOrgId: orgId, targetUserId: member.userId });
    return {
      accessToken,
      expiresIn: IMPERSONATION_SECONDS,
      user: { id: member.userId, email: member.user.email, name: member.user.name },
      org: { id: orgId, name: member.org.name },
    };
  }

  async audit(
    admin: JwtPayload,
    action: string,
    extra: { targetOrgId?: string | null; targetUserId?: string | null; meta?: Record<string, unknown> } = {},
  ) {
    await this.prisma.adminAuditLog.create({
      data: {
        actorUserId: admin.sub,
        actorEmail: admin.email,
        action,
        targetOrgId: extra.targetOrgId ?? null,
        targetUserId: extra.targetUserId ?? null,
        meta: (extra.meta ?? undefined) as any,
      },
    });
  }

  auditLog(take = 100) {
    return this.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(take, 200) });
  }
}
