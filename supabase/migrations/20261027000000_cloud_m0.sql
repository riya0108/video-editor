-- CLIPBENCH CLOUD — Phase 4 M0: daily credits, the global budget, and the job queue.
--
-- Everything lives in the private `cloud` schema: it is NOT exposed through Supabase's REST/GraphQL APIs, and the
-- browser never touches it. The app server calls the functions below as the least-privilege role `clipbench_server`
-- (created separately, with its password kept out of this repo), which may execute these functions and nothing else.
--
-- Money safety is enforced by the database, not by application code:
--   - a user's day row has CHECK (reserved + used <= allowance), so no code path can overdraw credits;
--   - reservations are single conditional UPDATEs on the user's / day's row, serialized by row locks, so concurrent
--     submissions can't both spend the last credits or push the day past the global cap;
--   - one function = one transaction: if any step fails (credits, cap, kill switch), nothing is reserved.
--
-- Lifecycle: reserve_job (queued) -> claim_job (running) -> settle_job (succeeded) | fail_job (retry -> queued, or
-- failed + refund) | cancel_job (queued -> cancelled + refund). Every credit movement is written to `ledger`.

create schema if not exists cloud;
revoke all on schema cloud from public;

create table cloud.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into cloud.settings (key, value) values
  ('ai_enabled', 'true'::jsonb),
  ('global_daily_budget_usd', '25'::jsonb);

-- One row per user (or anonymous key) per UTC day. Credits don't roll over: a new day is a new row.
create table cloud.credit_days (
  user_key text not null,
  day date not null,
  allowance integer not null check (allowance >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  used integer not null default 0 check (used >= 0),
  primary key (user_key, day),
  check (reserved + used <= allowance)
);

-- The site-wide spend for a UTC day: reserved (estimates of jobs in flight) + spent (actual provider cost).
create table cloud.budget_days (
  day date primary key,
  cap_usd numeric(12, 4) not null check (cap_usd >= 0),
  reserved_usd numeric(12, 4) not null default 0 check (reserved_usd >= 0),
  spent_usd numeric(12, 4) not null default 0 check (spent_usd >= 0)
);

create table cloud.jobs (
  id uuid primary key default gen_random_uuid(),
  user_key text not null,
  user_id uuid,
  feature text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  params jsonb not null default '{}'::jsonb,
  consent boolean not null default false,
  upload_paths text[] not null default '{}',
  uploads_cleared boolean not null default false,
  credit_day date not null,
  est_credits integer not null check (est_credits >= 0),
  est_usd numeric(12, 4) not null check (est_usd >= 0),
  charged_credits integer not null default 0,
  cost_usd numeric(12, 4) not null default 0,
  result jsonb,
  error text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  locked_by text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_queue_idx on cloud.jobs (created_at) where status = 'queued';
create index jobs_user_idx on cloud.jobs (user_key, created_at desc);
create index jobs_running_idx on cloud.jobs (started_at) where status = 'running';

create table cloud.ledger (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_key text not null,
  job_id uuid references cloud.jobs (id),
  kind text not null check (kind in ('reserve', 'settle', 'refund', 'retry')),
  credits integer not null,
  usd numeric(12, 4) not null default 0
);
create index ledger_job_idx on cloud.ledger (job_id);

alter table cloud.settings enable row level security;
alter table cloud.credit_days enable row level security;
alter table cloud.budget_days enable row level security;
alter table cloud.jobs enable row level security;
alter table cloud.ledger enable row level security;

create function cloud.utc_today() returns date
language sql stable set search_path = cloud, pg_temp
as $$ select (now() at time zone 'utc')::date $$;

-- Reserve credits + budget and enqueue a job — atomically. Raises one of:
--   cloud_paused | invalid_estimate | too_many_active_jobs | insufficient_credits | daily_budget_reached
create function cloud.reserve_job(
  p_user_key text, p_user_id uuid, p_feature text, p_params jsonb, p_credits integer, p_usd numeric,
  p_allowance integer, p_max_active integer, p_consent boolean, p_upload_paths text[]
) returns cloud.jobs
language plpgsql security definer set search_path = cloud, pg_temp
as $$
declare
  d date := cloud.utc_today();
  v_cap numeric;
  v_active integer;
  j cloud.jobs;
begin
  if p_credits is null or p_credits < 0 or p_usd is null or p_usd < 0 then raise exception 'invalid_estimate'; end if;
  if (select value from settings where key = 'ai_enabled') is distinct from 'true'::jsonb then raise exception 'cloud_paused'; end if;

  insert into credit_days (user_key, day, allowance) values (p_user_key, d, p_allowance) on conflict do nothing;
  -- Serialize this user's submissions for the rest of the transaction.
  perform 1 from credit_days where user_key = p_user_key and day = d for update;

  select count(*) into v_active from jobs where user_key = p_user_key and status in ('queued', 'running');
  if v_active >= p_max_active then raise exception 'too_many_active_jobs'; end if;

  -- The allowance follows the server's config, but never below what's already committed today.
  update credit_days
     set allowance = greatest(p_allowance, reserved + used),
         reserved = reserved + p_credits
   where user_key = p_user_key and day = d
     and greatest(p_allowance, reserved + used) - reserved - used >= p_credits;
  if not found then raise exception 'insufficient_credits'; end if;

  select (value #>> '{}')::numeric into v_cap from settings where key = 'global_daily_budget_usd';
  insert into budget_days (day, cap_usd) values (d, coalesce(v_cap, 0))
    on conflict (day) do update set cap_usd = excluded.cap_usd;
  update budget_days set reserved_usd = reserved_usd + p_usd
   where day = d and reserved_usd + spent_usd + p_usd <= cap_usd;
  if not found then raise exception 'daily_budget_reached'; end if;

  insert into jobs (user_key, user_id, feature, params, consent, upload_paths, credit_day, est_credits, est_usd)
  values (p_user_key, p_user_id, p_feature, coalesce(p_params, '{}'::jsonb), coalesce(p_consent, false), coalesce(p_upload_paths, '{}'), d, p_credits, p_usd)
  returning * into j;
  insert into ledger (user_key, job_id, kind, credits, usd) values (p_user_key, j.id, 'reserve', p_credits, p_usd);
  return j;
end $$;

-- Hands the oldest queued job to a worker (skipping jobs other workers hold). Returns no row when the queue is empty.
create function cloud.claim_job(p_worker text) returns setof cloud.jobs
language sql security definer set search_path = cloud, pg_temp
as $$
  update jobs set status = 'running', locked_by = p_worker, started_at = now(), attempts = attempts + 1
   where id = (select id from jobs where status = 'queued' order by created_at for update skip locked limit 1)
  returning *;
$$;

-- Success: charge the actual credits (never more than reserved), record the real provider cost, release the rest.
create function cloud.settle_job(p_job uuid, p_credits integer, p_cost_usd numeric, p_result jsonb) returns cloud.jobs
language plpgsql security definer set search_path = cloud, pg_temp
as $$
declare
  j cloud.jobs;
  c integer;
begin
  select * into j from jobs where id = p_job for update;
  if not found or j.status <> 'running' then raise exception 'job_not_running'; end if;
  c := least(greatest(coalesce(p_credits, 0), 0), j.est_credits);
  update credit_days set reserved = reserved - j.est_credits, used = used + c where user_key = j.user_key and day = j.credit_day;
  update budget_days set reserved_usd = greatest(0, reserved_usd - j.est_usd), spent_usd = spent_usd + greatest(coalesce(p_cost_usd, 0), 0) where day = j.credit_day;
  update jobs set status = 'succeeded', charged_credits = c, cost_usd = greatest(coalesce(p_cost_usd, 0), 0), result = p_result, error = null, finished_at = now(), locked_by = null
   where id = p_job returning * into j;
  insert into ledger (user_key, job_id, kind, credits, usd) values (j.user_key, j.id, 'settle', c, j.cost_usd);
  return j;
end $$;

-- Failure: the provider cost already incurred is always recorded. With p_retry and attempts left, the job goes back to
-- the queue keeping its reservation; otherwise it fails and the user's credits are refunded in full.
create function cloud.fail_job(p_job uuid, p_error text, p_cost_usd numeric, p_retry boolean) returns cloud.jobs
language plpgsql security definer set search_path = cloud, pg_temp
as $$
declare
  j cloud.jobs;
  cost numeric := greatest(coalesce(p_cost_usd, 0), 0);
begin
  select * into j from jobs where id = p_job for update;
  if not found or j.status <> 'running' then raise exception 'job_not_running'; end if;
  update budget_days set spent_usd = spent_usd + cost where day = j.credit_day;
  if p_retry and j.attempts < j.max_attempts then
    update jobs set status = 'queued', error = p_error, cost_usd = cost_usd + cost, locked_by = null where id = p_job returning * into j;
    insert into ledger (user_key, job_id, kind, credits, usd) values (j.user_key, j.id, 'retry', 0, cost);
    return j;
  end if;
  update credit_days set reserved = reserved - j.est_credits where user_key = j.user_key and day = j.credit_day;
  update budget_days set reserved_usd = greatest(0, reserved_usd - j.est_usd) where day = j.credit_day;
  update jobs set status = 'failed', error = p_error, cost_usd = cost_usd + cost, finished_at = now(), locked_by = null where id = p_job returning * into j;
  insert into ledger (user_key, job_id, kind, credits, usd) values (j.user_key, j.id, 'refund', j.est_credits, cost);
  return j;
end $$;

-- The owner cancels a job that hasn't started: full refund. Returns false when it already started or isn't theirs.
create function cloud.cancel_job(p_job uuid, p_user_key text) returns boolean
language plpgsql security definer set search_path = cloud, pg_temp
as $$
declare
  j cloud.jobs;
begin
  select * into j from jobs where id = p_job and user_key = p_user_key for update;
  if not found or j.status <> 'queued' then return false; end if;
  update credit_days set reserved = reserved - j.est_credits where user_key = j.user_key and day = j.credit_day;
  update budget_days set reserved_usd = greatest(0, reserved_usd - j.est_usd) where day = j.credit_day;
  update jobs set status = 'cancelled', finished_at = now() where id = p_job;
  insert into ledger (user_key, job_id, kind, credits, usd) values (j.user_key, j.id, 'refund', j.est_credits, 0);
  return true;
end $$;

-- Jobs whose worker died mid-run go back to the queue (or fail with a refund after max_attempts).
create function cloud.requeue_stale(p_older_than interval) returns integer
language plpgsql security definer set search_path = cloud, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select id from jobs where status = 'running' and started_at < now() - p_older_than for update skip locked loop
    perform cloud.fail_job(r.id, 'worker_timeout', 0, true);
    n := n + 1;
  end loop;
  return n;
end $$;

create function cloud.get_balance(p_user_key text, p_allowance integer)
returns table (day date, allowance integer, used integer, reserved integer, available integer)
language sql stable security definer set search_path = cloud, pg_temp
as $$
  select d.day, greatest(p_allowance, coalesce(c.reserved, 0) + coalesce(c.used, 0)), coalesce(c.used, 0), coalesce(c.reserved, 0),
         greatest(p_allowance, coalesce(c.reserved, 0) + coalesce(c.used, 0)) - coalesce(c.reserved, 0) - coalesce(c.used, 0)
    from (select cloud.utc_today() as day) d
    left join credit_days c on c.user_key = p_user_key and c.day = d.day;
$$;

create function cloud.get_job(p_job uuid, p_user_key text) returns setof cloud.jobs
language sql stable security definer set search_path = cloud, pg_temp
as $$ select * from jobs where id = p_job and user_key = p_user_key $$;

create function cloud.list_jobs(p_user_key text, p_limit integer) returns setof cloud.jobs
language sql stable security definer set search_path = cloud, pg_temp
as $$ select * from jobs where user_key = p_user_key order by created_at desc limit least(greatest(p_limit, 1), 100) $$;

-- Uploads older than p_older_than whose files haven't been deleted yet (the worker deletes them, then marks them).
create function cloud.expired_uploads(p_older_than interval) returns table (job_id uuid, path text)
language sql stable security definer set search_path = cloud, pg_temp
as $$
  select j.id, unnest(j.upload_paths) from jobs j
   where not j.uploads_cleared and cardinality(j.upload_paths) > 0 and j.created_at < now() - p_older_than
     and j.status in ('succeeded', 'failed', 'cancelled')
$$;

create function cloud.mark_uploads_cleared(p_jobs uuid[]) returns integer
language sql security definer set search_path = cloud, pg_temp
as $$ with u as (update jobs set uploads_cleared = true where id = any (p_jobs) returning 1) select count(*)::integer from u $$;

create function cloud.set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = cloud, pg_temp
as $$
begin
  if p_key not in ('ai_enabled', 'global_daily_budget_usd') then raise exception 'unknown_setting'; end if;
  insert into settings (key, value, updated_at) values (p_key, p_value, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  if p_key = 'global_daily_budget_usd' then
    update budget_days set cap_usd = (p_value #>> '{}')::numeric where day = cloud.utc_today();
  end if;
end $$;

-- The admin spend view: settings, the last p_days of budget, spend and jobs by feature, and spend by hour today.
create function cloud.admin_spend(p_days integer) returns jsonb
language sql stable security definer set search_path = cloud, pg_temp
as $$
  select jsonb_build_object(
    'settings', (select jsonb_object_agg(key, value) from settings),
    'today', cloud.utc_today(),
    'days', coalesce((select jsonb_agg(to_jsonb(b) order by b.day desc) from budget_days b where b.day > cloud.utc_today() - p_days), '[]'::jsonb),
    'by_feature', coalesce((
      select jsonb_agg(jsonb_build_object('day', credit_day, 'feature', feature, 'jobs', n, 'succeeded', ok, 'failed', bad, 'credits', credits, 'cost_usd', cost) order by credit_day desc, cost desc)
        from (select credit_day, feature, count(*) n, count(*) filter (where status = 'succeeded') ok, count(*) filter (where status = 'failed') bad,
                     sum(charged_credits) credits, sum(cost_usd) cost
                from jobs where credit_day > cloud.utc_today() - p_days group by credit_day, feature) f), '[]'::jsonb),
    'by_hour_today', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'cost_usd', cost, 'jobs', n) order by h)
        from (select extract(hour from (created_at at time zone 'utc'))::int h, sum(cost_usd) cost, count(*) n
                from jobs where credit_day = cloud.utc_today() group by 1) x), '[]'::jsonb),
    'queue', jsonb_build_object(
      'queued', (select count(*) from jobs where status = 'queued'),
      'running', (select count(*) from jobs where status = 'running'))
  )
$$;

-- Only the app server's role may run these; nobody gets the tables.
revoke all on all tables in schema cloud from public, anon, authenticated;
revoke all on all functions in schema cloud from public, anon, authenticated;
