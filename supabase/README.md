# Clipbench cloud database (Supabase)

Phase 4 cloud AI: daily credits, the global budget and the job queue. Project `clipbench` (`todmqrblsqovflqbcmyf`, ap-south-1).

- **Migrations:** `migrations/`, applied in order. Everything lives in the private `cloud` schema. Supabase's REST and GraphQL APIs don't expose it, and RLS denies all table access.
- **Server role:** the app connects as `clipbench_server`, which may only **execute** `cloud.*` functions. It was created once, outside the migrations, so its password stays out of git:
  ```sql
  create role clipbench_server login password '<generated>' noinherit;
  grant usage on schema cloud to clipbench_server;
  grant execute on all functions in schema cloud to clipbench_server;
  ```
  Any migration that adds a function must also `grant execute ... to clipbench_server` and revoke it from `public, anon, authenticated`.
- **Connection:** `CLOUD_DATABASE_URL=postgresql://clipbench_server.<project-ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres` (the transaction pooler). TLS is verified against `prod-ca-2021.crt`, Supabase's public root CA.
- **Storage:** a private bucket `cloud-uploads` (200 MB, audio/video/image). The server signs upload URLs with `SUPABASE_SECRET_KEY`, and the worker deletes uploads 24 h after their job ends.
- **Tests:** `src/lib/cloud/db.integration.test.ts` runs against a real database. Use a development project only; see the file header.
