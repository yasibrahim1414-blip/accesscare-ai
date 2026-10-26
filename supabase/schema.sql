-- AccessCare AI — production schema for Supabase (Postgres + RLS).
-- STATUS: prepared, NOT yet applied or tested against a live project
-- (no Supabase credentials were available). Apply with the Supabase SQL editor
-- or `supabase db push`, then wire a SupabaseBackend implementing
-- src/services/backend/Backend.ts.

create extension if not exists pgcrypto;

-- ---------- profiles ----------
create type public.user_role as enum ('patient', 'doctor');
create type public.consultation_status as enum ('draft', 'new', 'in_review', 'completed', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null,
  full_name text not null check (char_length(full_name) between 2 and 80),
  created_at timestamptz not null default now()
);

create table public.doctor_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  doctor_id text not null unique check (doctor_id ~ '^AC-DOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$'),
  specialty text check (char_length(specialty) <= 60),
  clinic text check (char_length(clinic) <= 80)
);

create table public.patient_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade
);

create table public.communication_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  share_with_doctor boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- connections ----------
create table public.patient_doctor_connections (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  doctor_user_id uuid not null references public.profiles(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
-- one active doctor per patient, no duplicates
create unique index one_active_doctor on public.patient_doctor_connections(patient_id) where active;

-- ---------- consultations ----------
create table public.consultations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  doctor_user_id uuid references public.profiles(id) on delete set null,
  status public.consultation_status not null default 'draft',
  region_ids text[] not null default '{}',
  details jsonb not null default '{}'::jsonb,
  urgent_guidance_shown boolean not null default false,
  kind text not null default 'consultation' check (kind in ('consultation','signal')),  -- 'signal' = Silent Signal AI session
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  shared_at timestamptz
);

create table public.consultation_symptoms (
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  sensation text not null check (sensation in ('pain','numbness','burning','itching','swelling','weakness','tingling','other','not_sure')),
  primary key (consultation_id, sensation)
);

create table public.consultation_summaries (
  consultation_id uuid primary key references public.consultations(id) on delete cascade,
  approved_text text not null check (char_length(approved_text) between 5 and 4000),
  report jsonb not null,
  clarification_answers jsonb not null default '[]'::jsonb,
  edited_by_patient boolean not null,
  approved_at timestamptz not null default now()
);

create table public.consultation_messages (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'text' check (kind in ('text','yes_no_question','clarification','clarification_answer','prescription','followup','followup_answer','visit_summary','body_probe','body_probe_answer','teachback')),
  body text not null check (char_length(body) between 1 and 2000),
  meta jsonb,  -- clarification item, format, options, the patient's raw selection, wording source, patient approval
  created_at timestamptz not null default now()
);

create table public.doctor_notes (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  doctor_user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- Clinical Intelligence Engine: the doctor's private decision-support record (analysis, documented
-- allergies/medicines, review decisions, prescriptions and their audit log). Never readable by the patient.
create table public.clinical_reviews (
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  doctor_user_id uuid not null references public.profiles(id) on delete cascade,
  data jsonb not null check (pg_column_size(data) < 500000),
  updated_at timestamptz not null default now(),
  primary key (consultation_id, doctor_user_id)
);

-- symptom diary: written by the patient; shared_with = the connected doctor the patient chose to share it with
create table public.diary_entries (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  shared_with uuid references public.profiles(id) on delete set null,
  data jsonb not null check (pg_column_size(data) < 20000),
  at timestamptz not null default now()
);
create index diary_by_patient on public.diary_entries(patient_id, at desc);

-- care records: medicine check-ins, wound photos (compressed JPEG), the emergency card (never shared)
create table public.patient_records (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,60}$'),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('dose', 'photo', 'card')),
  shared_with uuid references public.profiles(id) on delete set null,
  data jsonb not null check (pg_column_size(data) < 200000),
  at timestamptz not null default now(),
  check (kind <> 'card' or shared_with is null)
);
create index records_by_patient on public.patient_records(patient_id, kind, at desc);

create table public.consultation_status_history (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  from_status public.consultation_status,
  to_status public.consultation_status not null,
  by_user uuid references public.profiles(id) on delete set null,
  at timestamptz not null default now()
);

-- audit trail: approvals, shares, views, status changes (append-only)
create table public.consultation_audit (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  actor uuid references public.profiles(id) on delete set null,
  action text not null check (char_length(action) <= 60),
  detail text check (char_length(detail) <= 200),
  at timestamptz not null default now()
);

-- ---------- helper predicates (security definer, fixed search_path) ----------
create or replace function public.my_role() returns public.user_role
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() $$;

create or replace function public.is_connected(p_patient uuid, p_doctor uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from patient_doctor_connections
                  where patient_id = p_patient and doctor_user_id = p_doctor and active) $$;

create or replace function public.can_access_consultation(c_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from consultations c where c.id = c_id and (
      c.patient_id = auth.uid()
      or (c.doctor_user_id = auth.uid() and c.status <> 'draft' and is_connected(c.patient_id, auth.uid()))
    ))
$$;

-- ---------- signup: profile + collision-safe Doctor ID ----------
-- Role comes from signUp options.data.role; the client can never choose a Doctor ID.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := coalesce((new.raw_user_meta_data->>'role')::user_role, 'patient');
  v_id text; alphabet text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; i int; tries int := 0;
begin
  insert into profiles(id, role, full_name) values (new.id, v_role, coalesce(new.raw_user_meta_data->>'full_name', 'User'));
  insert into communication_preferences(user_id) values (new.id);
  if v_role = 'doctor' then
    loop
      v_id := 'AC-DOC-';
      for i in 1..6 loop
        v_id := v_id || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 31), 1);
      end loop;
      begin
        insert into doctor_profiles(user_id, doctor_id, specialty, clinic)
        values (new.id, v_id, new.raw_user_meta_data->>'specialty', new.raw_user_meta_data->>'clinic');
        exit;
      exception when unique_violation then
        tries := tries + 1; if tries > 20 then raise; end if;
      end;
    end loop;
  else
    insert into patient_profiles(user_id) values (new.id);
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- RPCs for privileged operations ----------
create or replace function public.lookup_doctor(p_doctor_id text)
returns table(doctor_id text, full_name text, specialty text, clinic text)
language sql stable security definer set search_path = public as $$
  select d.doctor_id, p.full_name, d.specialty, d.clinic
  from doctor_profiles d join profiles p on p.id = d.user_id
  where d.doctor_id = upper(trim(p_doctor_id)) and my_role() = 'patient'
$$;

create or replace function public.connect_to_doctor(p_doctor_id text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_doc uuid; v_conn uuid;
begin
  if my_role() is distinct from 'patient' then raise exception 'forbidden'; end if;
  select user_id into v_doc from doctor_profiles where doctor_id = upper(trim(p_doctor_id));
  if v_doc is null then raise exception 'doctor_not_found'; end if;
  insert into patient_doctor_connections(patient_id, doctor_user_id) values (auth.uid(), v_doc) returning id into v_conn;
  return v_conn; -- unique index rejects a second active connection
end $$;

create or replace function public.approve_and_share(p_consultation uuid, p_text text, p_report jsonb, p_answers jsonb, p_edited boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_doc uuid;
begin
  select doctor_user_id into v_doc from patient_doctor_connections where patient_id = auth.uid() and active;
  if v_doc is null then raise exception 'no_doctor'; end if;
  update consultations set status = 'new', doctor_user_id = v_doc, shared_at = now(), updated_at = now()
    where id = p_consultation and patient_id = auth.uid() and status = 'draft';
  if not found then raise exception 'not_found_or_locked'; end if;
  insert into consultation_summaries(consultation_id, approved_text, report, clarification_answers, edited_by_patient)
    values (p_consultation, p_text, p_report, p_answers, p_edited)
    on conflict (consultation_id) do update set approved_text = excluded.approved_text, report = excluded.report,
      clarification_answers = excluded.clarification_answers, edited_by_patient = excluded.edited_by_patient, approved_at = now();
  insert into consultation_status_history(consultation_id, from_status, to_status, by_user) values (p_consultation, 'draft', 'new', auth.uid());
end $$;

create or replace function public.set_consultation_status(p_consultation uuid, p_status consultation_status)
returns void language plpgsql security definer set search_path = public as $$
declare v_from consultation_status;
begin
  if p_status not in ('new','in_review','completed') then raise exception 'invalid'; end if;
  select status into v_from from consultations where id = p_consultation
    and doctor_user_id = auth.uid() and status <> 'draft' and is_connected(patient_id, auth.uid()) for update;
  if v_from is null then raise exception 'not_found'; end if;
  update consultations set status = p_status, updated_at = now() where id = p_consultation;
  insert into consultation_status_history(consultation_id, from_status, to_status, by_user) values (p_consultation, v_from, p_status, auth.uid());
end $$;

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.doctor_profiles enable row level security;
alter table public.patient_profiles enable row level security;
alter table public.communication_preferences enable row level security;
alter table public.patient_doctor_connections enable row level security;
alter table public.consultations enable row level security;
alter table public.consultation_symptoms enable row level security;
alter table public.consultation_summaries enable row level security;
alter table public.consultation_messages enable row level security;
alter table public.doctor_notes enable row level security;
alter table public.clinical_reviews enable row level security;
alter table public.consultation_status_history enable row level security;

-- profiles: self, plus the other side of an active connection (name only is used)
create policy profiles_read on public.profiles for select using (
  id = auth.uid() or is_connected(id, auth.uid()) or is_connected(auth.uid(), id));
create policy profiles_update on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from profiles where id = auth.uid())); -- role can't change

create policy doctor_profiles_read on public.doctor_profiles for select using (
  user_id = auth.uid() or is_connected(auth.uid(), user_id));
create policy doctor_profiles_update on public.doctor_profiles for update using (user_id = auth.uid())
  with check (user_id = auth.uid() and doctor_id = (select doctor_id from doctor_profiles where user_id = auth.uid()));

create policy patient_profiles_self on public.patient_profiles for select using (user_id = auth.uid());

create policy prefs_self on public.communication_preferences for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy prefs_doctor_read on public.communication_preferences for select using (share_with_doctor and is_connected(user_id, auth.uid()));

-- connections: created only via connect_to_doctor(); either side may deactivate
create policy conn_read on public.patient_doctor_connections for select using (patient_id = auth.uid() or doctor_user_id = auth.uid());
create policy conn_deactivate on public.patient_doctor_connections for update
  using (patient_id = auth.uid() or doctor_user_id = auth.uid()) with check (active = false);

-- consultations: patient owns drafts; sharing and status go through RPCs
create policy cons_read on public.consultations for select using (can_access_consultation(id));
create policy cons_insert on public.consultations for insert with check (
  patient_id = auth.uid() and my_role() = 'patient' and status = 'draft' and doctor_user_id is null);
create policy cons_update_draft on public.consultations for update using (patient_id = auth.uid() and status = 'draft')
  with check (patient_id = auth.uid() and status = 'draft' and doctor_user_id is null);
create policy cons_delete_draft on public.consultations for delete using (patient_id = auth.uid() and status = 'draft');

create policy sym_read on public.consultation_symptoms for select using (can_access_consultation(consultation_id));
create policy sym_write on public.consultation_symptoms for all using (
  exists (select 1 from consultations c where c.id = consultation_id and c.patient_id = auth.uid() and c.status = 'draft'))
  with check (exists (select 1 from consultations c where c.id = consultation_id and c.patient_id = auth.uid() and c.status = 'draft'));

create policy sum_read on public.consultation_summaries for select using (can_access_consultation(consultation_id));

create policy msg_read on public.consultation_messages for select using (can_access_consultation(consultation_id));
create policy msg_send on public.consultation_messages for insert with check (
  sender_id = auth.uid() and can_access_consultation(consultation_id)
  and exists (select 1 from consultations c where c.id = consultation_id and c.status <> 'draft'
              and is_connected(c.patient_id, c.doctor_user_id))
  and ((my_role() = 'doctor' and kind in ('text','yes_no_question','clarification','prescription','followup','visit_summary','body_probe'))
    or (my_role() = 'patient' and kind in ('text','clarification_answer','followup_answer','body_probe_answer','teachback'))));

-- doctor notes: author only. Patients never read them.
create policy notes_doctor on public.doctor_notes for all using (doctor_user_id = auth.uid() and can_access_consultation(consultation_id))
  with check (doctor_user_id = auth.uid() and can_access_consultation(consultation_id));

create policy reviews_doctor on public.clinical_reviews for all using (doctor_user_id = auth.uid() and my_role() = 'doctor' and can_access_consultation(consultation_id))
  with check (doctor_user_id = auth.uid() and my_role() = 'doctor' and can_access_consultation(consultation_id));

alter table public.diary_entries enable row level security;
create policy diary_patient on public.diary_entries for all using (patient_id = auth.uid() and my_role() = 'patient')
  with check (patient_id = auth.uid() and my_role() = 'patient' and (shared_with is null or is_connected(auth.uid(), shared_with)));
create policy diary_doctor_read on public.diary_entries for select using (shared_with = auth.uid() and is_connected(patient_id, auth.uid()));

alter table public.patient_records enable row level security;
create policy records_patient on public.patient_records for all using (patient_id = auth.uid() and my_role() = 'patient')
  with check (patient_id = auth.uid() and my_role() = 'patient' and (shared_with is null or is_connected(auth.uid(), shared_with)));
create policy records_doctor_read on public.patient_records for select using (shared_with = auth.uid() and is_connected(patient_id, auth.uid()));

create policy hist_read on public.consultation_status_history for select using (can_access_consultation(consultation_id));

alter table public.consultation_audit enable row level security;
create policy audit_read on public.consultation_audit for select using (can_access_consultation(consultation_id));
create policy audit_insert on public.consultation_audit for insert with check (actor = auth.uid() and can_access_consultation(consultation_id));
-- no update/delete policies: the audit trail is append-only for app users

-- realtime for messages (optional)
alter publication supabase_realtime add table public.consultation_messages;
