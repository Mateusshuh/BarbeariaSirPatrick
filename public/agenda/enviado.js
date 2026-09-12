// =============================================================================
// Pedido enviado
// =============================================================================
// A tela mais fácil de errar do sistema. O cliente AINDA NÃO tem horário
// garantido, e precisa entender isso sem ambiguidade — por isso a palavra
// "confirmado" não aparece em lugar nenhum daqui.
// =============================================================================

import { supabase, mensagemDeErro } from "/shared/supabase.js";
import { exigirSessao, sair, tratarSessaoMorta } from "/shared/sessao.js";
import { $, escapar, montarTopo, quandoPorExtenso, dinheiro, instanteDoTexto } from "/shared/ui.js";

const { perfil } = await exigirSessao();
montarTopo($("#topo"), perfil);
$("#topo").addEventListener("click", (e) => {
  if (e.target.matches("[data-sair]")) { e.preventDefault(); sair(); }
});

const caixa = $("#conteudo");
const id = new URLSearchParams(location.search).get("id");

if (!id) {
  caixa.innerHTML = vazio("Não achei esse pedido.");
} else {
  const [{ data: pedido, error }, { data: cfg }] = await Promise.all([
    supabase.from("agendamentos")
      .select("id, periodo, status, criado_em, servicos(nome, preco_centavos, duracao_min)")
      .eq("id", id).maybeSingle(),
    supabase.from("configuracoes").select("chave, valor")
  ]);

  if (error && !tratarSessaoMorta(error)) {
    caixa.innerHTML = vazio(mensagemDeErro(error, "Não consegui carregar o pedido."));
  } else if (!pedido) {
    // A RLS devolve vazio para pedido de outra pessoa: do lado de cá isso é
    // indistinguível de "não existe", e está certo assim.
    caixa.innerHTML = vazio("Não achei esse pedido na sua conta.");
  } else {
    desenhar(pedido, Object.fromEntries((cfg || []).map((c) => [c.chave, c.valor])));
  }
}

function inicioDe(periodo) {
  // O PostgREST devolve o range como texto: ["2026-09-12 14:30:00-03","...")
  const bruto = String(periodo).replace(/^[\[(]/, "").split(",")[0].replace(/"/g, "").trim();
  return instanteDoTexto(bruto);
}

function desenhar(pedido, cfg) {
  const inicio = inicioDe(pedido.periodo);
  const prazoH = Number(cfg.prazo_resposta_h || 12);

  // O prazo é o menor entre o prazo configurado e a hora do próprio corte: um
  // pedido para daqui a três horas não pode esperar doze.
  const porPrazo = new Date(new Date(pedido.criado_em).getTime() + prazoH * 3600000);
  const limite = porPrazo < inicio ? porPrazo : inicio;

  const preco = pedido.servicos?.preco_centavos;

  caixa.innerHTML = `
    <div class="enviado-marca" aria-hidden="true">✓</div>

    <h1>Pedido <em>enviado</em></h1>
    <p class="texto-apoio" style="font-size:16px;max-width:44ch">
      Seu pedido chegou ao Patrick e está aguardando a resposta dele.
      Assim que ele responder, você recebe um e-mail.
    </p>

    <div class="enviado-dados">
      <dl>
        <div class="resumo-linha"><dt>Serviço</dt><dd>${escapar(pedido.servicos?.nome || "—")}</dd></div>
        <div class="resumo-linha"><dt>Quando</dt><dd>${quandoPorExtenso(inicio)}</dd></div>
        <div class="resumo-linha"><dt>Valor</dt>
          <dd>${preco > 0 ? dinheiro(preco) : "combinado na loja"}</dd></div>
        <div class="resumo-linha"><dt>Resposta até</dt>
          <dd>${quandoPorExtenso(limite)}</dd></div>
      </dl>
    </div>

    <p class="texto-apoio">
      Enquanto o Patrick não responde, esse horário fica reservado no seu nome e
      some da agenda para as outras pessoas. Se ele não puder atender, você é
      avisado e o horário volta para a lista.
    </p>

    <div id="caixa-push"></div>

    <div class="enviado-acoes">
      <a class="btn btn-dark" href="/agenda/minha-conta.html">Ver meus agendamentos</a>
      <a class="btn btn-linha" href="/agenda/">Voltar para a agenda</a>
    </div>

    <p class="rodape" style="margin-top:42px">
      Precisa falar agora? <a href="/#onde-titulo">Veja como chegar e o contato da barbearia</a>.
    </p>`;

  oferecerNotificacao();
}

// Notificação neste aparelho é camada extra: o canal principal para o cliente é
// o e-mail. Se a Fase 4 ainda não estiver publicada, a oferta simplesmente não
// aparece — em vez de mostrar um botão que não faz nada.
async function oferecerNotificacao() {
  try {
    const push = await import("/shared/push.js");
    await push.oferecerAtivacao($("#caixa-push"), {
      texto: "Quer receber um aviso neste aparelho quando o Patrick responder?"
    });
  } catch (_) { /* Fase 4 ainda não publicada */ }
}

function vazio(mensagem) {
  return `
    <h1>Hmm.</h1>
    <p class="texto-apoio">${escapar(mensagem)}</p>
    <div class="enviado-acoes">
      <a class="btn btn-dark" href="/agenda/minha-conta.html">Meus agendamentos</a>
      <a class="btn btn-linha" href="/agenda/">Ir para a agenda</a>
    </div>`;
}
