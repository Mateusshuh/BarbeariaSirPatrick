// =============================================================================
// O que cada aviso diz
// =============================================================================
// Texto num arquivo só. Quando o Patrick pedir para mudar uma frase, é aqui —
// e só aqui.
// =============================================================================

const FUSO = "America/Sao_Paulo";

/** "sexta-feira, 11/09 às 14:50" */
export function quando(data) {
  const d = new Date(data);
  const dia = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO, weekday: "long", day: "2-digit", month: "2-digit"
  }).format(d);
  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO, hour: "2-digit", minute: "2-digit"
  }).format(d);
  return `${dia} às ${hora}`;
}

const SITE = (process.env.ORIGEM_PERMITIDA || "").split(",")[0].trim();

// -----------------------------------------------------------------------------
// Push para o Patrick
// -----------------------------------------------------------------------------
// O corpo é uma linha só, com o que decide a resposta: quem, quando, o quê. Os
// botões de ação vêm do service worker, a partir do id.
export function pushPatrick(tipo, a) {
  const linha = `${a.nome} · ${quando(a.inicio)} · ${a.servico}`;

  if (tipo === "lembrete") {
    return {
      titulo: "Pedido ainda sem resposta",
      corpo: linha,
      id: a.id,
      url: "/admin/"
    };
  }

  if (tipo === "resposta") {
    // O cliente desmarcou: o horário vagou e isso muda o dia dele.
    return {
      titulo: "Horário cancelado pelo cliente",
      corpo: linha,
      // Sem id: não há o que confirmar nem recusar, então a notificação não
      // ganha botões de ação — só abre a agenda.
      url: "/admin/"
    };
  }

  return { titulo: "Novo pedido de horário", corpo: linha, id: a.id, url: "/admin/" };
}

// -----------------------------------------------------------------------------
// Push para o cliente
// -----------------------------------------------------------------------------
export function pushCliente(a) {
  const titulos = {
    confirmado: "Horário confirmado",
    recusado: "Horário não confirmado",
    cancelado: "Horário cancelado"
  };
  return {
    titulo: titulos[a.status] || "Novidade no seu agendamento",
    corpo: `${quando(a.inicio)} · ${a.servico}`,
    url: "/agenda/minha-conta.html"
  };
}

// -----------------------------------------------------------------------------
// E-mail para o cliente
// -----------------------------------------------------------------------------
// E-mail é o canal principal do cliente: ele abriu o site uma vez pelo
// navegador do celular e provavelmente não autorizou notificação. Contar só com
// push para avisá-lo é contar com o que não vai acontecer.
export function emailCliente(a) {
  const primeiroNome = String(a.nome || "").split(" ")[0];
  const motivo = a.motivo_recusa ? `Motivo: ${a.motivo_recusa}.` : "";

  const conteudo = {
    confirmado: {
      assunto: "Horário confirmado — Barbearia Sir. Patrick",
      titulo: "Horário confirmado",
      frase: `O Patrick confirmou seu horário: <strong>${quando(a.inicio)}</strong>.`,
      fecho: "Te esperamos na cadeira. Se precisar desmarcar, dá para cancelar pela agenda.",
      botao: "Ver meus agendamentos"
    },
    recusado: {
      assunto: "Horário não confirmado — Barbearia Sir. Patrick",
      titulo: "Horário não confirmado",
      frase: `O Patrick não pôde atender <strong>${quando(a.inicio)}</strong>.`,
      fecho: `${motivo} O horário voltou para a agenda — escolha outro quando quiser.`.trim(),
      botao: "Escolher outro horário"
    },
    cancelado: {
      assunto: "Horário cancelado — Barbearia Sir. Patrick",
      titulo: "Horário cancelado",
      frase: `Seu horário de <strong>${quando(a.inicio)}</strong> foi cancelado.`,
      fecho: `${motivo} Você pode marcar outro pela agenda.`.trim(),
      botao: "Marcar outro horário"
    }
  }[a.status];

  if (!conteudo) return null;

  const destino = a.status === "confirmado"
    ? `${SITE}/agenda/minha-conta.html`
    : `${SITE}/agenda/`;

  const texto = [
    `Olá, ${primeiroNome}.`,
    "",
    conteudo.frase.replace(/<[^>]+>/g, ""),
    `${a.servico}. ${conteudo.fecho}`,
    "",
    SITE ? `${conteudo.botao}: ${destino}` : "",
    "",
    "Barbearia Sir. Patrick — Três de Maio, RS"
  ].join("\n");

  const html = `
<div style="background:#F7F2E8;padding:32px 18px;font-family:Georgia,'Times New Roman',serif;color:#1B1917">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #E2D8C6;padding:30px 28px">
    <p style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:11px;
              letter-spacing:.2em;text-transform:uppercase;color:#8A8177;margin:0 0 18px">
      Barbearia Sir. Patrick
    </p>
    <h1 style="font-size:25px;font-weight:600;margin:0 0 16px;line-height:1.2">${conteudo.titulo}</h1>
    <p style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;
              line-height:1.65;margin:0 0 12px">
      Olá, ${escapar(primeiroNome)}. ${conteudo.frase}
    </p>
    <p style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;
              line-height:1.65;margin:0 0 24px">
      ${escapar(a.servico)}. ${escapar(conteudo.fecho)}
    </p>
    ${SITE ? `<a href="${destino}"
       style="display:inline-block;background:#1B1917;color:#F7F2E8;text-decoration:none;
              padding:14px 24px;font-family:system-ui,sans-serif;font-size:13px;font-weight:600;
              letter-spacing:.02em">${conteudo.botao}</a>` : ""}
    <p style="font-family:system-ui,sans-serif;font-size:12px;color:#8A8177;margin:26px 0 0;
              border-top:1px solid #E2D8C6;padding-top:16px">
      Três de Maio, RS · você recebeu este e-mail porque tem conta na agenda da barbearia.
    </p>
  </div>
</div>`;

  return { assunto: conteudo.assunto, texto, html };
}

function escapar(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
