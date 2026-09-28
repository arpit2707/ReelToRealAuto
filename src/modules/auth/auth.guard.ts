import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { verifyAuthToken } from './jwt';
import { isSuperAdminEmail } from './superadmin';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Login required');
    }
    let user;
    try {
      user = verifyAuthToken(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
    // A "login as user" session ends as soon as its superadmin loses the role.
    if (user.imp && !isSuperAdminEmail(user.imp.email)) {
      throw new UnauthorizedException('Superadmin session ended');
    }
    req.user = user;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest().user;
    if (!user?.role || !roles.includes(user.role)) {
      throw new ForbiddenException('OWNER or ADMIN role required');
    }
    return true;
  }
}
