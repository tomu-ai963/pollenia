// 共通エラーハンドラ（knowledge-rag の lib/error-response.ts を踏襲。内部情報の露出防止）。
//
// 方針:
//   - クライアントには「固定文言 + エラーコード + リクエストID」だけを返す。
//   - 例外メッセージ・Postgres のエラー（テーブル名 / カラム名 / 制約名 / 内部 UUID を
//     含みうる）やスタックは、Workers ログ（console.error）にのみ出す。
//   - ログとレスポンスは同じ request_id で相関できるようにする。
//
// エラーコード ↔ HTTP ステータス対応表:
//   AUTH_FAILED        401  認証失敗（トークン欠如 / 無効）
//   FORBIDDEN          403  認証は通ったが権限なし（Pollenia 未登録ユーザー等）
//   VALIDATION_ERROR   400  入力不正（クライアント起因。安全な補足文のみ添付可）
//   NOT_FOUND          404  対象なし・または閲覧不可（存在を秘匿するため 403 と使い分けない）
//   METHOD_NOT_ALLOWED 405  非対応メソッド
//   CONFLICT           409  重複登録等
//   INTERNAL_ERROR     500  想定外 / DB エラー（詳細はログのみ）
import { json } from './http';

export type ErrorCode =
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

interface ErrorSpec {
  status: number;
  // クライアントに返す固定文言。内部情報を含めないこと。
  message: string;
}

const ERROR_TABLE: Record<ErrorCode, ErrorSpec> = {
  AUTH_FAILED: { status: 401, message: '認証に失敗しました。' },
  FORBIDDEN: { status: 403, message: 'この操作を行う権限がありません。' },
  VALIDATION_ERROR: { status: 400, message: 'リクエストが不正です。' },
  NOT_FOUND: { status: 404, message: '対象が見つかりません。' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'このメソッドは許可されていません。' },
  CONFLICT: { status: 409, message: 'すでに登録されています。' },
  INTERNAL_ERROR: { status: 500, message: 'サーバー内部でエラーが発生しました。' },
};

export interface ErrorOptions {
  // 内部調査用の詳細（例外・Postgresエラー等）。ログにのみ出し、レスポンスには含めない。
  detail?: unknown;
  // クライアントへ返す安全な補足文（開発者が書いた文言のみ。例外文字列を渡さないこと）。
  publicMessage?: string;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

// エラー詳細を安全な文字列へ整形する（Error はメッセージ + スタックまで、他は String/JSON）。
function formatDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return detail.stack ? `${detail.message}\n${detail.stack}` : detail.message;
  }
  if (detail && typeof detail === 'object') {
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }
  return String(detail);
}

// 統一エラーレスポンス。詳細はログのみ、クライアントには固定文言 + コード + request_id。
export function errorResponse(code: ErrorCode, opts: ErrorOptions = {}): Response {
  const spec = ERROR_TABLE[code];
  const requestId = newRequestId();

  if (opts.detail !== undefined) {
    console.error(`[${requestId}] ${code} (${spec.status}): ${formatDetail(opts.detail)}`);
  }

  return json(
    {
      error: code,
      message: opts.publicMessage ?? spec.message,
      request_id: requestId,
    },
    spec.status,
  );
}
