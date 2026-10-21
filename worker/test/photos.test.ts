import { describe, expect, it } from 'vitest';
import { createPhotoSigner, verifyPhotoToken, PHOTO_PATH_PREFIX } from '../src/lib/photos';
import { PHOTO_SIGNED_URL_SECONDS } from '../src/constants';
import type { Env } from '../src/env';

// 写真の署名付き URL（lib/photos.ts）。発行 → 検証の往復と、改竄・期限切れ・別鍵の拒否。

const env = { DEVICE_AUTH_SECRET: 'x'.repeat(16) + 'Yz9-Qw8_Er7.Ty6/Ui5' } as unknown as Env;
const otherEnv = { DEVICE_AUTH_SECRET: 'another-secret-value-0123456789abcdef' } as unknown as Env;
const T0 = 1_800_000_000_000;

async function tokenFor(key: string, e: Env = env, now = T0): Promise<string> {
  const url = (await createPhotoSigner(e, () => now)([key])).get(key)!;
  expect(url.startsWith(PHOTO_PATH_PREFIX)).toBe(true);
  return url.slice(PHOTO_PATH_PREFIX.length);
}

describe('photo url signing', () => {
  it('round-trips the R2 key', async () => {
    const key = 'u/p/abc.jpg';
    expect(await verifyPhotoToken(env, await tokenFor(key), () => T0)).toBe(key);
  });

  it('signs each key once and returns empty for no keys', async () => {
    const sign = createPhotoSigner(env, () => T0);
    expect((await sign([])).size).toBe(0);
    expect((await sign(['a.png', 'a.png', 'b.png'])).size).toBe(2);
  });

  it('rejects expired tokens', async () => {
    const t = await tokenFor('k.png');
    const after = T0 + (PHOTO_SIGNED_URL_SECONDS + 1) * 1000;
    expect(await verifyPhotoToken(env, t, () => after)).toBeNull();
  });

  it('rejects tokens signed with another secret', async () => {
    expect(await verifyPhotoToken(env, await tokenFor('k.png', otherEnv), () => T0)).toBeNull();
  });

  it('rejects a payload swapped under a valid signature', async () => {
    const a = await tokenFor('mine.png');
    const b = await tokenFor('theirs.png');
    const forged = `${b.split('.')[0]}.${a.split('.')[1]}`;
    expect(await verifyPhotoToken(env, forged, () => T0)).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    for (const t of ['', 'abc', 'a.b.c', '.sig', 'payload.', '!!.??']) {
      expect(await verifyPhotoToken(env, t, () => T0)).toBeNull();
    }
  });
});
