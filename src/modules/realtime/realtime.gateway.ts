import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { verifyAuthToken, type JwtPayload } from '../auth/jwt';
import { allowedOrigins } from '../../common/origins';
import { RealtimeService } from './realtime.service';
import { orgRoom, REALTIME_PATH } from './realtime.events';

// Served under /api so the existing /api proxies (nginx, Next rewrites) reach
// it without new routes; nginx's /api block already forwards Upgrade headers.
@WebSocketGateway({
  path: REALTIME_PATH,
  // Next.js 308-redirects "/api/realtime/" to drop the slash, so the socket
  // path must not end in one (the client sets the same option).
  addTrailingSlash: false,
  cors: { origin: allowedOrigins(), credentials: true },
  pingInterval: 25_000,
  pingTimeout: 20_000,
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly expiry = new Map<string, NodeJS.Timeout>();

  constructor(private readonly realtime: RealtimeService) {}

  afterInit(server: Server) {
    // Reject before the connection is accepted, so a bad token never joins a
    // room. The client sees the message in connect_error.
    server.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) {
        return next(new Error('unauthorized'));
      }
      try {
        socket.data.user = verifyAuthToken(token);
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
    this.realtime.attach(server);
  }

  handleConnection(socket: Socket) {
    const user = socket.data.user as (JwtPayload & { exp?: number }) | undefined;
    if (!user?.orgId) {
      socket.disconnect(true);
      return;
    }
    socket.join(orgRoom(user.orgId));

    // Access tokens live 15 minutes. Drop the socket when its token expires so
    // a revoked user does not keep receiving events; the client reconnects
    // with a refreshed token and catches up from REST.
    if (user.exp) {
      const ms = user.exp * 1000 - Date.now();
      this.expiry.set(
        socket.id,
        setTimeout(() => {
          socket.emit('auth:expired');
          socket.disconnect(true);
        }, Math.max(ms, 0)),
      );
    }
  }

  handleDisconnect(socket: Socket) {
    const timer = this.expiry.get(socket.id);
    if (timer) clearTimeout(timer);
    this.expiry.delete(socket.id);
  }
}
