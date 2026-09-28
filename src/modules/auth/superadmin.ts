import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { JwtPayload } from './jwt';

/** Superadmins are the emails listed in SUPERADMIN_EMAILS (comma separated). */
export function isSuperAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return String(process.env.SUPERADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

/** A superadmin session of their own; never a "login as user" session. */
export function isSuperAdmin(user?: JwtPayload | null): boolean {
  return Boolean(user && !user.imp && isSuperAdminEmail(user.email));
}

/** Runs after JwtAuthGuard. */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!isSuperAdmin(context.switchToHttp().getRequest().user)) {
      throw new ForbiddenException('Superadmin only');
    }
    return true;
  }
}
