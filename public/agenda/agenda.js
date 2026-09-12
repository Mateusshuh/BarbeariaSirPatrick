// =============================================================================
// Agenda do cliente — escolher serviço, dia e horário
// =============================================================================
// Esta tela NUNCA lê a tabela de agendamentos para montar a grade. Ela pergunta
// ao banco o que está livre (horarios_disponiveis e dias_disponiveis) e desenha
// a resposta. O que está ocupado ela deduz comparando a grade teórica do
// expediente com a lista de livres — e nunca sabe de quem é o horário tomado.
// =============================================================================

import { supabase, mensagemDeErro } from "/shared/supabase.js";
import { api, mensagemDaApi, acordarApi, avisarDemora } from "/shared/api.js";
import { exigirSessao, sair, tratarSessaoMorta } from "/shared/sessao.js";
import {
  $, $$, escapar, aviso, limparAviso, ocupado, montarTopo,
  hora, dinheiro, duracao, dataISO, hojeISO
} from "/shared/ui.js";

const { usuario, perfil } = await exigirSessao();

// Cutuca a API agora, sem esperar. Enquanto a pessoa escolhe serviço, dia e
// horário, o serviço acorda em segundo plano — e quando ela clicar em "Pedir",
// ele já está de pé.
acordarApi();

montarTopo($("#topo"), perfil);
$("#topo").addEventListener("click", (e) => {
  if (e.target.matches("[data-sair]")) { e.preventDefault(); sair(); }
});

// -----------------------------------------------------------------------------
// Estado da tela
// -----------------------------------------------------------------------------
const estado = {
  servico: null,      // objeto do serviço escolhido
  dia: null,          // "2026-09-12"
  hora: null,         // ISO do início escolhido
  mes: primeiroDiaDoMes(new Date()),
  diasDoMes: new Map(),   // "2026-09-12" -> { aberto, vagas }
  livresDoDia: []         // ISO dos horários livres do dia escolhido
};

let servicos = [];
let expediente = [];    // uma linha por dia da semana aberto
let config = {};

// -----------------------------------------------------------------------------
// Carga inicial
// -----------------------------------------------------------------------------
try {
  const [rServicos, rExpediente, rConfig] = await Promise.all([
    supabase.from("servicos").select("id, nome, duracao_min, preco_centavos").eq("ativo", true).order("ordem"),
    supabase.from("expediente").select("dia_semana, abre, fecha, intervalo_inicio, intervalo_fim"),
    supabase.from("configuracoes").select("chave, valor")
  ]);

  for (const r of [rServicos, rExpediente, rConfig]) {
    if (r.error) throw r.error;
  }

  servicos = rServicos.data;
  expediente = rExpediente.data;
  config = Object.fromEntries(rConfig.data.map((c) => [c.chave, c.valor]));
} catch (erro) {
  if (!tratarSessaoMorta(erro)) {
    aviso($("#aviso-geral"), mensagemDeErro(erro, "Não consegui carregar a agenda. Recarregue a página."));
  }
}

const PASSO = Number(config.passo_grade_min || 30);
const ANTECEDENCIA = Number(config.antecedencia_min_min || 60);
const JANELA = Number(config.janela_dias || 30);
const PRAZO_H = Number(config.prazo_resposta_h || 12);

// E-mail não confirmado: avisa aqui, com saída, em vez de deixar o pedido
// falhar lá no fim. Quem barra de verdade é o gatilho no banco.
const exigeEmail = String(config.exige_email_verificado || "sim").toLowerCase();
const emailPendente = ["sim", "true", "1"].includes(exigeEmail) && !usuario.email_confirmed_at;

if (emailPendente) {
  aviso($("#aviso-geral"),
    `Falta confirmar seu e-mail (<strong>${escapar(usuario.email)}</strong>) antes de pedir um horário. ` +
    'Abra o link que enviamos — <button type="button" id="reenviar-email" style="border:0;background:none;font:inherit;text-decoration:underline;cursor:pointer;padding:0">reenviar o e-mail</button>.',
    "atencao");
  $("#reenviar-email")?.addEventListener("click", async () => {
    await supabase.auth.resend({ type: "signup", email: usuario.email });
    aviso($("#aviso-geral"), "Reenviado. Confira sua caixa de entrada e o spam.", "ok");
  });
}

desenharServicos();
desenharCalendario();

// -----------------------------------------------------------------------------
// Serviços
// -----------------------------------------------------------------------------
function desenharServicos() {
  const caixa = $("#servicos");
  if (!servicos.length) {
    caixa.innerHTML = '<p class="vazio-explicado">Nenhum serviço cadastrado ainda. Fale com o Patrick.</p>';
    return;
  }

  caixa.innerHTML = servicos.map((s) => `
    <button class="servico-chip" type="button" aria-pressed="false" data-id="${s.id}">
      <b>${escapar(s.nome)}</b>
      <span>${duracao(s.duracao_min)}</span>
    </button>`).join("");

  caixa.addEventListener("click", (e) => {
    const botao = e.target.closest(".servico-chip");
    if (!botao) return;
    escolherServico(servicos.find((s) => s.id === botao.dataset.id));
  });
}

function escolherServico(servico) {
  if (!servico) return;
  estado.servico = servico;
  // Trocar de serviço muda a duração, e com ela a grade inteira: o horário
  // escolhido pode nem existir mais.
  estado.hora = null;
  $$(".servico-chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === servico.id)));
  atualizar();
  carregarMes();
  // A duração mudou: os horários do dia escolhido precisam ser refeitos.
  if (estado.dia) carregarHorarios();
}

// -----------------------------------------------------------------------------
// Calendário
// -----------------------------------------------------------------------------
function primeiroDiaDoMes(data) { return new Date(data.getFullYear(), data.getMonth(), 1); }

async function carregarMes() {
  if (!estado.servico) { desenharCalendario(); return; }

  const inicio = new Date(estado.mes);
  const fim = new Date(estado.mes.getFullYear(), estado.mes.getMonth() + 1, 0);

  $("#calendario").innerHTML = '<p class="carregando">Vendo o que está livre</p>';

  const { data, error } = await supabase.rpc("dias_disponiveis", {
    p_inicio: dataISO(inicio),
    p_fim: dataISO(fim),
    p_servico: estado.servico.id
  });

  if (error) {
    if (tratarSessaoMorta(error)) return;
    $("#calendario").innerHTML = '<p class="vazio-explicado">Não consegui ver os dias livres. Recarregue a página.</p>';
    return;
  }

  estado.diasDoMes = new Map(data.map((d) => [d.dia, d]));
  desenharCalendario();
}

function desenharCalendario() {
  const caixa = $("#calendario");
  const ano = estado.mes.getFullYear();
  const mes = estado.mes.getMonth();
  const nomeMes = estado.mes.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  const primeiro = new Date(ano, mes, 1);
  const totalDias = new Date(ano, mes + 1, 0).getDate();
  const hoje = hojeISO();
  const limite = dataISO(new Date(Date.now() + JANELA * 86400000));

  // Mês anterior só até o mês corrente; adiante, só até a janela configurada.
  const temAnterior = `${ano}-${String(mes + 1).padStart(2, "0")}` > hoje.slice(0, 7);
  const temProximo = `${ano}-${String(mes + 1).padStart(2, "0")}` < limite.slice(0, 7);

  let celulas = "";
  for (let i = 0; i < primeiro.getDay(); i++) celulas += '<div class="dia-vazio"></div>';

  for (let d = 1; d <= totalDias; d++) {
    const iso = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const info = estado.diasDoMes.get(iso);
    const foraDaJanela = iso < hoje || iso > limite;
    const selecionado = estado.dia === iso;

    let classe = "dia";
    let desabilitado = "disabled";
    let titulo = "";

    if (!estado.servico) {
      classe += " dia-fechado";
      titulo = "Escolha primeiro o serviço";
    } else if (foraDaJanela || !info || !info.aberto) {
      classe += " dia-fechado";
      titulo = foraDaJanela ? "Fora do período de agendamento" : "A barbearia não abre neste dia";
    } else if (info.vagas === 0) {
      classe += " dia-lotado";
      titulo = "Sem horário livre neste dia";
    } else {
      desabilitado = "";
      titulo = `${info.vagas} horário${info.vagas > 1 ? "s" : ""} livre${info.vagas > 1 ? "s" : ""}`;
    }

    celulas += `<button type="button" class="${classe}" data-dia="${iso}" data-hoje="${iso === hoje}" ${desabilitado}
      aria-pressed="${selecionado}" title="${titulo}">${d}</button>`;
  }

  caixa.innerHTML = `
    <div class="cal-topo">
      <span class="cal-mes">${nomeMes}</span>
      <span class="cal-nav">
        <button type="button" data-mes="-1" ${temAnterior ? "" : "disabled"} aria-label="Mês anterior">‹</button>
        <button type="button" data-mes="1" ${temProximo ? "" : "disabled"} aria-label="Próximo mês">›</button>
      </span>
    </div>
    <div class="cal-semana" aria-hidden="true">
      <span>dom</span><span>seg</span><span>ter</span><span>qua</span>
      <span>qui</span><span>sex</span><span>sáb</span>
    </div>
    <div class="cal-dias">${celulas}</div>
    <p class="cal-legenda">
      <span>Riscado: dia lotado.</span><span>Apagado: fechado.</span>
    </p>`;

  caixa.querySelectorAll("[data-mes]").forEach((b) => b.addEventListener("click", () => {
    estado.mes = new Date(estado.mes.getFullYear(), estado.mes.getMonth() + Number(b.dataset.mes), 1);
    carregarMes();
  }));

  caixa.querySelectorAll("[data-dia]").forEach((b) => b.addEventListener("click", () => {
    escolherDia(b.dataset.dia);
  }));
}

function escolherDia(iso) {
  estado.dia = iso;
  estado.hora = null;
  $$("[data-dia]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dia === iso)));
  atualizar();
  carregarHorarios();
}

// -----------------------------------------------------------------------------
// Horários
// -----------------------------------------------------------------------------
async function carregarHorarios() {
  const caixa = $("#horarios");
  if (!estado.dia || !estado.servico) return;

  caixa.innerHTML = '<p class="carregando">Buscando horários</p>';

  const { data, error } = await supabase.rpc("horarios_disponiveis", {
    p_data: estado.dia,
    p_servico: estado.servico.id
  });

  if (error) {
    if (tratarSessaoMorta(error)) return;
    caixa.innerHTML = '<p class="vazio-explicado">Não consegui buscar os horários. Tente de novo em instantes.</p>';
    return;
  }

  estado.livresDoDia = data || [];
  desenharHorarios();
}

/**
 * Monta o instante exato de "dia às HH:MM" no fuso da barbearia.
 * O Brasil não tem horário de verão desde 2019, então o deslocamento é fixo em
 * -03:00. Se um dia voltar, é esta linha que muda — e só ela.
 */
function instante(diaISO, hhmm) {
  return new Date(`${diaISO}T${hhmm.slice(0, 5)}:00-03:00`);
}

function desenharHorarios() {
  const caixa = $("#horarios");
  const diaSemana = instante(estado.dia, "12:00").getDay();
  const exp = expediente.find((e) => e.dia_semana === diaSemana);

  if (!exp) {
    caixa.innerHTML = '<p class="vazio-explicado">A barbearia não abre neste dia.</p>';
    return;
  }

  const livres = new Set(estado.livresDoDia.map((iso) => new Date(iso).getTime()));
  const limite = Date.now() + ANTECEDENCIA * 60000;
  const abre = instante(estado.dia, exp.abre).getTime();
  const fecha = instante(estado.dia, exp.fecha).getTime();
  const almocoInicio = exp.intervalo_inicio ? instante(estado.dia, exp.intervalo_inicio).getTime() : null;
  const almocoFim = exp.intervalo_fim ? instante(estado.dia, exp.intervalo_fim).getTime() : null;

  const dur = estado.servico.duracao_min * 60000;
  let html = "";
  let almocoDesenhado = false;
  let quantos = 0;

  for (let t = abre; t + dur <= fecha; t += PASSO * 60000) {
    // Passado e antecedência mínima: nem aparecem. Riscar um horário que já
    // passou não informa nada, só enche a coluna.
    if (t < limite) continue;

    // O almoço vira uma linha divisória, não uma fileira de horários riscados.
    if (almocoInicio !== null && t + dur > almocoInicio && t < almocoFim) {
      if (!almocoDesenhado && html) {
        html += `<p class="almoco">intervalo</p>`;
        almocoDesenhado = true;
      }
      continue;
    }

    const livre = livres.has(t);
    if (livre) quantos++;
    const iso = new Date(t).toISOString();
    const escolhido = estado.hora && new Date(estado.hora).getTime() === t;

    html += `<button type="button" class="hora" data-iso="${iso}"
      aria-pressed="${escolhido ? "true" : "false"}" ${livre ? "" : "disabled"}
      title="${livre ? "Livre" : "Já reservado"}">${hora(t)}</button>`;
  }

  if (!html) {
    caixa.innerHTML = '<p class="vazio-explicado">Nada mais hoje neste dia. Escolha outro no calendário.</p>';
    return;
  }

  caixa.innerHTML = `<div class="horarios">${html}</div>` +
    (quantos === 0
      ? '<p class="vazio-explicado" style="margin-top:14px">Todos os horários deste dia já foram reservados.</p>'
      : "");

  caixa.querySelectorAll(".hora:not(:disabled)").forEach((b) => b.addEventListener("click", () => {
    estado.hora = b.dataset.iso;
    caixa.querySelectorAll(".hora").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    atualizar();
  }));
}

// -----------------------------------------------------------------------------
// Resumo e passos
// -----------------------------------------------------------------------------
function atualizar() {
  const s = estado.servico;

  definir("#resumo-servico", s ? s.nome : "a escolher", !!s);
  definir("#resumo-dia", estado.dia ? diaBonito(estado.dia) : "a escolher", !!estado.dia);
  definir("#resumo-hora", estado.hora ? hora(estado.hora) : "a escolher", !!estado.hora);
  definir("#resumo-valor",
    s ? (s.preco_centavos > 0 ? dinheiro(s.preco_centavos) : "combinado na loja") : "—",
    !!s);

  const passos = {
    servico: s ? "feito" : "atual",
    data: !s ? "" : estado.dia ? "feito" : "atual",
    horario: !estado.dia ? "" : estado.hora ? "feito" : "atual",
    enviar: estado.hora ? "atual" : ""
  };
  $$(".passo").forEach((li) => li.dataset.estado = passos[li.dataset.passo] || "");

  $("#pedir").disabled = !(s && estado.dia && estado.hora) || emailPendente;
  $("#nota-resumo").textContent = estado.hora
    ? `O Patrick tem até ${PRAZO_H}h para responder. Enquanto isso o horário fica reservado no seu nome.`
    : "O pedido fica aguardando a resposta do Patrick — o horário já sai da agenda enquanto isso.";
}

function definir(seletor, texto, escolhido) {
  const el = $(seletor);
  el.textContent = texto;
  el.classList.toggle("pendente-escolha", !escolhido);
}

function diaBonito(iso) {
  return instante(iso, "12:00").toLocaleDateString("pt-BR", {
    weekday: "short", day: "2-digit", month: "2-digit"
  });
}

// -----------------------------------------------------------------------------
// Enviar o pedido
// -----------------------------------------------------------------------------
$("#pedir").addEventListener("click", async () => {
  const caixa = $("#aviso-pedido");
  limparAviso(caixa);

  const botao = $("#pedir");
  const liberar = ocupado(botao, "Enviando…");
  // Se o serviço estiver acordando, o botão explica em vez de parecer travado.
  const cancelarAviso = avisarDemora(botao);

  try {
    // O navegador manda só o INÍCIO. Quem calcula o fim é o servidor, pela
    // duração do serviço: mandar o fim daqui seria deixar a duração na mão de
    // quem tem o console aberto.
    const pedido = await api("/api/pedidos", {
      metodo: "POST",
      corpo: { servico_id: estado.servico.id, inicio: new Date(estado.hora).toISOString() }
    });

    location.href = `/agenda/enviado.html?id=${pedido.id}`;
  } catch (erro) {
    cancelarAviso();
    liberar();

    if (tratarSessaoMorta(erro)) return;

    // Horário tomado no meio do caminho: a grade volta atualizada, sem a pessoa
    // precisar recarregar a página para descobrir sozinha.
    if (erro.codigo === "HORARIO_OCUPADO" || erro.codigo === "HORARIO_INDISPONIVEL") {
      aviso(caixa, mensagemDaApi(erro));
      estado.hora = null;
      atualizar();
      carregarHorarios();
      carregarMes();
      return;
    }

    if (erro.codigo === "JA_TEM_NO_DIA") {
      aviso(caixa,
        'Você já tem um pedido para esse dia. <a href="/agenda/minha-conta.html">Ver meu pedido</a> — ' +
        "para trocar de horário, cancele o que existe e peça outro.");
      return;
    }

    aviso(caixa, mensagemDaApi(erro, "Não consegui enviar o pedido. Tente de novo."));
    return;
  }

  cancelarAviso();
});
