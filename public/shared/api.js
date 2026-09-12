// =============================================================================
// Conversa com a API no Render
// =============================================================================
// Divisão de trabalho, e o porquê dela:
//
//   LER o que está livre  → direto no Supabase (RPC), porque é o que a pessoa
//                           faz assim que abre a tela, e o Web Service gratuito
//                           do Render dorme depois de 15 minutos. Um minuto de
//                           tela vazia para ver se tem vaga na terça é perder
//                           o cliente.
//
//   ESCREVER              → pela API, porque é aqui que moram as chaves
//                           privadas e as regras que não podem ser burladas.
//                           Escrever é clique com botão e spinner: ali a espera
//                           de um serviço acordando é tolerável.
// =============================================================================

import { API_URL } from "./config.js";
import { supabase } from "./supabase.js";

/**
 * Chama a API com o token da sessão.
 * Erros viram Error com .codigo (o código estável que a API devolve) e .status.
 */
export async function api(caminho, { metodo = "GET", corpo } = {}) {
  const { data: { session } } = await supabase.auth.getSession();

  const resposta = await fetch(API_URL + caminho, {
    method: metodo,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });

  let dados = null;
  try { dados = await resposta.json(); } catch (_) { /* corpo vazio */ }

  if (!resposta.ok) {
    const erro = new Error(dados?.erro || `HTTP ${resposta.status}`);
    erro.codigo = dados?.erro;
    erro.status = resposta.status;
    erro.dados = dados;
    throw erro;
  }

  return dados;
}

/**
 * Cutuca a API assim que a tela abre, sem esperar resposta.
 * Enquanto a pessoa escolhe serviço, dia e horário — o que leva uns bons
 * segundos — o serviço acorda em segundo plano. Quando ela clicar em "Pedir",
 * ele já está de pé. É o truque que torna o plano gratuito suportável.
 */
export function acordarApi() {
  fetch(API_URL + "/api/saude", { cache: "no-store" }).catch(() => {});
}

// -----------------------------------------------------------------------------
// Código estável → frase que diz o que fazer
// -----------------------------------------------------------------------------
// A API nunca devolve texto do Postgres. Ela devolve HORARIO_OCUPADO, e a
// tradução para gente mora aqui.
const FRASES = {
  HORARIO_OCUPADO: "Alguém acabou de pedir esse horário. Escolha outro — a lista já está atualizada.",
  HORARIO_INDISPONIVEL: "Esse horário não está mais disponível. Escolha outro na lista.",
  JA_TEM_NO_DIA: "Você já tem um pedido para esse dia.",
  JA_RESPONDIDO: "Esse pedido já tinha sido respondido. A lista foi recarregada.",
  FORA_DO_PRAZO: "Passou do prazo para cancelar sozinho. Fale com o Patrick pelo WhatsApp.",
  LIMITE_CANCELAMENTOS: "Você atingiu o limite de cancelamentos deste mês. Fale com o Patrick pelo WhatsApp.",
  ANTECEDENCIA: "Esse horário está muito em cima. Escolha um com mais antecedência.",
  FORA_DA_JANELA: "Esse dia ainda não abriu para agendamento.",
  EMAIL_NAO_CONFIRMADO: "Confirme seu e-mail antes de pedir um horário — o link está na sua caixa de entrada.",
  SERVICO_INVALIDO: "Esse serviço não existe mais. Recarregue a página e escolha de novo.",
  PERFIL_INCOMPLETO: "Faltam seus dados. Abra “Minha conta”, preencha nome e WhatsApp e tente de novo.",
  NAO_ENCONTRADO: "Não achei esse agendamento.",
  NAO_PODE_REMARCAR: "Esse agendamento não pode mais ser remarcado.",
  DADOS_INVALIDOS: "Faltou alguma informação. Confira os campos e tente de novo.",
  SEM_PERMISSAO: "Essa ação é só do Patrick.",
  SEM_SESSAO: "Entre na sua conta para continuar.",
  SESSAO_INVALIDA: "Sua sessão expirou. Entre de novo para continuar.",
  MUITAS_TENTATIVAS: "Muitas tentativas seguidas. Espere um minuto e tente de novo.",
  CONFLITO: "Tem gente marcada nesse período.",
  AUTH_INDISPONIVEL: "Não consegui confirmar sua sessão agora. Tente de novo em instantes.",
  ERRO_INTERNO: "Deu problema do nosso lado. Tente de novo em instantes."
};

export function mensagemDaApi(erro, padrao) {
  if (erro?.codigo && FRASES[erro.codigo]) return FRASES[erro.codigo];

  // Falha de rede: quase sempre é o serviço acordando, ou internet caindo.
  if (erro instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(erro?.message))) {
    return "Não consegui falar com o servidor. Ele pode estar acordando — tente de novo em alguns segundos.";
  }

  console.error("[api]", erro);
  return padrao || "Algo deu errado. Tente de novo em instantes.";
}

/**
 * Troca o texto do botão quando a espera passa de alguns segundos, para a
 * pessoa entender que não travou. Devolve a função que cancela o aviso.
 */
export function avisarDemora(botao, texto = "Acordando o servidor…") {
  const id = setTimeout(() => { botao.textContent = texto; }, 3500);
  return () => clearTimeout(id);
}
