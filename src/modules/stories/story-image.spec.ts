// sharp ships `export =` typings and this project has no esModuleInterop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import sharp = require('sharp');
import { escapeXml, overlayText, toStoryJpeg, wrap } from './story-image';

describe('story images', () => {
  const png = () =>
    sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 50, b: 50 } } })
      .png()
      .toBuffer();

  it('converts any image to a 1080x1920 JPEG', async () => {
    const out = await toStoryJpeg(await png());
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1080, height: 1920 });
  });

  it('overlays text without changing the size', async () => {
    const out = await overlayText(await png(), 'Diwali <Sale> & more', ['#diwali', '#sale']);
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1080, height: 1920 });
  });

  it('wraps and escapes text', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(escapeXml(`<a & "b">`)).toBe('&lt;a &amp; &quot;b&quot;&gt;');
  });
});
