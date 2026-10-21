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
