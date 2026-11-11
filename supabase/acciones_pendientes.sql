-- Smart Project Agent: almacén de acciones pendientes de aprobación.
-- Ejecutar una sola vez en Supabase → SQL Editor.

create table if not exists public.acciones_pendientes (
  action_id   uuid primary key,
  token_hash  text        not null,             -- SHA-256 del token del correo (el token nunca se guarda)
  status      text        not null default 'PENDING'
              check (status in ('PENDING', 'APPROVED', 'FAILED', 'REJECTED')),
  datos       jsonb       not null,             -- detalle de la propuesta y resultado de ejecución
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  expires_at  timestamptz not null
);

create index if not exists acciones_pendientes_status_idx on public.acciones_pendientes (status, created_at desc);

-- Seguridad: RLS activado y SIN políticas.
-- Las claves públicas (anon/authenticated) no pueden leer ni escribir nada;
-- solo la service role key (usada únicamente en el servidor y en GitHub Actions) tiene acceso.
alter table public.acciones_pendientes enable row level security;

revoke all on public.acciones_pendientes from anon, authenticated;
