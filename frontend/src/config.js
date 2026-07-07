// 環境設定。ここに置くのは公開値のみ（publishable key は公開前提のキー。シークレットは置かない）。
// 本番値（Cloudflare Pages 配信用）。
// ローカル開発時は下のコメントの値に差し替える（supabase start + wrangler dev）。
export const CONFIG = {
  WORKER_URL: 'https://pollenia-worker.inverted-triangle-leef.workers.dev',
  SUPABASE_URL: 'https://gtqtadnexqlypdptfqpx.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_VvkzU9WbgtxJKTJP-ZPkdw_KtWDDqnD',
};

// --- ローカル開発用 ---
// export const CONFIG = {
//   WORKER_URL: 'http://127.0.0.1:8787',
//   SUPABASE_URL: 'http://127.0.0.1:54321',
//   // supabase start 既定の anon key（全ローカル環境共通のデモ値）
//   SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
// };
