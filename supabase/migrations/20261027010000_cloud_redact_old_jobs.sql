-- Data minimization (privacy page): after p_older_than, a finished job keeps only what budgeting and abuse prevention
-- need (feature, owner key, times, credits, cost); what the user sent and got back is wiped.
create function cloud.redact_old_jobs(p_older_than interval) returns integer
language sql security definer set search_path = cloud, pg_temp
as $$
  with r as (
    update jobs set params = '{}'::jsonb, result = null, error = null
     where created_at < now() - p_older_than
       and status in ('succeeded', 'failed', 'cancelled')
       and (params <> '{}'::jsonb or result is not null or error is not null)
    returning 1)
  select count(*)::integer from r
$$;
revoke all on function cloud.redact_old_jobs(interval) from public, anon, authenticated;
grant execute on function cloud.redact_old_jobs(interval) to clipbench_server;
