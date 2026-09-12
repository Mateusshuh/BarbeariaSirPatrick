// =============================================================================
// Chaves do projeto
// =============================================================================
// As duas são PÚBLICAS por desenho. A anon key vai no JavaScript de qualquer
// aplicação Supabase que roda no navegador — quem protege os dados é a RLS
// escrita na migração 001, nunca o JavaScript.
//
// O que NUNCA pode aparecer aqui: a service_role e a VAPID privada. Elas
// existem só nos segredos da Edge Function. Se em algum momento for preciso
// uma delas no navegador, o desenho está errado.
//
// Onde achar os valores: painel do Supabase → Project Settings → API.
// =============================================================================

export const SUPABASE_URL = "https://COLE-AQUI.supabase.co";
export const SUPABASE_ANON_KEY = "COLE-AQUI-A-ANON-KEY";

// Endereço da API no Render, sem barra no fim. É para onde vão as escritas:
// pedir, cancelar, confirmar, recusar. Ler o que está livre não passa por aqui,
// e isso é deliberado — o Web Service gratuito dorme depois de 15 minutos.
//
// Em desenvolvimento: "http://localhost:3000".
export const API_URL = "https://sirpatrick-api.onrender.com";

// Chave pública do Web Push (Fase 4). Fica vazia enquanto a Edge Function não
// estiver publicada; sem ela a tela simplesmente não oferece notificação.
export const VAPID_PUBLIC_KEY = "";

// Fuso da barbearia. Toda data exibida é formatada com ele, e não com o fuso
// do aparelho do cliente: quem viaja continua vendo o horário de Três de Maio.
export const FUSO = "America/Sao_Paulo";

// Usado para abrir a conversa do WhatsApp a partir do painel.
export const DDI_PADRAO = "55";
