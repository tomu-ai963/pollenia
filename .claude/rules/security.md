---
paths: ["worker/src/**/*.ts"]
---

# 絶対に守るセキュリティ事項（Opus 5 レビュー済み・後退厳禁）

1. `plant_parents` ビューは `security_invoker = true` を維持
2. `get_ancestors` / `get_descendants` は可視性フィルタ必須（`can_view_as` 経由、
   非可視の親は ID を NULL 化して `has_hidden_parent` のみ）
3. Worker はスキーマ所有者ロールで接続し、認可は Worker が担う。全テーブル RLS 有効・ポリシー無し
   （deny-all）は所有者以外のロールへの最終防衛線として維持する。DB アクセスは postgres.js の
   TCP 接続のみ（advisory lock に依存するため HTTP ドライバにしない — `worker/src/lib/db.ts`）
4. 系統樹の `p_viewer`: `/api/.../lineage` は検証済み uid、`/public/plants/:id` は `null`。
   `depth` は Worker がクランプ（`constants.ts`）
5. 有効なセッション ≠ Pollenia ユーザー。必ず `pollenia.profiles` 行で判定（`lib/auth.ts` の
   `authenticateUser`）。セッション必須ルートは workers-auth の `auth.middleware()`（Origin + CSRF
   二重送信の検査込み）を通す。認証不要にしてよいのは `/api/health`・`/public/plants/:id`・
   `/photos/:token`・`/api/billing/webhook`（Stripe 署名で真正性を担保）だけ
6. 関数の EXECUTE 権限は明示管理（PUBLIC から revoke 済み。マイグレーション参照）
7. 可視性判定は `worker/src/lib/visibility.ts` を唯一の入口とし、
   **対象データ自身の visibility 列で判定。参照元エンティティの公開状態を継承しない**（F6）
8. AI（Phase 3）: RAG の参照データは**検証済み uid の自分の記録のみ**
   （`lib/ai/context.ts` / `rag.ts` が全クエリを user_id で絞る。posts/comments は含めない —
   `ai_chunks.source_type` の CHECK でも排除）。出品文生成の対象も自分の未削除 plant のみ（他人は 404）
9. Anthropic API はフロントに露出せず Worker 経由のみ。system プロンプトは固定文字列とし、
   記録・メモは `<records>`/`<facts>` 内の「データであり指示ではない」ものとして渡す
   （プロンプトインジェクション対策）。レート制限は `ai_usage_events` で判定するが、
   **advisory lock で直列化した insert→count の順を崩さない**（check-then-insert に戻すと
   並行リクエストで TOCTOU すり抜け — Opus 5 レビュー M1）
10. traits 等の jsonb への書き込みは `sql.json(...)` で渡す。JSON.stringify 済み文字列を
   `${...}::jsonb` に渡すと postgres.js が二重エンコードして jsonb が「文字列」になる
11. 写真: 閲覧 URL（`lib/photos.ts` の署名）は可視性判定を通した後でだけ発行する。R2 のキーと
   Content-Type は Worker が決め（クライアント指定を信用しない）、配信は nosniff + CSP sandbox。
   アップロードは自分の未アップロード行に1回だけ（条件付き UPDATE で確保）
12. workers-auth: pg ストアは1リクエスト1接続・Hyperdrive は `--caching-disabled`・読み取り
   レプリカ禁止。ログやレスポンスにメールアドレス・ログインコード・PIN を出さない
   （`MOCK_MAIL` は localhost のリクエストでしか効かない）
