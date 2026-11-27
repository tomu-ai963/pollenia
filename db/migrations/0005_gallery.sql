-- 0005: 公開ギャラリー（2026-11-27）。ログインせずに、公開された個体の写真と系統を一覧で眺められるページ。
--
-- visibility = public はこれまで「URL を知っている人が見られる」だけだった（/public?id=）。
-- ギャラリーに並べると誰でもたどれるようになり、公開の範囲が広がるので、載せるかは個体ごとに本人が選ぶ
-- （既定は載せない）。載るのは visibility = public かつ in_gallery かつ未削除で、写真が 1 枚以上ある個体だけ
-- （worker/src/routes/public.ts の handlePublicGallery）。public でなくなれば in_gallery のままでも載らない。
alter table pollenia.plants
  add column in_gallery boolean not null default false;

-- ギャラリーの一覧（載せている個体だけの部分インデックス）
create index plants_gallery_idx on pollenia.plants (updated_at desc)
  where in_gallery and visibility = 'public' and deleted_at is null;
