import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { InboxChange, InboxEvents, orgRoom } from './realtime.events';

/**
 * What the rest of the backend uses to announce changes. It only knows org
 * rooms, not sockets, so services never depend on the transport.
 *
 * Call it after the database write has finished: the browser re-reads as soon
 * as it hears the event, and must find the new row.
 *
 * Rooms live in this process's memory. That matches the single backend
 * instance we run; a second instance would need the socket.io Redis adapter.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;

  attach(server: Server) {
    this.server = server;
  }

  inboxChanged(orgId: string, change: Omit<InboxChange, 'at'>) {
    if (!orgId) return;
    // A broadcast must never fail the write that triggered it.
    try {
      this.server
        ?.to(orgRoom(orgId))
        .emit(InboxEvents.changed, { ...change, at: new Date().toISOString() });
    } catch (e) {
      this.logger.warn(`Realtime emit failed for org ${orgId}: ${e?.message || e}`);
    }
  }
}
