-- Migration 0002 (expand, Supabase part): grants for the new function signatures.
-- New columns inherit the existing table grants and RLS policies.

revoke execute on function
  public.claim_event(text, text, uuid, boolean, integer),
  public.link_customer(text, text, text, uuid, boolean)
  from public, anon, authenticated;

grant execute on function
  public.claim_event(text, text, uuid, boolean, integer),
  public.link_customer(text, text, text, uuid, boolean)
  to service_role;
