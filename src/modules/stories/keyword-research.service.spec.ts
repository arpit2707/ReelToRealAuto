import { combineResearch, parseSemrushCsv, rankHashtags, toHashtag } from './keyword-research.service';

describe('parseSemrushCsv', () => {
  it('parses keyword rows', () => {
    const csv = 'Keyword;Search Volume;Keyword Difficulty Index\r\nsaree online;9900;62\nsilk saree;6600;48\n';
    expect(parseSemrushCsv(csv)).toEqual([
      { phrase: 'saree online', volume: 9900, difficulty: 62 },
      { phrase: 'silk saree', volume: 6600, difficulty: 48 },
    ]);
  });

  it('treats ERROR 50 (nothing found) as empty', () => {
    expect(parseSemrushCsv('ERROR 50 :: NOTHING FOUND')).toEqual([]);
  });

  it('throws on other API errors', () => {
    expect(() => parseSemrushCsv('ERROR 120 :: WRONG KEY - ID PAIR')).toThrow('WRONG KEY');
  });
});

describe('rankHashtags', () => {
  it('ranks co-occurring hashtags and drops the seed', () => {
    const items = [
      { hashtags: ['saree', 'SareeLove', 'ethnicwear'] },
      { hashtags: ['#sareelove', 'fashion'] },
      { caption: 'New drop #SareeLove #ethnicwear #saree' },
    ];
    expect(rankHashtags(items, 'saree')).toEqual(['#sareelove', '#ethnicwear', '#fashion']);
  });

  it('ignores malformed tags', () => {
    expect(rankHashtags([{ hashtags: ['ok_tag', 'has space', 'x'] }], 'seed')).toEqual(['#ok_tag']);
  });
});

describe('combineResearch', () => {
  it('orders keywords by volume and builds a short hashtag list', () => {
    const result = combineResearch(
      'silk saree',
      [
        { phrase: 'banarasi silk saree', volume: 12000, difficulty: 85 },
        { phrase: 'silk saree online', volume: 8100, difficulty: 40 },
        { phrase: 'zero volume', volume: 0, difficulty: 10 },
      ],
      ['#sareelove', '#ethnicwear', '#fashion', '#india', '#ootd'],
    );
    expect(result.keywords).toEqual(['silk saree', 'silk saree online', 'banarasi silk saree']);
    expect(result.hashtags).toEqual([
      '#silksaree',
      '#silksareeonline',
      '#banarasisilksaree',
      '#sareelove',
      '#ethnicwear',
      '#fashion',
    ]);
  });

  it('falls back to the seed when both sources are empty', () => {
    expect(combineResearch('Chai Cafe', [], [])).toEqual({ keywords: ['chai cafe'], hashtags: ['#chaicafe'] });
  });

  it('turns phrases into hashtags', () => {
    expect(toHashtag('Diwali Offers 2026!')).toBe('#diwalioffers2026');
  });
});
