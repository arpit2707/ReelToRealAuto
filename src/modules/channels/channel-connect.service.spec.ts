import { NotFoundException } from '@nestjs/common';
import { ChannelConnectService } from './channel-connect.service';

const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
};

function makePrisma(channels: any[]) {
  return {
    channel: {
      findFirst: jest.fn(async ({ where }) => channels.find((c) => c.id === where.id && c.orgId === where.orgId) ?? null),
      findMany: jest.fn(async ({ where }) =>
        channels.filter(
          (c) => c.id !== where.id.not && c.isActive === where.isActive && where.platform.in.includes(c.platform),
        ),
      ),
      update: jest.fn(async ({ where, data }) => {
        const row = channels.find((c) => c.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      count: jest.fn(async ({ where }) =>
        channels.filter((c) => c.connectionId === where.connectionId && c.isActive === where.isActive).length,
      ),
    },
    metaConnection: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
}

describe('ChannelConnectService.disconnect', () => {
  const fetchMock = jest.fn(async () => ({ ok: true, text: async () => '' }));

  beforeEach(() => {
    fetchMock.mockClear();
    (global as any).fetch = fetchMock;
  });

  const page = (over: any = {}) => ({
    id: 'fb1',
    orgId: 'org1',
    platform: 'FACEBOOK',
    channelIdentifier: 'page1',
    accessTokenEncrypted: 'enc:pagetoken',
    metadata: null,
    isActive: true,
    status: 'ACTIVE',
    connectionId: 'conn1',
    ...over,
  });
  const ig = (over: any = {}) =>
    page({ id: 'ig1', platform: 'INSTAGRAM', channelIdentifier: 'igacct1', metadata: { pageId: 'page1' }, ...over });

  it('returns 404, not 401, for an unknown channel', async () => {
    const svc = new ChannelConnectService(makePrisma([]) as any, crypto as any, {} as any);
    await expect(svc.disconnect('org1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps the Page subscription while its Instagram channel is still active', async () => {
    const rows = [page(), ig()];
    const svc = new ChannelConnectService(makePrisma(rows) as any, crypto as any, {} as any);
    await svc.disconnect('org1', 'fb1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ isActive: false, status: 'DISCONNECTED', accessTokenEncrypted: 'enc:REVOKED' });
  });

  it('unsubscribes the Page, not the Instagram account id, when the last channel goes', async () => {
    const rows = [page({ isActive: false, status: 'DISCONNECTED' }), ig()];
    const prisma = makePrisma(rows);
    const svc = new ChannelConnectService(prisma as any, crypto as any, {} as any);
    await svc.disconnect('org1', 'ig1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String((fetchMock.mock.calls[0] as any[])[0]);
    expect(url).toContain('/page1/subscribed_apps');
    expect(url).not.toContain('igacct1');
    expect(prisma.metaConnection.updateMany).toHaveBeenCalled();
  });

  it('is a no-op when the channel is already disconnected', async () => {
    const rows = [page({ isActive: false, status: 'DISCONNECTED' })];
    const prisma = makePrisma(rows);
    const svc = new ChannelConnectService(prisma as any, crypto as any, {} as any);
    await expect(svc.disconnect('org1', 'fb1')).resolves.toEqual({ ok: true, status: 'DISCONNECTED' });
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });
});
