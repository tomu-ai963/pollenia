#!/bin/sh
# docker の初回起動時（ボリュームが空のとき）だけ実行される。
# Neon の「DB 所有者ロール（非スーパーユーザー）+ pgvector 有効化済み」に寄せた状態を作る。
set -eu

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
  -v owner_password="$POLLENIA_OWNER_PASSWORD" <<'SQL'
create role pollenia_owner login password :'owner_password' nosuperuser nocreatedb nocreaterole;
create database pollenia owner pollenia_owner;
SQL

psql -v ON_ERROR_STOP=1 --username postgres --dbname pollenia <<'SQL'
create extension if not exists vector;
-- PG15 以降は public スキーマの CREATE が所有者（pg_database_owner）に限られる。
-- DB の所有者が pollenia_owner なので workers-auth のテーブルは public に作れる。
SQL
