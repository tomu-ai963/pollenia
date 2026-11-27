-- 0006: 「次の作業」の週1メール（2026-11-27）。
--
-- 期日が 7 日以内（過ぎたものを含む）の作業があるときだけ、毎週月曜の朝に送る（worker/src/scheduled.ts）。
-- 受け取るかは本人が選ぶ（既定は受け取らない）。メールの配信停止リンクから、ログインせずに止められる。
alter table pollenia.profiles
  add column task_digest boolean not null default false,
  -- 最後に処理した日（日本時間の日付）。cron の再実行で同じ日に二重に送らないため
  add column task_digest_last_sent_on date;
