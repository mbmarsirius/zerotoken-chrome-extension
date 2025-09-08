-- Add revision + primer coverage logging to jobs (idempotent)
alter table if exists public.jobs
  add column if not exists zt_rev text;

alter table if exists public.jobs
  add column if not exists primer_coverage numeric;

comment on column public.jobs.zt_rev is 'ZeroToken pipeline revision used for this job (e.g., continuity_v1@v3)';
comment on column public.jobs.primer_coverage is 'Coverage score for PRIMER required keys (0..1)';

-- Quality metrics
alter table if exists public.jobs
  add column if not exists continuity_score numeric;
alter table if exists public.jobs
  add column if not exists continuity_repair_triggered boolean;
alter table if exists public.jobs
  add column if not exists continuity_fallback text;
comment on column public.jobs.continuity_score is 'Composite continuity score (0..1)';
comment on column public.jobs.continuity_repair_triggered is 'True if repair pass was executed';
comment on column public.jobs.continuity_fallback is 'If set, which fallback was engaged (e.g., mrv2)';


