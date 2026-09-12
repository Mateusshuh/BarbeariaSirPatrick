// =============================================================================
// Painel do Patrick
// =============================================================================
// Uma tela, feita para ser usada em pé, com uma mão, entre um corte e outro.
// A fila vem antes de tudo e Confirmar é um toque só — se responder aqui der
// mais trabalho que responder um WhatsApp, ele volta para o caderno.
//
// A checagem de papel no carregamento é conveniência de navegação. Quem segura
// de verdade é a RLS: sem a linha em perfis com papel 'admin', o banco recusa
// cada uma destas chamadas.
// =============================================================================

import { supabase, mensagemDeErro } from "/shared/supabase.js";
import { api, mensagemDaApi, acordarApi, avisarDemora } from "/shared/api.js";
import { exigirSessao, sair, tratarSessaoMorta } from "/shared/sessao.js";
import {
  $, $$, escapar, aviso, limparAviso, ocupado, montarTopo, selo,
  hora, quandoCurto, dataISO, hojeISO, intervaloHumano, duracao,
  telefoneBonito, linkWhatsApp, instanteLocal, inicioDoPeriodo, fimDoPeriodo
} from "/shared/ui.js";

const { perfil } = await exigirSessao({ admin: true });

// O painel lê direto do Supabase (rápido, com a RLS de admin garantindo) e
// escreve pela API (onde estão as chaves e as regras). Cutucar a API na abertura
// faz ela acordar enquanto ele ainda está lendo a fila.
acordarApi();

montarTopo($("#topo"), perfil, { admin: true });
$("#topo").addEventListener("click", (e) => {
  if (e.target.matches("[data-sair]")) { e.preventDefault(); sair(); }
});

let servicos = [];
let config = {};
let diaAtual = hojeISO();

$("#data-agenda").value = diaAtual;

await carregarApoio();
await Promise.all([carregarFila(), carregarDia()]);
await acaoDaNotificacao();

// -----------------------------------------------------------------------------
// Apoio
// -----------------------------------------------------------------------------
async function carregarApoio() {
  const [rServicos, rConfig] = await Promise.all([
    supabase.from("servicos").select("id, nome, duracao_min, ativo").order("ordem"),
    supabase.from("configuracoes").select("chave, valor")
  ]);

  if (rServicos.error && tratarSessaoMorta(rServicos.error)) return;

  servicos = rServicos.data || [];
  config = Object.fromEntries((rConfig.data || []).map((c) => [c.chave, c.valor]));

  const seletor = $("#form-encaixe").servico;
  seletor.innerHTML = servicos.filter((s) => s.ativo)
    .map((s) => `<option value="${s.id}">${escapar(s.nome)} · ${duracao(s.duracao_min)}</option>`)
    .join("");
}

// -----------------------------------------------------------------------------
// Fila de pedidos
// -----------------------------------------------------------------------------
async function carregarFila() {
  const caixa = $("#fila");

  const { data, error } = await supabase
    .from("agendamentos")
    .select("id, nome, telefone, periodo, criado_em, observacao, servicos(nome, duracao_min)")
    .eq("status", "pendente")
    .order("periodo");

  if (error) {
    if (tratarSessaoMorta(error)) return;
    caixa.innerHTML = '<p class="vazio-explicado">Não consegui carregar a fila. Recarregue a página.</p>';
    return;
  }

  // Ordem por prazo: quem vence primeiro aparece primeiro. É a ordem em que as
  // decisões precisam ser tomadas, não a ordem em que chegaram.
  const fila = data.map((p) => ({ ...p, prazo: prazoDe(p) }))
    .sort((a, b) => a.prazo - b.prazo);

  $("#contador-fila").textContent = fila.length
    ? `${fila.length} esperando`
    : "";

  if (!fila.length) {
    caixa.innerHTML = `
      <div class="fila-vazia">
        <h3>Você está <em>em dia</em></h3>
        <p>Nenhum pedido esperando resposta.</p>
      </div>`;
    return;
  }

  caixa.innerHTML = fila.map(cartaoFila).join("");
}

/**
 * O prazo é o configurado, sempre limitado pelo horário do corte: um pedido
 * para daqui a três horas não pode esperar doze. Vale o menor dos dois.
 */
function prazoDe(pedido) {
  const horas = Number(config.prazo_resposta_h || 12);
  const porPrazo = new Date(pedido.criado_em).getTime() + horas * 3600000;
  const inicio = inicioDoPeriodo(pedido.periodo).getTime();
  return Math.min(porPrazo, inicio);
}

function cartaoFila(p) {
  const inicio = inicioDoPeriodo(p.periodo);
  const falta = p.prazo - Date.now();
  const urgente = falta < 3600000;
  const aoExpirar = String(config.acao_ao_expirar || "confirmar") === "confirmar"
    ? "confirma sozinho" : "recusa sozinho";

  const texto = `Oi, ${(p.nome || "").split(" ")[0]}! Sobre seu horário de ${quandoCurto(inicio)} na Sir. Patrick.`;

  return `
    <article class="fila-item" data-id="${p.id}">
      <div class="fila-nome">${escapar(p.nome)}</div>
      <div class="fila-quando">${quandoCurto(inicio)} · ${escapar(p.servicos?.nome || "")}</div>
      <div class="fila-meta">
        <span>pedido ${intervaloHumano(p.criado_em)}</span>
        <span class="${urgente ? "prazo-curto" : ""}">
          ${falta > 0
            ? `vence ${intervaloHumano(new Date(p.prazo), { futuro: true })} — depois ${aoExpirar}`
            : `prazo vencido — ${aoExpirar}`}
        </span>
        <span>${escapar(telefoneBonito(p.telefone))}</span>
      </div>
      <div class="fila-acoes">
        <button class="btn btn-gold" type="button" data-confirmar="${p.id}">Confirmar</button>
        <button class="btn btn-linha" type="button" data-recusar="${p.id}" data-quem="${escapar(p.nome)}">Recusar</button>
        <a class="btn btn-whats" href="${linkWhatsApp(p.telefone, texto)}" target="_blank" rel="noopener">WhatsApp</a>
      </div>
    </article>`;
}

// -----------------------------------------------------------------------------
// Agenda do dia
// -----------------------------------------------------------------------------
async function carregarDia() {
  const caixa = $("#linha-tempo");
  const inicioDia = instanteLocal(diaAtual, "00:00").toISOString();
  const fimDia = instanteLocal(diaAtual, "23:59").toISOString();

  const [rAgenda, rBloqueios] = await Promise.all([
    supabase.from("agendamentos")
      .select("id, nome, telefone, periodo, status, origem, motivo_recusa, servicos(nome, duracao_min)")
      .eq("dia", diaAtual)
      .order("periodo"),
    supabase.from("bloqueios").select("id, inicio, fim, motivo")
      .lt("inicio", fimDia).gt("fim", inicioDia)
  ]);

  if (rAgenda.error) {
    if (tratarSessaoMorta(rAgenda.error)) return;
    caixa.innerHTML = '<p class="vazio-explicado">Não consegui carregar o dia.</p>';
    return;
  }

  const itens = [
    ...(rAgenda.data || []).map((a) => ({ tipo: "agendamento", quando: inicioDoPeriodo(a.periodo), dado: a })),
    ...(rBloqueios.data || []).map((b) => ({ tipo: "bloqueio", quando: new Date(b.inicio), dado: b }))
  ].sort((a, b) => a.quando - b.quando);

  const ativos = (rAgenda.data || []).filter((a) => ["pendente", "confirmado"].includes(a.status));
  $("#contador-dia").textContent = ativos.length
    ? `${ativos.length} na cadeira`
    : "dia livre";

  if (!itens.length) {
    caixa.innerHTML = '<p class="vazio-explicado">Nada marcado neste dia.</p>';
    return;
  }

  caixa.innerHTML = itens.map((i) => i.tipo === "bloqueio" ? blocoBloqueio(i.dado) : blocoAgenda(i.dado)).join("");
}

function blocoAgenda(a) {
  const inicio = inicioDoPeriodo(a.periodo);
  const fim = fimDoPeriodo(a.periodo);
  const ativo = ["pendente", "confirmado"].includes(a.status);
  const passou = fim < new Date();

  const acoes = [];
  if (a.status === "pendente") {
    acoes.push(`<button class="btn btn-gold" type="button" data-confirmar="${a.id}">Confirmar</button>`);
    acoes.push(`<button class="btn btn-linha" type="button" data-recusar="${a.id}" data-quem="${escapar(a.nome)}">Recusar</button>`);
  }
  if (a.status === "confirmado" && passou) {
    acoes.push(`<button class="btn btn-linha" type="button" data-concluir="${a.id}">Atendido</button>`);
    acoes.push(`<button class="btn btn-linha" type="button" data-faltou="${a.id}">Não veio</button>`);
  }
  if (ativo) {
    acoes.push(`<button class="btn btn-linha" type="button" data-remarcar="${a.id}" data-quem="${escapar(a.nome)}">Remarcar</button>`);
    acoes.push(`<button class="btn btn-perigo" type="button" data-cancelar="${a.id}" data-quem="${escapar(a.nome)}">Cancelar</button>`);
  }
  if (a.telefone) {
    acoes.push(`<a class="btn btn-whats" href="${linkWhatsApp(a.telefone)}" target="_blank" rel="noopener">WhatsApp</a>`);
  }

  return `
    <div class="bloco" data-status="${a.status}">
      <div class="bloco-hora">${hora(inicio)}</div>
      <div class="bloco-corpo">
        <div class="bloco-nome">${escapar(a.nome)} ${selo(a.status, true)}</div>
        <div class="bloco-meta">
          <span>${escapar(a.servicos?.nome || "")} · até ${hora(fim)}</span>
          ${a.origem === "encaixe" ? "<span>encaixe</span>" : ""}
          ${a.motivo_recusa ? `<span>motivo: ${escapar(a.motivo_recusa)}</span>` : ""}
        </div>
        <div class="bloco-acoes">${acoes.join("")}</div>
      </div>
    </div>`;
}

function blocoBloqueio(b) {
  return `
    <div class="bloco bloco-bloqueio">
      <div class="bloco-hora">${hora(b.inicio)}</div>
      <div class="bloco-corpo">
        <div class="bloco-nome">Bloqueado até ${hora(b.fim)}</div>
        <div class="bloco-meta">
          <span>${escapar(b.motivo || "sem motivo anotado")}</span>
        </div>
        <div class="bloco-acoes">
          <button class="btn btn-linha" type="button" data-desbloquear="${b.id}">Liberar</button>
        </div>
      </div>
    </div>`;
}

// -----------------------------------------------------------------------------
// Navegação de dia
// -----------------------------------------------------------------------------
$$("[data-navega]").forEach((b) => b.addEventListener("click", () => {
  const d = instanteLocal(diaAtual, "12:00");
  d.setDate(d.getDate() + Number(b.dataset.navega));
  diaAtual = dataISO(d);
  $("#data-agenda").value = diaAtual;
  carregarDia();
}));

$("#data-agenda").addEventListener("change", (e) => {
  diaAtual = e.target.value || hojeISO();
  carregarDia();
});

$("#btn-hoje").addEventListener("click", () => {
  diaAtual = hojeISO();
  $("#data-agenda").value = diaAtual;
  carregarDia();
});

// -----------------------------------------------------------------------------
// Ações sobre um agendamento
// -----------------------------------------------------------------------------
document.addEventListener("click", async (evento) => {
  const alvo = evento.target.closest("[data-confirmar],[data-recusar],[data-concluir],[data-faltou],[data-cancelar],[data-remarcar],[data-desbloquear]");
  if (!alvo) return;

  const d = alvo.dataset;

  // Confirmar: um toque, sem tela intermediária. É a ação mais usada do painel
  // e a única que não pede nada em troca.
  if (d.confirmar) return acao(alvo, `/api/admin/pedidos/${d.confirmar}/confirmar`, {},
    "Confirmado. O cliente já foi avisado.");
  if (d.concluir) return acao(alvo, `/api/admin/pedidos/${d.concluir}/concluir`, {},
    "Marcado como atendido.");
  if (d.faltou) return acao(alvo, `/api/admin/pedidos/${d.faltou}/nao-compareceu`, {},
    "Marcado como falta.");
  if (d.desbloquear) return liberarBloqueio(alvo, d.desbloquear);

  if (d.recusar) return abrirRecusa(d.recusar, d.quem);
  if (d.remarcar) return abrirRemarcacao(d.remarcar, d.quem);

  if (d.cancelar) {
    const motivo = prompt(`Cancelar o horário de ${d.quem}?\n\nMotivo (o cliente recebe junto com o aviso):`, "");
    if (motivo === null) return;
    return acao(alvo, `/api/admin/pedidos/${d.cancelar}/cancelar`, { motivo: motivo || undefined },
      "Cancelado. O cliente já foi avisado.");
  }
});

/**
 * Toda ação sobre um pedido segue por aqui: chama a API, mostra o resultado e
 * recarrega as duas listas.
 *
 * O 409 JA_RESPONDIDO não é erro de verdade — é a fila dizendo que aquele
 * pedido já foi resolvido (por ele mesmo em outro aparelho, ou pela rotina de
 * expiração). Recarregar é a resposta certa.
 */
async function acao(botao, caminho, corpo, mensagem) {
  limparAviso($("#aviso-geral"));
  const liberar = ocupado(botao, "…");
  const cancelarAviso = avisarDemora(botao, "acordando…");

  try {
    await api(caminho, { metodo: "POST", corpo });
    cancelarAviso();
    liberar();
    aviso($("#aviso-geral"), mensagem, "ok");
  } catch (erro) {
    cancelarAviso();
    liberar();
    if (tratarSessaoMorta(erro)) return;
    aviso($("#aviso-geral"), mensagemDaApi(erro, "Não consegui salvar. Tente de novo."),
      erro.codigo === "JA_RESPONDIDO" ? "atencao" : "erro");
  }

  await Promise.all([carregarFila(), carregarDia()]);
}

async function liberarBloqueio(botao, id) {
  if (!confirm("Liberar este bloqueio? Os horários voltam para a agenda.")) return;

  const liberar = ocupado(botao, "…");
  try {
    await api(`/api/admin/bloqueios/${id}`, { metodo: "DELETE" });
    aviso($("#aviso-geral"), "Liberado.", "ok");
  } catch (erro) {
    if (tratarSessaoMorta(erro)) return;
    aviso($("#aviso-geral"), mensagemDaApi(erro, "Não consegui liberar."));
  } finally {
    liberar();
  }

  carregarDia();
}

// -----------------------------------------------------------------------------
// Recusar
// -----------------------------------------------------------------------------
let idRecusa = null;

function abrirRecusa(id, quem) {
  idRecusa = id;
  $("#recusar-quem").textContent = `Pedido de ${quem}.`;
  $("#form-recusar").motivo.value = "";
  $("#dlg-recusar").showModal();
}

$("#form-recusar").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const motivo = $("#form-recusar").motivo.value.trim();
  $("#dlg-recusar").close();

  limparAviso($("#aviso-geral"));

  try {
    await api(`/api/admin/pedidos/${idRecusa}/recusar`, {
      metodo: "POST",
      corpo: { motivo: motivo || undefined }
    });
    aviso($("#aviso-geral"),
      "Recusado. O horário voltou para a agenda e o cliente foi avisado.", "ok");
  } catch (erro) {
    if (tratarSessaoMorta(erro)) return;
    aviso($("#aviso-geral"), mensagemDaApi(erro, "Não consegui recusar."));
  }

  await Promise.all([carregarFila(), carregarDia()]);
});

// -----------------------------------------------------------------------------
// Remarcar
// -----------------------------------------------------------------------------
let idRemarcar = null;

function abrirRemarcacao(id, quem) {
  idRemarcar = id;
  $("#remarcar-quem").textContent = `Horário de ${quem}.`;
  $("#form-remarcar").dia.value = diaAtual;
  limparAviso($("#aviso-remarcar"));
  $("#dlg-remarcar").showModal();
}

$("#form-remarcar").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const form = $("#form-remarcar");
  const caixa = $("#aviso-remarcar");
  limparAviso(caixa);

  if (!form.dia.value || !form.hora.value) return aviso(caixa, "Escolha o dia e o horário.");

  // Manda só o início: o fim é recalculado no servidor pela duração do serviço.
  const inicio = instanteLocal(form.dia.value, form.hora.value);

  try {
    await api(`/api/admin/pedidos/${idRemarcar}/remarcar`, {
      metodo: "POST",
      corpo: { inicio: inicio.toISOString() }
    });
  } catch (erro) {
    if (tratarSessaoMorta(erro)) return;
    if (erro.codigo === "HORARIO_OCUPADO") return aviso(caixa, "Esse horário bate com outro agendamento.");
    if (erro.codigo === "JA_TEM_NO_DIA") return aviso(caixa, "Esse cliente já tem um agendamento nesse dia.");
    return aviso(caixa, mensagemDaApi(erro, "Não consegui remarcar."));
  }

  $("#dlg-remarcar").close();
  aviso($("#aviso-geral"), "Horário alterado. Avise o cliente pelo WhatsApp — remarcação não dispara e-mail.", "atencao");
  await Promise.all([carregarFila(), carregarDia()]);
});

// -----------------------------------------------------------------------------
// Encaixe
// -----------------------------------------------------------------------------
// Cliente que chegou sem marcar. Sem isso o sistema descola da realidade da
// loja: o horário aparece livre no site enquanto tem gente na cadeira.
$("#btn-encaixe").addEventListener("click", () => {
  const form = $("#form-encaixe");
  form.dia.value = diaAtual;
  form.hora.value = hora(new Date());
  limparAviso($("#aviso-encaixe"));
  $("#dlg-encaixe").showModal();
});

$("#form-encaixe").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const form = $("#form-encaixe");
  const caixa = $("#aviso-encaixe");
  limparAviso(caixa);

  const nome = form.nome.value.trim();
  if (nome.length < 2) return aviso(caixa, "Escreva o nome do cliente.");
  if (!form.dia.value || !form.hora.value) return aviso(caixa, "Escolha o dia e o horário.");

  const inicio = instanteLocal(form.dia.value, form.hora.value);

  try {
    await api("/api/admin/encaixe", {
      metodo: "POST",
      corpo: { nome, servico_id: form.servico.value, inicio: inicio.toISOString() }
    });
  } catch (erro) {
    if (tratarSessaoMorta(erro)) return;
    if (erro.codigo === "HORARIO_OCUPADO") return aviso(caixa, "Esse horário bate com outro agendamento.");
    return aviso(caixa, mensagemDaApi(erro, "Não consegui gravar o encaixe."));
  }

  $("#dlg-encaixe").close();
  form.nome.value = "";
  aviso($("#aviso-geral"), "Encaixe gravado.", "ok");
  if (form.dia.value === diaAtual) carregarDia();
});

// -----------------------------------------------------------------------------
// Bloqueios
// -----------------------------------------------------------------------------
$("#btn-bloqueio").addEventListener("click", () => {
  const form = $("#form-bloqueio");
  form.inicio.value = `${diaAtual}T09:00`;
  form.fim.value = `${diaAtual}T18:00`;
  limparAviso($("#aviso-bloqueio"));
  $("#dlg-bloqueio").showModal();
});

$("#form-bloqueio").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const form = $("#form-bloqueio");
  const caixa = $("#aviso-bloqueio");
  limparAviso(caixa);

  const inicio = new Date(form.inicio.value + ":00-03:00");
  const fim = new Date(form.fim.value + ":00-03:00");

  if (!(fim > inicio)) return aviso(caixa, "O fim precisa ser depois do começo.");

  const corpo = {
    inicio: inicio.toISOString(),
    fim: fim.toISOString(),
    motivo: form.motivo.value.trim() || undefined
  };

  try {
    await api("/api/admin/bloqueios", { metodo: "POST", corpo });
  } catch (erro) {
    if (tratarSessaoMorta(erro)) return;

    // A API recusa de primeira quando tem gente marcada dentro do período, e
    // devolve quem é. Bloquear por cima de cliente marcado é como o sistema
    // perde a confiança do dono — então a segunda tentativa é consciente.
    if (erro.codigo === "CONFLITO") {
      const lista = (erro.dados?.conflitos || [])
        .map((c) => `• ${c.nome} às ${hora(c.inicio)}`).join("\n");
      const seguir = confirm(
        `Tem gente marcada nesse período:\n\n${lista}\n\n` +
        "Bloquear assim mesmo? Os agendamentos continuam de pé — você precisa cancelar um por um."
      );
      if (!seguir) return;

      try {
        await api("/api/admin/bloqueios", { metodo: "POST", corpo: { ...corpo, confirmar: true } });
      } catch (erro2) {
        return aviso(caixa, mensagemDaApi(erro2, "Não consegui bloquear."));
      }
    } else {
      return aviso(caixa, mensagemDaApi(erro, "Não consegui bloquear."));
    }
  }

  $("#dlg-bloqueio").close();
  aviso($("#aviso-geral"), "Bloqueado. Esses horários sumiram da agenda do cliente.", "ok");
  carregarDia();
});

// Botões "Voltar/Cancelar" dos diálogos.
$$("[data-fechar]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// -----------------------------------------------------------------------------
// Ação vinda da notificação (Fase 4)
// -----------------------------------------------------------------------------
// O service worker abre /admin/?acao=confirmar&id=... e quem executa é esta
// página, que tem a sessão. O service worker não carrega credencial nenhuma —
// inventar um token só para ele é exatamente onde esse tipo de projeto abre
// buraco de segurança.
async function acaoDaNotificacao() {
  const params = new URLSearchParams(location.search);
  const acao = params.get("acao");
  const id = params.get("id");
  if (!acao || !id) return;

  history.replaceState(null, "", "/admin/");

  if (acao === "confirmar") {
    try {
      await api(`/api/admin/pedidos/${id}/confirmar`, { metodo: "POST" });
      aviso($("#aviso-geral"), "Confirmado pela notificação. O cliente já foi avisado.", "ok");
    } catch (erro) {
      if (tratarSessaoMorta(erro)) return;
      aviso($("#aviso-geral"), mensagemDaApi(erro, "Não consegui confirmar."),
        erro.codigo === "JA_RESPONDIDO" ? "atencao" : "erro");
    }
    await Promise.all([carregarFila(), carregarDia()]);
  }

  if (acao === "recusar") {
    const { data } = await supabase.from("agendamentos").select("nome").eq("id", id).maybeSingle();
    abrirRecusa(id, data?.nome || "cliente");
  }
}

// -----------------------------------------------------------------------------
// Avisos neste aparelho (Fase 4)
// -----------------------------------------------------------------------------
// Se a VAPID ainda não estiver configurada, a oferta simplesmente não aparece.
try {
  const push = await import("/shared/push.js");
  await push.oferecerAtivacao($("#caixa-push"), {
    texto: "Ative os avisos neste celular para saber de pedido novo sem abrir o painel."
  });
} catch (_) { /* Fase 4 ainda não publicada */ }

// O service worker pede para navegar quando o painel já está aberto e o Patrick
// toca num botão da notificação.
navigator.serviceWorker?.addEventListener("message", (evento) => {
  if (evento.data?.tipo === "navegar") location.href = evento.data.destino;
});

// -----------------------------------------------------------------------------
// Pedido chegando ao vivo
// -----------------------------------------------------------------------------
// Funciona só com a aba aberta — serve para o computador da barbearia, não para
// o celular no bolso. É complemento do push, nunca substituto.
supabase
  .channel("fila-ao-vivo")
  .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "agendamentos" },
      (payload) => {
        carregarFila();
        if (payload.new?.dia === diaAtual) carregarDia();
        apitar();
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("Novo pedido de horário", {
            body: `${payload.new?.nome || "Alguém"} pediu um horário.`,
            icon: "/admin/icone-192.png"
          });
        }
      })
  .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "agendamentos" },
      () => { carregarFila(); carregarDia(); })
  .subscribe();

/** Dois toques curtos, gerados na hora: nada de arquivo de som para baixar. */
function apitar() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach((atraso) => {
      const osc = ctx.createOscillator();
      const vol = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      vol.gain.setValueAtTime(0.0001, ctx.currentTime + atraso);
      vol.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + atraso + 0.01);
      vol.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + atraso + 0.14);
      osc.connect(vol).connect(ctx.destination);
      osc.start(ctx.currentTime + atraso);
      osc.stop(ctx.currentTime + atraso + 0.16);
    });
  } catch (_) { /* aba sem permissão de áudio: silêncio, sem quebrar nada */ }
}
