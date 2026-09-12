// =============================================================================
// Chaves do projeto
// =============================================================================

export const SUPABASE_URL = "https://lpjixbysizfwmyfduybb.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_opgq30ubjP7HZ4hGP14Ybw_ZTYBZ1Pf";

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);

export const API_URL = LOCAL
  ? "http://localhost:3000"
  : "https://sirpatrick-api.onrender.com";

export const VAPID_PUBLIC_KEY = "BKuXlFfMUUfeNooQi-5r0j1fi4nwbkT1WQGZC3YSqB7-KeoRqLKK5WMr6bddP0HwdC9pbIXRENEnSaHzBK9U0HI";

export const FUSO = "America/Sao_Paulo";

export const DDI_PADRAO = "55";
