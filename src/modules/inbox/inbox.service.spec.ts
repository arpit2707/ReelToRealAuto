import { BadGatewayException } from '@nestjs/common';
import { InboxService } from './inbox.service';

describe('InboxService.reply', () => {
  const user = { sub: 'u1', orgId: 'org1', role: 'OWNER', email: 'a@b.c' };
  const pageB = {
    id: 'ch-b',
    platform: 'FACEBOOK',
    channelIdentifier: 'page-b',
    name: 'Page B',
    isActive: true,
    status: 'ACTIVE',
    accessTokenEncrypted: 'enc',
  };
  const conversation = {
    id: 'conv1',
    orgId: 'org1',
    channel: pageB,
    contact: { platformUserId: 'psid-1' },
    windowExpiresAt: null,
  };

  function build(sendResult: boolean) {
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue(conversation) },
    };
    const crypto = { decrypt: jest.fn().mockReturnValue('page-b-token') };
    const metaPublisher = {
      sendFacebookMessengerDm: jest.fn(async (_p, _r, _t, _k, failure) => {
        if (!sendResult) failure.message = '(#10) outside of allowed window';
        return sendResult;
      }),
    };
    const conversations = { ingestOutbound: jest.fn() };
    const service = new InboxService(
      prisma as any,
      crypto as any,
      metaPublisher as any,
      conversations as any,
    );
    return { service, metaPublisher, conversations };
  }

  it('replies through the page the customer wrote to', async () => {
    const { service, metaPublisher, conversations } = build(true);
    await service.reply(user, 'FACEBOOK', 'conv1', 'hi');
    expect(metaPublisher.sendFacebookMessengerDm).toHaveBeenCalledWith(
      'page-b',
      'psid-1',
      'hi',
      'page-b-token',
      expect.any(Object),
    );
    expect(conversations.ingestOutbound).toHaveBeenCalledWith(
      'org1',
      'conv1',
      'hi',
      'HUMAN',
    );
  });

  it('does not record a reply Meta rejected', async () => {
    const { service, conversations } = build(false);
    await expect(
      service.reply(user, 'FACEBOOK', 'conv1', 'hi'),
    ).rejects.toThrow(BadGatewayException);
    expect(conversations.ingestOutbound).not.toHaveBeenCalled();
  });
});
