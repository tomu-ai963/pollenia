import { defineConfig } from 'vitest/config';

// 純粋ロジック（可視性判定・バリデーション・系統樹の組み立て）を Node 上で実行する
// 軽量テスト。Workers 実物・DB は起動しない（knowledge-rag と同じ流儀）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
