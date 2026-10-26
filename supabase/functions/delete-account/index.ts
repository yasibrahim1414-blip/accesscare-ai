// Supabase Edge Function: delete the caller's own account.
// STATUS: prepared, NOT deployed or tested (no Supabase project available).
// Deleting an auth user needs the service-role key, which lives only in this
// function's environment (set automatically by Supabase), never in the app.
// Deploy: supabase functions deploy delete-account

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

Deno.serve(async (req) => {
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer /, '');
  if (!jwt) return new Response('Unauthorized', { status: 401 });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return new Response('Unauthorized', { status: 401 });
  // profiles and all owned rows are removed by ON DELETE CASCADE in schema.sql
  const del = await admin.auth.admin.deleteUser(data.user.id);
  if (del.error) return new Response(JSON.stringify({ error: 'delete_failed' }), { status: 500 });
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
});
