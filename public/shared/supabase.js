// =============================================================================
// Cliente Supabase e tradução de erros
// =============================================================================
// Uma única instância para o site inteiro. Importada como módulo ES direto da
// CDN: não existe build neste projeto, e não vai existir.
// =============================================================================

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

if (SUPABASE_URL.includes("COLE-AQUI")) {
  // Falha barulhenta é melhor que tela branca: quem publicar sem preencher as
  // chaves descobre no primeiro carregamento, não no primeiro cliente.
  document.documentElement.classList.remove("aguardando-sessao");
  document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.classList.remove("aguardando-sessao");
    document.body.innerHTML =
      '<div style="padding:40px;font-family:system-ui">' +
      "<h1>Falta configurar</h1><p>Preencha <code>public/shared/config.js</code> " +
      "com a URL e a anon key do projeto no Supabase.</p></div>";
  });
  throw new Error("config.js não foi preenchido");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // A sessão precisa sobreviver ao fechar da aba: o cliente volta dias depois
    // para ver se o Patrick respondeu. Quem guarda o token é o supabase-js, e
    // isso é responsabilidade dele — a regra de não usar localStorage vale para
    // estado da aplicação, não para a sessão.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

// -----------------------------------------------------------------------------
// Tradução de erro
// -----------------------------------------------------------------------------
// O Postgres e o GoTrue falam em código. O cliente precisa ler o que fazer em
// seguida. Nunca mostre a mensagem crua: "duplicate key value violates unique
// constraint um_por_dia" não significa nada para quem quer cortar o cabelo.

const PORCODIGO = {
  // trava de sobreposição: alguém pegou o horário no meio do caminho
  "23P01": "Alguém acabou de pedir esse horário. Escolha outro na lista — ela já está atualizada.",
  // trava de um por dia
  "23505": "Você já tem um pedido para esse dia.",
  // RLS recusou
  "42501": "Você não tem permissão para isso. Entre de novo e tente outra vez.",
  "23503": "Esse serviço não existe mais. Recarregue a página e escolha de novo.",
  "23514": "Faltou alguma informação no pedido. Recarregue a página e tente de novo.",
  PGRST301: "Sua sessão expirou. Entre de novo para continuar."
};

const PORMENSAGEM = [
  [/already registered|already been registered|user already exists/i,
   "Esse e-mail já tem conta. Use a aba Entrar, ou recupere a senha."],
  [/invalid login credentials/i,
   "E-mail ou senha não conferem. Confira e tente de novo — se esqueceu, use “Esqueci minha senha”."],
  [/email not confirmed/i,
   "Falta confirmar seu e-mail. Abra o link que enviamos na sua caixa de entrada."],
  [/password should be at least|password is too short/i,
   "A senha precisa de pelo menos 6 caracteres."],
  [/rate limit|too many requests/i,
   "Muitas tentativas seguidas. Espere um minuto e tente de novo."],
  [/for security purposes/i,
   "Espere alguns segundos antes de pedir outro e-mail."],
  [/unable to validate email|invalid format/i,
   "Esse e-mail parece incompleto. Confira o endereço."],
  [/failed to fetch|networkerror|load failed/i,
   "Não consegui falar com o servidor. Confira sua internet e tente de novo."]
];

export function mensagemDeErro(erro, padrao) {
  if (!erro) return padrao || "Algo deu errado. Tente de novo.";
  const codigo = erro.code || erro.status;
  if (codigo && PORCODIGO[codigo]) return PORCODIGO[codigo];

  // P0001 é o código de um raise exception nosso: essas mensagens já foram
  // escritas em português, para o cliente ler. Mostrar o texto do banco aqui é
  // a exceção que confirma a regra — porque o texto é nosso, não do Postgres.
  if (codigo === "P0001" && erro.message) return erro.message;

  const texto = String(erro.message || erro.error_description || erro);
  for (const [regra, mensagem] of PORMENSAGEM) {
    if (regra.test(texto)) return mensagem;
  }

  console.error("[agenda]", erro);
  return padrao || "Algo deu errado. Tente de novo em instantes.";
}

// Sessão que morre no meio do uso não pode quebrar a tela: manda para o login
// com aviso, guardando de onde a pessoa saiu.
export function sessaoMorreu(erro) {
  const codigo = String(erro?.code || "");
  const status = Number(erro?.status || 0);
  return status === 401 || codigo === "PGRST301" || /jwt expired|invalid token/i.test(String(erro?.message || ""));
}
