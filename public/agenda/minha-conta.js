// =============================================================================
// Minha conta — pedidos, próximo corte, histórico e dados
// =============================================================================
// A RLS já garante que esta tela só enxerga o que é desta pessoa: a consulta
// não filtra por cliente_id, o banco filtra. Nome e telefone de um cliente
// nunca chegam ao navegador de outro.
// =============================================================================

import { supabase, mensagemDeErro } from "/shared/supabase.js";
import { api, mensagemDaApi, acordarApi, avisarDemora } from "/shared/api.js";
import { exigirSessao, sair, tratarSessaoMorta } from "/shared/sessao.js";
import {
  $, escapar, aviso, limparAviso, ocupado, montarTopo,
  quandoPorExtenso, quandoCurto, selo, dinheiro, intervaloHumano
} from "/shared/ui.js";

const { perfil } = await exigirSessao();
montarTopo($("#topo"), perfil);
$("#topo").addEventListener("click", (e) => {
  if (e.target.matches("[data-sair]")) { e.preventDefault(); sair(); }
});

// Cancelar passa pela API, e a API pode estar dormindo: cutuca logo na abertura.
acordarApi();

const ATIVOS = ["pendente", "confirmado"];
let config = {};

$("#form-dados").nome.value = perfil.nome || "";
$("#form-dados").telefone.value = perfil.telefone || "";

await carregar();

// -----------------------------------------------------------------------------
// Carga
// -----------------------------------------------------------------------------
async function carregar() {
  const [{ data: pedidos, error }, { data: cfg }] = await Promise.all([
    supabase.from("agendamentos")
      .select("id, periodo, status, motivo_recusa, criado_em, servicos(nome, preco_centavos)")
      .order("periodo", { ascending: false })
      .limit(60),
    supabase.from("configuracoes").select("chave, valor")
  ]);

  if (error) {
    if (tratarSessaoMorta(error)) return;
    aviso($("#aviso-geral"), mensagemDeErro(error, "Não consegui carregar seus agendamentos."));
    return;
  }

  config = Object.fromEntries((cfg || []).map((c) => [c.chave, c.valor]));

  const agora = Date.now();
  const pendentes = pedidos.filter((p) => p.status === "pendente");
  const confirmados = pedidos
    .filter((p) => p.status === "confirmado" && inicioDe(p.periodo) >= agora)
    .sort((a, b) => inicioDe(a.periodo) - inicioDe(b.periodo));
  const historico = pedidos.filter((p) => !pendentes.includes(p) && !confirmados.includes(p));

  secao("#secao-pendentes", "#pendentes", pendentes);
  secao("#secao-confirmados", "#confirmados", confirmados);
  secao("#secao-historico", "#historico", historico);

  $("#secao-vazio").hidden = pendentes.length + confirmados.length + historico.length > 0;
}

function secao(secaoSel, listaSel, itens) {
  $(secaoSel).hidden = itens.length === 0;
  if (itens.length) $(listaSel).innerHTML = itens.map(cartao).join("");
}

function inicioDe(periodo) {
  const bruto = String(periodo).replace(/^[\[(]/, "").split(",")[0].replace(/"/g, "").trim();
  return new Date(bruto.replace(" ", "T")).getTime();
}

// -----------------------------------------------------------------------------
// Um pedido na lista
// -----------------------------------------------------------------------------
function cartao(p) {
  const inicio = inicioDe(p.periodo);
  const futuro = inicio > Date.now();
  const podeCancelar = ATIVOS.includes(p.status) && futuro && dentroDoPrazo(p, inicio);

  const preco = p.servicos?.preco_centavos;
  const detalhe = [
    escapar(p.servicos?.nome || "Serviço"),
    preco > 0 ? dinheiro(preco) : null,
    p.status === "pendente" ? `pedido ${intervaloHumano(p.criado_em)}` : null,
    p.status === "recusado" && p.motivo_recusa ? `motivo: ${escapar(p.motivo_recusa)}` : null
  ].filter(Boolean).join(" · ");

  return `
    <article class="pedido" data-status="${p.status}">
      <div>
        <div class="pedido-quando">${futuro ? quandoPorExtenso(inicio) : quandoCurto(inicio)}</div>
        <div class="pedido-info">${detalhe}</div>
      </div>
      <div class="pedido-acoes">
        ${selo(p.status)}
        ${podeCancelar
          ? `<button class="btn btn-perigo" type="button" data-cancelar="${p.id}">Cancelar</button>`
          : ""}
        ${ATIVOS.includes(p.status) && futuro && !podeCancelar
          ? `<span class="texto-apoio">Cancelamento só até ${Math.round(Number(config.cancelamento_min || 120) / 60)}h antes</span>`
          : ""}
      </div>
    </article>`;
}

/**
 * Pedido pendente pode ser retirado a qualquer momento: ninguém se organizou
 * em cima dele ainda, e deixá-lo preso só segura um horário que o Patrick
 * poderia dar a outra pessoa. O prazo de cancelamento existe para o que já foi
 * CONFIRMADO — aí sim há compromisso dos dois lados.
 */
function dentroDoPrazo(p, inicio) {
  if (p.status === "pendente") return true;
  const minutos = Number(config.cancelamento_min || 120);
  return inicio - Date.now() > minutos * 60000;
}

// -----------------------------------------------------------------------------
// Cancelar
// -----------------------------------------------------------------------------
document.addEventListener("click", async (evento) => {
  const botao = evento.target.closest("[data-cancelar]");
  if (!botao) return;

  if (!confirm("Cancelar este agendamento? O horário volta para a agenda na hora.")) return;

  limparAviso($("#aviso-geral"));
  const liberar = ocupado(botao, "Cancelando…");

  // Quem cancela é a API: ela confere o prazo, o limite do mês e avisa o
  // Patrick de que um horário confirmado vagou. O navegador só pede.
  const cancelarAviso = avisarDemora(botao, "Acordando o servidor…");

  try {
    await api(`/api/pedidos/${botao.dataset.cancelar}/cancelar`, { metodo: "POST" });
  } catch (erro) {
    cancelarAviso();
    liberar();
    if (tratarSessaoMorta(erro)) return;
    aviso($("#aviso-geral"), mensagemDaApi(erro, "Não consegui cancelar. Tente de novo."));
    return;
  }

  cancelarAviso();
  liberar();
  aviso($("#aviso-geral"), "Cancelado. O horário já voltou para a agenda.", "ok");
  await carregar();
});

// -----------------------------------------------------------------------------
// Meus dados
// -----------------------------------------------------------------------------
$("#form-dados").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const form = evento.target;
  const caixa = $("#aviso-dados");
  limparAviso(caixa);

  const nome = form.nome.value.trim();
  const telefone = form.telefone.value.trim();

  if (nome.length < 2) return aviso(caixa, "Escreva seu nome.");
  if (telefone.replace(/\D/g, "").length < 10) {
    return aviso(caixa, "O WhatsApp precisa do DDD. Exemplo: (55) 99999-0000.");
  }

  const botao = form.querySelector("button");
  const liberar = ocupado(botao, "Salvando…");
  const cancelarAviso = avisarDemora(botao);

  // Pela API, como toda escrita. Poderia ir direto ao Supabase — a RLS deixa o
  // cliente editar o próprio perfil —, mas ter duas portas de escrita para a
  // mesma tabela é ter duas versões da mesma regra para manter.
  try {
    await api("/api/eu", { metodo: "PUT", corpo: { nome, telefone } });
  } catch (erro) {
    cancelarAviso();
    liberar();
    if (tratarSessaoMorta(erro)) return;
    return aviso(caixa, mensagemDaApi(erro, "Não consegui salvar."));
  }

  cancelarAviso();
  liberar();
  aviso(caixa, "Pronto, dados atualizados.", "ok");
});
