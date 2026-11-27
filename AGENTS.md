# AGENTS.md — Pollenia

植物の交配・育種記録を管理し、SNS的に共有できるアプリ。
育種の系統記録がフリマ出品時の信頼性・付加価値になる「趣味→収益化」導線が差別化の核。
設計の詳細は `README.md` / `_docs/`（datamodel.md, api.md）を必ず先に読むこと。

## 技術スタック

- 配信: Cloudflare Workers 1つ（`worker/`）。画面 `frontend/`（静的・ビルドなし）は `[assets]` で同じ Worker から配信
- DB: **Neon**（Postgres + pgvector）。Worker からは Hyperdrive（`--caching-disabled`）経由の postgres.js
- 認証: `@tomu-ai/workers-auth` v1.1.0 の deviceAuth（メールコード → 信頼済み端末 + PIN。Cookie・同一オリジン）。
  登録は誰でも可。メール送信は Resend（tomu-ai.dev）
- 写真: Cloudflare R2（`pollenia-photos`。閲覧は Worker が署名した `/photos/<token>`）
- AI: Anthropic API（`worker/src/lib/ai/`）/ 課金: Stripe（月額 ¥300。AI 機能・分析の一部の有料ゲート）
- 定期実行: Cron Triggers（`worker/src/scheduled.ts`。「次の作業」の週1メール。曜日は `SUN` / `MON` の名前で書く —
  Cloudflare の数字は 1 = 日曜〜7 = 土曜で、0 は登録できない）
- 回数制限: Workers の Rate Limiting バインディング（`worker/src/lib/rate-limit.ts`。書き込みの多い操作を uid ごと・fail-closed）。
  ログインなしのルート（`/public/*`）はダッシュボードの Rate Limiting（IP ごと）

2026-10 に tomu-system の Supabase から切り出した（Supabase Auth / Storage / 共有 Auth レルムはもう使わない）。

## セキュリティ規約

絶対に守るセキュリティ事項（後退厳禁）は `.claude/rules/security.md`。
`worker/src/**/*.ts` を触るときに自動で読み込まれる。

## コーディング規約

- 特性（`plants.traits`）の項目は `frontend/src/trait-spec.js` の 1 か所で定義し、画面と Worker が共有する
  （検証・AI に渡す文・系統カード・CSV 取り込み・形質の分離がすべてここから作る）。項目を足すのはここに 1 行
- 画面に利用者の入力を描くときは `textContent`（`innerHTML` を使わない）
- knowledge-rag / contract-review と同じ流儀（`lib/http.ts` / `lib/error-response.ts` 形式、
  エラーは固定文言 + コード + request_id、詳細はログのみ）
- マイグレーションは `db/migrations/` の連番。`worker/scripts/migrate.mjs` が適用し
  `public.schema_migrations` で管理（適用済みファイルは書き換えない）
- シークレットはコード・wrangler.toml に書かない（ローカル `.dev.vars` / リポジトリ直下 `.env`、本番 `wrangler secret put`）
- `npx wrangler deploy` は必ず `worker/` で実行する（ルートで実行すると別 Worker が作られる）

## README に運用メモを書かない（2026-11-26 とむ決定）

リポジトリは public。README は「何のアプリか・構成・ローカルで動かす手順・設計」までにする。
次のものは README（とリポジトリ内の他の公開ドキュメント）に書かない:

- アカウント・リソースの ID（Stripe の `acct_` / `prod_` / `price_` / `we_`、Neon のプロジェクトID など）
- 本番での実施記録（「〇月〇日に実施済み」、移行の経緯、本番の構成変更の履歴）
- 鍵の権限設定・secret の中身に関わる説明（secret の**名前**を挙げるのは可）

運用メモはリポジトリ直下の `OPS.local.md`（gitignore 済み・コミットしない）に書く。
動かすのに必要な設定値（`wrangler.toml` の binding id など）は対象外。

## ローカル開発

```bash
cd worker && npm install
npm run db:up && npm run db:migrate   # docker の Postgres（127.0.0.1:55435）
npm run dev                           # http://localhost:8787（MOCK_MAIL=1 でログインコードはログに出る）
npm run typecheck && npm test
npm run geo                           # geo/geo.config.json → frontend/{robots,llms,llms-full}.txt・sitemap.xml・各ページの <head>・ログイン欄の紹介文・_headers の charset
```

- 機能・料金・画面の HTML の `<head>` を変えたら `geo/geo.config.json` を直して `npm run geo`（ずれると `test/geo.test.ts` が落ちる）。
  `geo/geo-lib.mjs`・`geo-build.mjs`（と `*.d.mts`）は geo-kit のコピーなので手を入れない（kit を更新したら丸ごと差し替える）
- 使い方ガイド（`/llms-full.txt`。設定の `guide`）は、ログイン欄の「使う前に AI に聞いてみる」と「AI相談」タブの「AI に使い方を聞く」が案内する（`frontend/src/ai-guide.js`）。
  ガイドは画面のボタン名を「」で挙げるので、**画面の文言を変えたらガイドも直す**（`test/ai-guide.test.ts` が落とす）

- 週1メールの cron を試す: `npm run dev -- --test-scheduled` → `curl "http://localhost:8787/__scheduled?cron=0+23+*+*+SUN"`
  （MOCK_MAIL=1 なら件名と行数だけがログに出る）
- 本番 DB へのマイグレーションは `npm run db:migrate -- --allow-remote`（接続文字列は環境変数で渡し、ファイルに書かない）

## フェーズ

- **Phase 1（実装済み）**: 認証・profiles 登録、plants/crossings/seed_harvests/sowings の CRUD、
  写真（R2・署名URL）、系統樹（関数経由）、公開系統ページ
- **Phase 2（実装済み）**: コミュニティ（posts/follows/likes/comments）。フィードは Worker の2段階クエリ
- **Phase 3（AI 実装済み）**: 育種相談AI（`POST /api/ai/consult`）・出品文生成（`POST /api/ai/listing`）
- **Phase 4（課金 実装済み）**: Stripe 月額サブスク ¥300、AI 機能の有料ゲート（402）。
  残り: 写真からの特徴診断
- **Phase 5（園芸家目線の改善 実装済み）**: 現場で早く・忘れず・売るときに効くための機能
  - 個体の QR ラベル（`/labels`、直リンク `/?plant=<id>`）と「撮影して記録」
  - 「次の作業」（採種・播種・発芽の確認を記録の状態から導く）と週1メール（cron・配信停止リンク）
  - 発芽率（交配ごとは無料・親ごとの比較は有料）と形質の分離（有料）
  - 系統カード画像（出品写真用の PNG。URL・QR は入れない）
  - 公開ギャラリー（`/gallery`。ログイン不要。public かつ本人が選んだ個体だけ）
  - ジャンル別の記録項目（バラ・クリスマスローズ・多肉植物・野菜・その他）
  - 種・花粉の在庫と交換の希望（投稿の一種。「譲ります」は種苗法の確認が必須）
  - 過去の記録の取り込み（CSV。系統までつなぐ）と写真のまとめ取り込み
  - 保留: 音声メモ（入れない）、系統カードへの QR（出品先の規約を確かめてから）、外した作業を画面から戻す、
    在庫の期限切れの通知、交換の掲示板の通報・ブロック
