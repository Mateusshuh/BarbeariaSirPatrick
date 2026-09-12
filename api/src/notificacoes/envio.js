// =============================================================================
// Os dois canais de envio
// =============================================================================
// Push (web-push, com as chaves VAPID) e e-mail (Resend). As duas chaves
// privadas vivem só nas variáveis de ambiente do Render — nunca no repositório,
// nunca no navegador.
// =============================================================================

import webpush from "web-push";
import { q } from "../db.js";

const TEM_VAPID = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

if (TEM_VAPID) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:contato@barbeariasirpatrick.com.br",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn("[envio] sem chaves VAPID: push desligado");
}

/**
 * Manda um push para todos os aparelhos de um conjunto de contas.
 * Devolve quantos aparelhos receberam.
 */
export async function enviarPush(usuarios, carga) {
  if (!TEM_VAPID || !usuarios.length) return 0;

  const { rows: assinaturas } = await q(
    "select id, endpoint, p256dh, auth from push_assinaturas where user_id = any($1)",
    [usuarios]
  );

  let entregues = 0;

  for (const a of assinaturas) {
    try {
      await webpush.sendNotification(
        { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
        JSON.stringify(carga),
        { TTL: 60 * 60 * 12 }   // 12h: depois disso o aviso perdeu a validade
      );
      entregues += 1;
    } catch (erro) {
      // 404 e 410 são o serviço de push dizendo que a assinatura morreu: app
      // desinstalado, dados do navegador limpos, aparelho trocado. Guardar
      // endpoint morto só faz a próxima entrega demorar mais.
      if (erro.statusCode === 404 || erro.statusCode === 410) {
        await q("delete from push_assinaturas where id = $1", [a.id]);
        console.log("[envio] assinatura morta removida");
      } else {
        console.error("[envio] push falhou:", erro.statusCode, erro.body || erro.message);
      }
    }
  }

  return entregues;
}

/**
 * Manda um e-mail pelo Resend. Devolve true quando o provedor aceitou.
 */
export async function enviarEmail(para, { assunto, texto, html }) {
  const chave = process.env.RESEND_API_KEY;
  if (!chave) {
    console.warn("[envio] sem RESEND_API_KEY: e-mail não enviado");
    return false;
  }

  const resposta = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chave}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.EMAIL_REMETENTE || "Barbearia Sir. Patrick <onboarding@resend.dev>",
      to: [para],
      subject: assunto,
      text: texto,
      html
    })
  });

  if (!resposta.ok) {
    const detalhe = await resposta.text();
    throw new Error(`resend ${resposta.status}: ${detalhe.slice(0, 200)}`);
  }

  return true;
}
