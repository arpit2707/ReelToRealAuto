// sharp ships `export =` typings and this project has no esModuleInterop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import sharp = require('sharp');

export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

/** Instagram stories only accept JPEG; 1080x1920 keeps them sharp and small. */
export async function toStoryJpeg(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .rotate()
    .resize(STORY_WIDTH, STORY_HEIGHT, { fit: 'cover' })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

/**
 * Used when the image model cannot letter the text itself: draws the headline
 * and hashtags on translucent bands with an SVG overlay.
 */
export async function overlayText(image: Buffer, headline: string, hashtags: string[]): Promise<Buffer> {
  const tagLines = wrap(hashtags.join('  '), 38).slice(0, 3);
  const headLines = wrap(headline, 20).slice(0, 2);
  const svg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <style>text { font-family: 'DejaVu Sans', 'Noto Sans', Arial, sans-serif; fill: #fff; }</style>
  <rect x="0" y="180" width="${STORY_WIDTH}" height="${60 + headLines.length * 96}" fill="rgba(0,0,0,0.45)"/>
  ${headLines
    .map(
      (l, i) =>
        `<text x="540" y="${290 + i * 96}" font-size="80" font-weight="700" text-anchor="middle">${escapeXml(l)}</text>`,
    )
    .join('\n  ')}
  <rect x="0" y="${1620 - tagLines.length * 56}" width="${STORY_WIDTH}" height="${60 + tagLines.length * 56}" fill="rgba(0,0,0,0.45)"/>
  ${tagLines
    .map(
      (l, i) =>
        `<text x="540" y="${1640 - (tagLines.length - 1 - i) * 56}" font-size="40" text-anchor="middle">${escapeXml(l)}</text>`,
    )
    .join('\n  ')}
</svg>`;
  return sharp(await toStoryJpeg(image))
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[c]!,
  );
}
