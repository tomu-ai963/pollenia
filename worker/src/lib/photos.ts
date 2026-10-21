import type { Env } from '../env';
import { PHOTO_SIGNED_URL_SECONDS } from '../constants';

// 写真の閲覧 URL（R2 のオブジェクトを Worker 経由で返す署名付き URL。ap-invoice と同じ方式）。
//
//   /photos/<payload>.<sig>
//     payload = base64url(JSON { k: R2 キー, e: 失効 epoch 秒 })
//     sig     = base64url(HMAC-SHA256(payload))
//
// 署名鍵は DEVICE_AUTH_SECRET から HKDF で派生させる（info で用途を分離。ログインの HMAC 鍵と
// 同じ値にはならない）。DEVICE_AUTH_SECRET を変えると発行済みの写真 URL は無効になるが、
// URL の寿命は PHOTO_SIGNED_URL_SECONDS（1時間）なので実害はない。
//
// 閲覧可否は URL を発行する側（plants / lineage / public の各ルート）が可視性判定を通した
// 後でだけ署名することで担保する。/photos/* 自体は認証を要求しない（<img src> から読むため）。

export const PHOTO_PATH_PREFIX = '/photos/';

const HKDF_INFO = 'pollenia photo url v1';

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(HKDF_INFO) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

function photoSecret(env: Env): string {
  const secret = env.DEVICE_AUTH_SECRET?.trim();
  if (!secret) throw new Error('DEVICE_AUTH_SECRET が設定されていません（写真 URL の署名に必要）');
  return secret;
}

// R2 キーの一覧 → 閲覧 URL（同一オリジンの相対パス）。呼び出し側が可視性判定を済ませたキーだけを渡すこと。
export type PhotoSigner = (keys: string[]) => Promise<Map<string, string>>;

export function createPhotoSigner(env: Env, now: () => number = Date.now): PhotoSigner {
  let keyPromise: Promise<CryptoKey> | null = null;
  return async (keys) => {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    keyPromise ??= deriveKey(photoSecret(env));
    const key = await keyPromise;
    const exp = Math.floor(now() / 1000) + PHOTO_SIGNED_URL_SECONDS;
    for (const k of new Set(keys)) {
      const payload = b64url(enc.encode(JSON.stringify({ k, e: exp })));
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
      out.set(k, `${PHOTO_PATH_PREFIX}${payload}.${b64url(sig)}`);
    }
    return out;
  };
}

// /photos/<token> の token を検証して R2 キーを返す。改竄・期限切れ・形式不正は null。
export async function verifyPhotoToken(
  env: Env,
  token: string,
  now: () => number = Date.now,
): Promise<string | null> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const sig = fromB64url(token.slice(dot + 1));
  if (!sig) return null;

  const key = await deriveKey(photoSecret(env));
  // crypto.subtle.verify は定数時間比較
  const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(payload));
  if (!ok) return null;

  const raw = fromB64url(payload);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  const { k, e } = (parsed ?? {}) as { k?: unknown; e?: unknown };
  if (typeof k !== 'string' || k === '' || typeof e !== 'number') return null;
  if (e < Math.floor(now() / 1000)) return null;
  return k;
}

// GET /photos/<token> — 署名を確かめて R2 のオブジェクトを返す。
// Content-Type はアップロード時に Worker が許可リストから決めた値（R2 の httpMetadata）だけを使い、
// nosniff と CSP で「画像以外として解釈される」余地を塞ぐ。
export async function handleGetPhoto(env: Env, token: string): Promise<Response> {
  const key = await verifyPhotoToken(env, token);
  if (!key) return new Response('Not Found', { status: 404 });
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // URL 自体が 1時間で失効するので、それより長くキャッシュさせない
      'cache-control': `private, max-age=${PHOTO_SIGNED_URL_SECONDS}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    },
  });
}
