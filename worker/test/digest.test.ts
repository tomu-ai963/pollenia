import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import type { Sql } from '../src/lib/db';
import type { Task } from '../src/lib/tasks';
import type { DigestMailer } from '../src/lib/mail';
import {
  digestMessage,
  selectDueTasks,
  signUnsubscribe,
  todayJst,
  unsubscribeUrl,
  verifyUnsubscribe,
} from '../src/lib/digest';
import { runTaskDigest } from '../src/scheduled';
import { handleUnsubscribe } from '../src/routes/unsubscribe';
import { handleUpdateMe } from '../src/routes/profiles';

// 「次の作業」の週1メール（lib/digest.ts・scheduled.ts・routes/unsubscribe.ts・PATCH /api/me）。

const env = { DEVICE_AUTH_SECRET: 'x'.repeat(48), APP_ORIGIN: 'https://pollenia.example' } as unknown as Env;
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const task = (o: Partial<Task>): Task => ({
  kind: 'harvest',
  record_id: 'r',
  crossing_id: 'c',
  seed_parent_id: 'a',
  pollen_parent_id: 'b',
  since_date: null,
  planned_date: null,
  sow_by_date: null,
  count: null,
  first_germination_date: null,
  seed_parent_name: '母株',
  pollen_parent_name: '父株',
  due_date: null,
  ...o,
});

describe('todayJst', () => {
  it('UTC の日曜 23:00（cron の時刻）は日本の月曜', () => {
    expect(todayJst(new Date('2026-11-29T23:00:00Z'))).toBe('2026-11-30');
    expect(todayJst(new Date('2026-11-29T14:59:59Z'))).toBe('2026-11-29');
  });
});

describe('selectDueTasks / digestMessage', () => {
  const today = '2026-11-30';
  const tasks = [
    task({ record_id: 'late', due_date: '2026-11-25' }),
    task({ record_id: 'today', kind: 'sow', due_date: '2026-11-30', count: 40 }),
    task({ record_id: 'in7', kind: 'germination', due_date: '2026-12-07' }),
    task({ record_id: 'in8', due_date: '2026-12-08' }),
    task({ record_id: 'nodate' }),
  ];

  it('期日が 7 日以内か過ぎたものだけ。期日の無いものは載せない', () => {
    expect(selectDueTasks(tasks, today).map((t) => t.record_id)).toEqual(['late', 'today', 'in7']);
  });

  it('件名は過ぎた件数を優先。本文に期日・残り日数・配信停止リンク', () => {
    const due = selectDueTasks(tasks, today);
    const m = digestMessage('とむ', due, today, { app: 'https://app/', unsubscribe: 'https://app/unsub' });
    expect(m.subject).toBe('Pollenia: 期日を過ぎた作業が 1 件あります');
    expect(m.text).toContain('・採種: 母株 × 父株　期日 2026-11-25（5日過ぎ）');
    expect(m.text).toContain('・播種: 母株 × 父株　期日 2026-11-30（今日）');
    expect(m.text).toContain('・発芽の確認: 母株 × 父株　期日 2026-12-07（あと7日）');
    expect(m.text).toContain('配信を止める: https://app/unsub');
    const noLate = digestMessage('とむ', due.slice(1), today, { app: 'a', unsubscribe: 'u' });
    expect(noLate.subject).toBe('Pollenia: 今週の作業が 2 件あります');
  });
});

describe('配信停止リンクの署名', () => {
  it('本人の uid でだけ通る。改ざん・別の uid・別の鍵は通らない', async () => {
    const t = await signUnsubscribe(env, U1);
    expect(await verifyUnsubscribe(env, U1, t)).toBe(true);
    expect(await verifyUnsubscribe(env, U2, t)).toBe(false);
    expect(await verifyUnsubscribe(env, U1, `${t.slice(0, -2)}AA`)).toBe(false);
    expect(await verifyUnsubscribe(env, U1, 'not base64!')).toBe(false);
    const other = { ...env, DEVICE_AUTH_SECRET: 'y'.repeat(48) } as Env;
    expect(await verifyUnsubscribe(other, U1, t)).toBe(false);
  });

  it('URL は /public/unsubscribe?u=&t=', async () => {
    const url = new URL(await unsubscribeUrl(env, 'https://pollenia.example', U1));
    expect(url.pathname).toBe('/public/unsubscribe');
    expect(url.searchParams.get('u')).toBe(U1);
  });
});

// ---- cron ------------------------------------------------------------------

type Q = { q: string; values: unknown[] };
function cronSql(queries: Q[], users: { id: string; display_name: string; email: string }[], dueFor: Set<string>): Sql {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('$');
    queries.push({ q, values });
    if (q.includes('from pollenia.profiles p')) return Promise.resolve(users);
    // loadTasksFor の 3 本 + 名前。期日のある採種の作業を 1 件だけ返す
    if (q.includes("'harvest' as kind")) {
      const uid = values[0] as string;
      return Promise.resolve(
        dueFor.has(uid)
          ? [{ kind: 'harvest', record_id: 'r', crossing_id: 'c', seed_parent_id: 'a', pollen_parent_id: null,
               since_date: null, planned_date: '2026-11-28', sow_by_date: null, count: null, first_germination_date: null }]
          : [],
      );
    }
    if (q.includes("'sow' as kind") || q.includes("'germination' as kind")) return Promise.resolve([]);
    if (q.includes('from pollenia.plants')) return Promise.resolve([{ id: 'a', name: '母株' }]);
    if (q.includes('update pollenia.profiles set task_digest_last_sent_on')) return Promise.resolve([]);
    throw new Error(`fakeSql: 未対応のクエリ: ${q}`);
  }) as unknown as Sql;
}

describe('runTaskDigest', () => {
  afterEach(() => vi.restoreAllMocks());
  const NOW = new Date('2026-11-29T23:00:00Z'); // 月曜 8:00 JST

  it('選んだ人のうち今日まだの人だけを対象にし、期日の近い作業がある人にだけ送る', async () => {
    const queries: Q[] = [];
    const sent: { to: string; subject: string; unsub: string }[] = [];
    const mailer: DigestMailer = { send: async (to, m, unsub) => void sent.push({ to, subject: m.subject, unsub }) };
    const users = [
      { id: U1, display_name: 'A', email: 'a@example.test' },
      { id: U2, display_name: 'B', email: 'b@example.test' },
    ];
    const r = await runTaskDigest(env, cronSql(queries, users, new Set([U1])), mailer, NOW);
    expect(r).toEqual({ checked: 2, sent: 1, skipped: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('a@example.test');
    expect(sent[0].subject).toContain('期日を過ぎた作業が 1 件');
    expect(sent[0].unsub).toMatch(/^https:\/\/pollenia\.example\/public\/unsubscribe\?u=/);
    const sel = queries[0];
    expect(sel.q).toContain('where p.task_digest');
    expect(sel.q).toContain('task_digest_last_sent_on is null or p.task_digest_last_sent_on < $::date');
    expect(sel.values[0]).toBe('2026-11-30');
    // 送った人も送らなかった人も、今日は処理済みにする
    expect(queries.filter((x) => x.q.includes('task_digest_last_sent_on = $::date'))).toHaveLength(2);
  });

  it('送信に失敗した人は処理済みにせず（次の実行で送り直す）、ほかの人は続ける。ログに宛先を出さない', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a.join(' ')));
    const queries: Q[] = [];
    const mailer: DigestMailer = {
      send: async (to) => {
        if (to === 'a@example.test') throw new Error('boom a@example.test');
      },
    };
    const users = [
      { id: U1, display_name: 'A', email: 'a@example.test' },
      { id: U2, display_name: 'B', email: 'b@example.test' },
    ];
    const r = await runTaskDigest(env, cronSql(queries, users, new Set([U1, U2])), mailer, NOW);
    expect(r).toEqual({ checked: 2, sent: 1, skipped: 0, failed: 1 });
    const marked = queries.filter((x) => x.q.includes('task_digest_last_sent_on = $::date')).map((x) => x.values[1]);
    expect(marked).toEqual([U2]);
    expect(logs.join('\n')).not.toContain('example.test');
  });
});

// ---- 配信停止ページ -----------------------------------------------------------

describe('/public/unsubscribe', () => {
  const sqlSpy = (queries: Q[]) =>
    ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ q: strings.join('$'), values });
      return Promise.resolve([]);
    }) as unknown as Sql;
  const req = async (method: string, uid: string, token?: string) => {
    const t = token ?? (await signUnsubscribe(env, uid));
    return new Request(`https://pollenia.example/public/unsubscribe?u=${uid}&t=${t}`, { method });
  };

  it('GET は確認ページだけで、止めない（リンクの先読みで止まらない）', async () => {
    const queries: Q[] = [];
    const res = await handleUnsubscribe(await req('GET', U1), env, sqlSpy(queries));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<form method="post">');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(queries).toHaveLength(0);
  });

  it('POST（ワンクリック配信停止を含む）で本人の task_digest を false にする', async () => {
    const queries: Q[] = [];
    const res = await handleUnsubscribe(await req('POST', U1), env, sqlSpy(queries));
    expect(res.status).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0].q).toContain('update pollenia.profiles set task_digest = false where id = $::uuid');
    expect(queries[0].values).toEqual([U1]);
  });

  it('署名が合わない・別の人の署名・uid の形でないものは 400 で何もしない', async () => {
    const queries: Q[] = [];
    const u2token = await signUnsubscribe(env, U2);
    for (const r of [
      await req('POST', U1, 'AAAA'),
      await req('POST', U1, u2token),
      new Request('https://pollenia.example/public/unsubscribe?u=x&t=y', { method: 'POST' }),
      new Request('https://pollenia.example/public/unsubscribe', { method: 'POST' }),
    ]) {
      expect((await handleUnsubscribe(r, env, sqlSpy(queries))).status).toBe(400);
    }
    expect(queries).toHaveLength(0);
  });
});

describe('PATCH /api/me', () => {
  it('task_digest は真偽値だけ。自分の行だけを更新する', async () => {
    const queries: Q[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ q: strings.join('$'), values });
      return Promise.resolve([{ task_digest: values[0] }]);
    }) as unknown as Sql;
    const user = { uid: U1, displayName: 'A' };
    const patch = (b: unknown) => new Request('http://x/api/me', { method: 'PATCH', body: JSON.stringify(b) });
    const ok = await handleUpdateMe(patch({ task_digest: true }), sql, user);
    expect(await ok.json()).toEqual({ task_digest: true });
    expect(queries[0].values).toEqual([true, U1]);
    expect((await handleUpdateMe(patch({ task_digest: 'yes' }), sql, user)).status).toBe(400);
    expect((await handleUpdateMe(patch({}), sql, user)).status).toBe(400);
  });
});

describe('cron の設定（wrangler.toml）', () => {
  it('月曜に送り始め、同じ日（JST の月曜）のうちに毎時動いて、上限を超えた人・失敗した人を拾う', async () => {
    const { readFileSync } = await import('node:fs');
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const crons = toml.match(/^crons = \[(.*)\]$/m)?.[1] ?? '';
    expect(crons).toContain('"0 23 * * SUN"');
    expect(crons).toContain('"0 0-11 * * MON"');
    // 曜日は名前で書く（Cloudflare の数字は 1 = 日曜〜7 = 土曜。0 は登録できず、1 は月曜ではなく日曜になる）
    for (const expr of crons.match(/"([^"]+)"/g) ?? []) {
      expect(expr.replace(/"/g, '').split(' ')[4]).toMatch(/^(\*|[A-Z]{3}(-[A-Z]{3})?)$/);
    }
    // 追加の実行もすべて JST の月曜（同じ「今日」）に入る＝処理済みの印で二重に送らない
    for (const h of [0, 11]) {
      expect(todayJst(new Date(Date.UTC(2026, 10, 30, h, 0)))).toBe('2026-11-30');
    }
    expect(todayJst(new Date(Date.UTC(2026, 10, 29, 23, 0)))).toBe('2026-11-30');
  });
});
