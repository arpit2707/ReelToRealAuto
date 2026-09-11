import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import type { JwtPayload } from './jwt';
import { ChannelConnectService } from '../channels/channel-connect.service';

function refreshFrom(req: Request, body?: { refreshToken?: string }) {
  const cookie = String(req.headers.cookie || '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('r2r_refresh='));
  return body?.refreshToken || (cookie ? decodeURIComponent(cookie.split('=')[1]) : undefined);
}

function setRefreshCookie(res: Response, token: string) {
  res.setHeader(
    'Set-Cookie',
    `r2r_refresh=${token}; HttpOnly; Path=/; Max-Age=${14 * 24 * 3600}; SameSite=Lax`,
  );
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly channels: ChannelConnectService,
  ) {}

  @Post('register')
  async register(
    @Body() body: { email: string; password: string; name?: string; orgName?: string },
    @Res() res: Response,
  ) {
    if (!body?.email || !body?.password) throw new UnauthorizedException('email and password required');
    const session = await this.auth.register(body.email, body.password, body.name, body.orgName);
    setRefreshCookie(res, session.refreshToken);
    return res.json({ accessToken: session.accessToken, expiresIn: session.expiresIn });
  }

  @Post('login')
  async login(@Body() body: { email: string; password: string }, @Res() res: Response) {
    const session = await this.auth.login(body.email, body.password);
    setRefreshCookie(res, session.refreshToken);
    return res.json({ accessToken: session.accessToken, expiresIn: session.expiresIn });
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Body() body: { refreshToken?: string }, @Res() res: Response) {
    const token = refreshFrom(req, body);
    if (!token) throw new UnauthorizedException('No refresh token');
    const session = await this.auth.refresh(token);
    setRefreshCookie(res, session.refreshToken);
    return res.json({ accessToken: session.accessToken, expiresIn: session.expiresIn });
  }

  @Post('logout')
  async logout(@Req() req: Request, @Body() body: { refreshToken?: string }, @Res() res: Response) {
    await this.auth.logout(refreshFrom(req, body));
    res.setHeader('Set-Cookie', 'r2r_refresh=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return res.json({ ok: true });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: JwtPayload) {
    return this.auth.me(user);
  }

  @Get('meta/callback')
  async metaCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    return res.redirect(await this.channels.handleCallback(code, state));
  }

  @Get(':provider/callback')
  async providerCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    return res.redirect(await this.channels.handleCallback(code, state));
  }
}
