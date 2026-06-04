-- Run this once in Supabase: SQL Editor -> paste -> Run.
create table if not exists articles (
  id text primary key,
  title text, summary text, url text, domain text, source text,
  published timestamptz, category text,
  virality_score real, niche_fit real, matched_niche text,
  sensitive boolean default false,
  breakdown jsonb default '{}'::jsonb,
  first_seen timestamptz default now(),
  last_scored timestamptz default now()
);
create index if not exists idx_articles_vir on articles (virality_score desc);

-- Let the dashboard read the table with the public anon key (read-only).
alter table articles enable row level security;
drop policy if exists "public read" on articles;
create policy "public read" on articles for select to anon using (true);
