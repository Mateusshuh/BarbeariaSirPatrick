// =============================================================================
// Guarda de sessão
// =============================================================================
// Chamada no topo de TODA página protegida, antes de desenhar qualquer coisa.
// A agenda inteira exige conta: quem chega sem sessão vai para entrar.html e
// não vê grade, nem serviço, nem horário ocupado.
// =============================================================================

import { supabase, sessaoMorreu } from "./supabase.js";

const CHAVE_DESTINO = "agenda:destino";
const LOGIN = "/agenda/entrar.html";

// Guarda para onde a pessoa queria ir. Importa para quem chega por link direto
// de uma notificação ou de um e-mail: depois de entrar ela volta para lá, e não
// para uma tela genérica.
export function guardarDestino(url) {
  try {
    sessionStorage.setItem(CHAVE_DESTINO, url || location.pathname + location.search);
  } catch (_) { /* aba anônima com storage bloqueado: segue sem o atalho */ }
}

export function consumirDestino(padrao = "/agenda/") {
  let destino = null;
  try {
    destino = sessionStorage.getItem(CHAVE_DESTINO);
    sessionStorage.removeItem(CHAVE_DESTINO);
  } catch (_) { /* idem */ }
  // Só caminho interno: destino vindo de fora vira porta para phishing.
  if (destino && destino.startsWith("/") && !destino.startsWith("//")) return destino;
  return padrao;
}

function revelar() {
  document.documentElement.classList.remove("aguardando-sessao");
}

function irParaLogin(motivo) {
  guardarDestino();
  const extra = motivo ? "?motivo=" + encodeURIComponent(motivo) : "";
  location.replace(LOGIN + extra);
}

/**
 * Exige sessão e devolve { usuario, perfil }.
 * Quando não há sessão, redireciona e devolve uma promessa que NUNCA resolve —
 * assim o código da página para aqui e não chega a desenhar nada enquanto o
 * navegador troca de endereço. Grade piscando na tela antes do redirecionamento
 * entrega informação para quem não deveria ver.
 */
export async function exigirSessao({ admin = false } = {}) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    irParaLogin();
    return new Promise(() => {});
  }

  let perfil = await lerPerfil(session.user);

  if (admin && perfil.papel !== "admin") {
    // Conveniência de navegação, não segurança: quem segura de verdade é a RLS.
    location.replace("/agenda/");
    return new Promise(() => {});
  }

  // Sessão que expira ou logout em outra aba não pode deixar a tela aberta.
  supabase.auth.onAuthStateChange((evento) => {
    if (evento === "SIGNED_OUT") irParaLogin("sessao");
  });

  revelar();
  return { usuario: session.user, perfil, sessao: session };
}

async function lerPerfil(usuario) {
  const { data, error } = await supabase
    .from("perfis").select("id, nome, telefone, papel")
    .eq("id", usuario.id).maybeSingle();

  if (error) {
    if (sessaoMorreu(error)) { irParaLogin("sessao"); return new Promise(() => {}); }
    throw error;
  }

  if (data) return data;

  // Rede de segurança: se o gatilho do cadastro não tiver rodado (conta criada
  // antes da migração, por exemplo), a pessoa ficaria sem perfil e sem poder
  // agendar, sem nenhuma saída pela tela.
  //
  // Quem recria é a API — o navegador não escreve em perfis desde a migração
  // 004. É o único ponto do carregamento que depende do serviço acordar, e é
  // aceitável porque só acontece quando algo já deu errado antes.
  const { api } = await import("./api.js");
  const eu = await api("/api/eu");
  return { id: eu.id, nome: eu.nome, telefone: eu.telefone, papel: eu.papel };
}

export async function sair() {
  await supabase.auth.signOut();
  location.replace(LOGIN);
}

// Chamada por qualquer tela quando uma resposta volta com 401: em vez de
// quebrar, manda para o login com aviso.
export function tratarSessaoMorta(erro) {
  if (sessaoMorreu(erro)) { irParaLogin("sessao"); return true; }
  return false;
}
