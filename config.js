// ============================================================
// CONFIGURAÇÃO SUPABASE
// O Project URL e a chave pública (anon key) são seguros de
// manter aqui — são feitos para correr no lado do cliente.
// A segurança real vem das regras RLS definidas no setup.sql.
// ============================================================

const SUPABASE_URL = 'https://tihwfwexvfsfraqkvtll.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_oqM7klJ9V0hvzxv1MxG9RQ_fQtItrJ2';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
