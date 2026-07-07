// 環境設定。シークレットは置かない（anon key は公開前提のキー）。
// ローカル開発の既定値。本番は Pages のビルドで差し替えるか、このファイルを編集する。
export const CONFIG = {
  WORKER_URL: 'http://127.0.0.1:8787',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0', // supabase start 既定の anon key
};
