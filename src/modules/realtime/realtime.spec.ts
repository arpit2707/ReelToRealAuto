import * as jwt from 'jsonwebtoken';
import { RealtimeService } from './realtime.service';
import { RealtimeGateway } from './realtime.gateway';
import { ConversationService } from '../conversations/conversation.service';
import { InboxEvents, orgRoom } from './realtime.events';

process.env.JWT_SECRET = 'test-secret';

function fakeServer() {
  const emit = jest.fn();
  const to = jest.fn(() => ({ emit }));
  const use = jest.fn();
  return { server: { to, use } as any, to, emit, use };
}

describe('RealtimeService', () => {
  it('emits only to the org room', () => {
    const { server, to, emit } = fakeServer();
    const svc = new RealtimeService();
    svc.attach(server);
    svc.inboxChanged('org1', { kind: 'message', conversationId: 'c1' });
    expect(to).toHaveBeenCalledWith(orgRoom('org1'));
    expect(emit).toHaveBeenCalledWith(
      InboxEvents.changed,
      expect.objectContaining({ kind: 'message', conversationId: 'c1' }),
    );
  });

  it('never throws, even before the socket server exists or when it fails', () => {
    const svc = new RealtimeService();
    expect(() => svc.inboxChanged('org1', { kind: 'message' })).not.toThrow();
    svc.attach({
      to: () => {
        throw new Error('boom');
      },
    } as any);
    expect(() => svc.inboxChanged('org1', { kind: 'message' })).not.toThrow();
  });
});

describe('RealtimeGateway auth', () => {
  function handshake(token?: unknown) {
    const { server, use } = fakeServer();
    new RealtimeGateway(new RealtimeService()).afterInit(server);
    const middleware = use.mock.calls[0][0];
    const socket: any = { handshake: { auth: { token } }, data: {} };
    const next = jest.fn();
    middleware(socket, next);
    return { socket, next };
  }

  it('accepts a valid token and keeps the user on the socket', () => {
    const token = jwt.sign({ sub: 'u1', orgId: 'org1', role: 'OWNER', email: 'a@b.c' }, 'test-secret');
    const { socket, next } = handshake(token);
    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user.orgId).toBe('org1');
  });

  it.each([undefined, '', 'garbage', jwt.sign({ orgId: 'org1' }, 'wrong-secret')])(
    'rejects %p',
    (token) => {
      const { next } = handshake(token);
      expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(next.mock.calls[0][0].message).toBe('unauthorized');
    },
  );

  it('joins the org room and drops the socket when the token expires', () => {
    jest.useFakeTimers();
    const gateway = new RealtimeGateway(new RealtimeService());
    const socket: any = {
      id: 's1',
      data: { user: { orgId: 'org1', exp: Math.floor(Date.now() / 1000) + 60 } },
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    gateway.handleConnection(socket);
    expect(socket.join).toHaveBeenCalledWith(orgRoom('org1'));
    jest.advanceTimersByTime(61_000);
    expect(socket.emit).toHaveBeenCalledWith('auth:expired');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    jest.useRealTimers();
  });
});

describe('ConversationService realtime', () => {
  function build(duplicate: boolean) {
    const order: string[] = [];
    const prisma = {
      inboxContact: { upsert: jest.fn().mockResolvedValue({ id: 'ct1' }) },
      conversation: {
        upsert: jest.fn().mockResolvedValue({ id: 'c1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      inboxMessage: {
        findUnique: jest.fn().mockResolvedValue(duplicate ? { id: 'm0' } : null),
        create: jest.fn(async () => {
          order.push('saved');
          return {};
        }),
      },
      channel: { update: jest.fn().mockResolvedValue({}) },
    };
    const realtime = { inboxChanged: jest.fn(() => order.push('emitted')) };
    const svc = new ConversationService(prisma as any, realtime as any);
    return { svc, realtime, order };
  }
  const input = { orgId: 'org1', channelId: 'ch1', platform: 'WHATSAPP', peerId: 'p1', text: 'hi', platformMessageId: 'wamid.1' };

  it('announces an inbound message only after it is saved', async () => {
    const { svc, realtime, order } = build(false);
    await svc.ingestInbound(input);
    expect(order).toEqual(['saved', 'emitted']);
    expect(realtime.inboxChanged).toHaveBeenCalledWith('org1', {
      kind: 'message',
      conversationId: 'c1',
      platform: 'WHATSAPP',
    });
  });

  it('stays quiet for a duplicate webhook delivery', async () => {
    const { svc, realtime } = build(true);
    await svc.ingestInbound(input);
    expect(realtime.inboxChanged).not.toHaveBeenCalled();
  });

  it('announces outbound replies', async () => {
    const { svc, realtime, order } = build(false);
    await svc.ingestOutbound('org1', 'c1', 'reply', 'AI');
    expect(order).toEqual(['saved', 'emitted']);
    expect(realtime.inboxChanged).toHaveBeenCalledWith('org1', { kind: 'message', conversationId: 'c1' });
  });
});
