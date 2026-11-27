import type { Env } from '../env';

// ログイン用メールコードの送信。workers-auth の deviceAuth は sendCode(email, code) を
// 注入させるだけでメールを送らないので、ここで Resend（HTTP API）につなぐ（personal-rag と同じ構成）。
// ローカルでは MOCK_MAIL=1 でコードを Worker のログに出す（localhost からのリクエストに限る）。

export interface Mailer {
  // コードを1通送る。失敗は throw（呼び出し側がログに status だけ出し、レスポンスには出さない）。
  sendLoginCode(to: string, code: string): Promise<void>;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// 失敗の詳細はログに出すが、宛先・本文（コード）は Error に入れない。
export class MailSendError extends Error {
  constructor(readonly status: number) {
    super(`mail send failed: ${status}`);
    this.name = 'MailSendError';
  }
}

export function loginCodeMessage(code: string): { subject: string; text: string } {
  return {
    subject: 'Pollenia のログインコード',
    text: [
      `ログインコード: ${code}`,
      '',
      'このコードは 10 分間有効です。心当たりがなければ、このメールは無視してください。',
      '（コードを誰かに伝えないでください）',
    ].join('\n'),
  };
}

export function createResendMailer(apiKey: string, from: string): Mailer {
  return {
    async sendLoginCode(to, code) {
      const { subject, text } = loginCodeMessage(code);
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) throw new MailSendError(res.status);
    },
  };
}

// ローカル確認用。コードは Worker のログ（wrangler dev のターミナル）にだけ出る。
export function createConsoleMailer(): Mailer {
  return {
    async sendLoginCode(_to, code) {
      console.log(`[MOCK_MAIL] login code: ${code}`);
    },
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// 環境に応じた送信手段。設定が足りなければ null（呼び出し側で 503 相当にする）。
// MOCK_MAIL はリクエストのホストがローカルのときしか使わない。
export function createMailer(env: Env, requestUrl: string): Mailer | null {
  if (env.MOCK_MAIL === '1' && LOCAL_HOSTS.has(new URL(requestUrl).hostname)) {
    return createConsoleMailer();
  }
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return createResendMailer(apiKey, from);
}

// ---- 「次の作業」の週1メール（scheduled.ts） ------------------------------------

export interface DigestMailer {
  // 失敗は throw（MailSendError。宛先・本文は入れない）
  send(to: string, message: { subject: string; text: string }, unsubscribeUrl: string): Promise<void>;
}

// Resend があればそれで送る。無ければ、MOCK_MAIL=1 のときだけログに件名と行数を出す（ローカル確認用）。
// cron にはリクエストのホストが無いので、ログイン用の「localhost のときだけ」の判定は使えない。
// 代わりに、ログには宛先も本文（個体名）も出さない（本番に MOCK_MAIL が紛れ込んでも記録が漏れない）。
export function createDigestMailer(env: Env): DigestMailer | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (apiKey && from) {
    return {
      async send(to, { subject, text }, unsubscribeUrl) {
        const res = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [to],
            subject,
            text,
            // メールソフトの「配信停止」ボタン（RFC 8058 のワンクリック）
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }),
        });
        if (!res.ok) throw new MailSendError(res.status);
      },
    };
  }
  if (env.MOCK_MAIL === '1') {
    return {
      async send(_to, { subject, text }) {
        console.log(`[MOCK_MAIL] task digest: ${subject}（${text.split('\n').length} 行）`);
      },
    };
  }
  return null;
}
