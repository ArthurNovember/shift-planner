-- Run this once in the Supabase SQL Editor (Supabase dashboard -> SQL Editor -> New query).
-- Creates the three singleton tables that hold the app's shared data (one JSON blob each,
-- mirroring what used to live in each browser's localStorage) and locks them down so only
-- a signed-in user (the one shared team login) can read or write them.

create table if not exists employees_state (
  id int primary key default 1,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint employees_state_singleton check (id = 1)
);

create table if not exists schedules_state (
  id int primary key default 1,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint schedules_state_singleton check (id = 1)
);

create table if not exists unavailability_state (
  id int primary key default 1,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint unavailability_state_singleton check (id = 1)
);

alter table employees_state enable row level security;
alter table schedules_state enable row level security;
alter table unavailability_state enable row level security;

create policy "authenticated only" on employees_state
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "authenticated only" on schedules_state
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "authenticated only" on unavailability_state
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
