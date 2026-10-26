// Supabase Edge Function: AI Intent Bridge (server side).
// STATUS: prepared, NOT deployed or tested (no AI provider key was available).
// The API key lives only in the function's secrets, never in the app:
//   supabase secrets set ANTHROPIC_API_KEY=...  &&  supabase functions deploy intent-bridge
// The app keeps using DemoIntentBridge until this is deployed and the patient
// has been told their answers are processed by an external AI provider.

const SYSTEM = `You help a patient communicate symptoms to their doctor. You never diagnose,
never suggest causes or treatments, and never invent details. Given the patient's selected body
regions, sensations and optional details, return JSON {"questions":[{"id","text","format":"yes_no"|"choice"|"text","options":[{"label","reportValue"}],"reason"}]}
asking ONLY about missing, ambiguous or contradictory information, at most 5 questions,
in short plain sentences. Respect the patient's communication preferences.`;

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization');
  if (!auth) return new Response('Unauthorized', { status: 401 });
  // TODO before deploy: verify the JWT with supabase-js getUser() and that the
  // caller owns the consultation referenced in the body.
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return new Response(JSON.stringify({ error: 'ai_not_configured' }), { status: 503 });
  const { regionIds, sensations, details, preferences } = await req.json();
  // Data minimization: send only the symptom fields, never names, emails or IDs.
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: Deno.env.get('INTENT_BRIDGE_MODEL') ?? 'claude-sonnet-5-5',
      max_tokens: 800,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ regionIds, sensations, details, preferences }) }],
    }),
  });
  if (!r.ok) return new Response(JSON.stringify({ error: 'ai_failed' }), { status: 502 });
  const data = await r.json();
  const text = data.content?.[0]?.text ?? '{}';
  // The app validates this shape and falls back to demo rules on any error.
  return new Response(text, { headers: { 'content-type': 'application/json' } });
});
