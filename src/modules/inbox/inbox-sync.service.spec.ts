import { InboxSyncService } from './inbox-sync.service';

const crypto = { decrypt: (s: string) => s };

const tooMuch = {
  ok: false,
  status: 500,
  json: async () => ({
    error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" },
  }),
};
const page = (data: any[], after?: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ data, paging: after ? { next: 'x', cursors: { after } } : {} }),
});

describe('InboxSyncService conversation fetch', () => {
  const svc = new InboxSyncService({} as any, crypto as any, { inboxChanged: jest.fn() } as any) as any;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it('halves the page size and retries when Meta says the request is too big', async () => {
    fetchMock.mockResolvedValueOnce(tooMuch).mockResolvedValueOnce(page([{ id: 'c1' }]));
    const convs = await svc.fetchConversations('page1', true, 'tok');
    expect(convs).toEqual([{ id: 'c1' }]);
    const second = new URL(String(fetchMock.mock.calls[1][0]));
    expect(second.searchParams.get('limit')).toBe('5');
    expect(second.searchParams.get('platform')).toBe('instagram');
  });

  it('follows paging cursors', async () => {
    fetchMock.mockResolvedValueOnce(page([{ id: 'c1' }], 'cur1')).mockResolvedValueOnce(page([{ id: 'c2' }]));
    const convs = await svc.fetchConversations('page1', false, 'tok');
    expect(convs.map((c: any) => c.id)).toEqual(['c1', 'c2']);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('after')).toBe('cur1');
  });

  it('passes other Graph errors straight through', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { code: 190, message: 'expired' } }) });
    await expect(svc.fetchConversations('page1', false, 'tok')).rejects.toThrow('expired');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
