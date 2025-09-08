-- checkpoints_v2: idempotent creation with indexes
-- NOTE: This migration is non-breaking and does not alter existing tables.
-- It introduces a new table for checkpoint map summaries used by fast handoff.

-- 1) Table
create table if not exists public.checkpoints_v2 (
  id                    bigserial primary key
);

-- Ensure required columns exist even if an older version of the table already exists
alter table public.checkpoints_v2 add column if not exists created_at         timestamptz default now();
alter table public.checkpoints_v2 add column if not exists user_id            uuid;
alter table public.checkpoints_v2 add column if not exists thread_id          text;
alter table public.checkpoints_v2 add column if not exists checkpoint_number  integer;
-- coverage (best-effort)
alter table public.checkpoints_v2 add column if not exists from_msg_idx       integer;
alter table public.checkpoints_v2 add column if not exists to_msg_idx         integer;
-- identity and quick stats
alter table public.checkpoints_v2 add column if not exists content_hash       text;
alter table public.checkpoints_v2 add column if not exists messages_count     integer;
alter table public.checkpoints_v2 add column if not exists char_count         integer;
alter table public.checkpoints_v2 add column if not exists token_estimate     integer;
-- summaries
alter table public.checkpoints_v2 add column if not exists summary            text;
alter table public.checkpoints_v2 add column if not exists quick_summary      text;
-- metadata
alter table public.checkpoints_v2 add column if not exists title              text;
alter table public.checkpoints_v2 add column if not exists model              text;
alter table public.checkpoints_v2 add column if not exists created_by_version text;

-- 2) RLS (keep secure by default; service role bypasses)
alter table if exists public.checkpoints_v2 enable row level security;

-- 3) Uniqueness and lookup indexes
do $$
begin
  -- unique per thread sequence
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='checkpoints_v2_thread_ckpt_key'
  ) then
    create unique index checkpoints_v2_thread_ckpt_key
      on public.checkpoints_v2(thread_id, checkpoint_number);
  end if;

  -- query by thread, newest first
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='checkpoints_v2_thread_created_at_idx'
  ) then
    create index checkpoints_v2_thread_created_at_idx
      on public.checkpoints_v2(thread_id, created_at desc);
  end if;

  -- hash reuse / dedupe
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='checkpoints_v2_content_hash_idx'
  ) then
    create index checkpoints_v2_content_hash_idx
      on public.checkpoints_v2 using btree (content_hash);
  end if;

  -- per user maintenance / GC
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='checkpoints_v2_user_created_at_idx'
  ) then
    create index checkpoints_v2_user_created_at_idx
      on public.checkpoints_v2(user_id, created_at desc);
  end if;
end $$;

-- 4) Optional: TTL/GC helpers (commented out). Enable only if pg_cron is available.
-- To enable, uncomment and adjust retention (e.g., 30 days for Free plan):
--
-- do $$
-- declare has_pg_cron boolean;
-- begin
--   select exists(select 1 from pg_extension where extname='pg_cron') into has_pg_cron;
--   if has_pg_cron then
--     perform cron.schedule(
--       'gc_checkpoints_v2_daily',
--       '11 3 * * *',  -- daily at 03:11
--       $$delete from public.checkpoints_v2
--           where user_id in (
--             select id from public.profiles where coalesce(plan,'free')='free'
--           )
--           and created_at < now() - interval '30 days';$$
--     );
--   end if;
-- end $$;

-- 5) Notes
-- - Edge functions using the service role key can upsert rows regardless of RLS.
-- - Consider adding policies if you want end users to read their own rows via anon key.
-- - For performance, keep summaries concise; store only derived text, never secrets.


