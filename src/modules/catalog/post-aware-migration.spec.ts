import { readFileSync } from 'fs';
import { join } from 'path';

// The live database was partly built with `db push` and Render runs
// `prisma migrate deploy` on every boot, so this migration must be safe to
// apply over tables and columns that may already exist.
const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261001090000_post_aware_replies/migration.sql',
  ),
  'utf8',
);

describe('post-aware replies migration', () => {
  it('only uses idempotent DDL', () => {
    const statements = sql
      .split(';')
      .map((s) => s.replace(/--.*$/gm, '').trim())
      .filter(Boolean);
    for (const s of statements) {
      if (/^ALTER TABLE/i.test(s) && /ADD COLUMN/i.test(s)) {
        const adds = s.match(/ADD COLUMN/gi)!.length;
        const safe = s.match(/ADD COLUMN IF NOT EXISTS/gi)?.length || 0;
        expect(safe).toBe(adds);
      }
      if (/^CREATE (UNIQUE )?INDEX/i.test(s))
        expect(s).toMatch(/IF NOT EXISTS/i);
      if (/^CREATE TABLE/i.test(s)) expect(s).toMatch(/IF NOT EXISTS/i);
    }
    const constraints = sql.match(/ADD CONSTRAINT/g)?.length || 0;
    const guarded =
      sql.match(/EXCEPTION WHEN duplicate_object THEN NULL/g)?.length || 0;
    expect(guarded).toBe(constraints);
  });

  it('backfills only seller-confirmed, non-daily posts with an active item', () => {
    expect(sql).toMatch(/"status" = 'SELLER_CONFIRMED'/);
    expect(sql).toMatch(/"source" <> 'DAILY_POST'/);
    expect(sql).toMatch(/o\."isActive" = true/);
    expect(sql).toMatch(/"aiEnabledAt" IS NULL/);
  });

  it('maps industries to an offer type', () => {
    expect(sql).toMatch(/'APPAREL', 'FOOTWEAR', 'FOOD'\) THEN 'PRODUCTS'/);
    expect(sql).toMatch(
      /'BEAUTY_SERVICE', 'HOTEL', 'TRAVEL', 'REAL_ESTATE'\) THEN 'SERVICES'/,
    );
    expect(sql).toMatch(/ELSE 'BOTH'/);
  });
});
