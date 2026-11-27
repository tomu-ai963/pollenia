-- 0004: 「次の作業」一覧（2026-11-27）。
--
-- 作業は別テーブルに持たず、記録の状態から導く（routes/tasks.ts）:
--   交配して採種がまだ        → 採種（crossings）
--   採種して播種がまだ        → 播種（seed_harvests）
--   播種して発芽数が未記録    → 発芽の確認（sowings）
-- 次の記録を付ければ作業は自然に消える。ここで足すのは、作業に付ける任意の予定日と、
-- 結実しなかった交配などを一覧から外すための印だけ。

alter table pollenia.crossings
  add column expected_harvest_date date,          -- 採種の予定日
  add column task_dismissed_at     timestamptz;   -- 「次の作業」から外した日時（採種の作業を出さない）

alter table pollenia.seed_harvests
  add column planned_sowing_date date,            -- 播種の予定日
  add column sow_by_date         date,            -- 種の使用期限（発芽率が落ちる頃）
  add column task_dismissed_at   timestamptz;

alter table pollenia.sowings
  add column expected_germination_date date,      -- 発芽を確かめる予定日
  add column task_dismissed_at         timestamptz;
