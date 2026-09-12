// =============================================================================
// Assinatura de notificação por aparelho
// =============================================================================
// A tabela push_assinaturas não é mais escrita pelo navegador: quem grava é
// este endpoint, que sabe de qual conta é o token. Assim ninguém cadastra
// assinatura no nome de outra pessoa.
// =============================================================================

import { Router } from "express";
import { z } from "zod";
import { q, uma } from "../db.js";
import { exigeCliente } from "../auth.js";

export const push = Router();

const Assinatura = z.object({
  endpoint: z.string().url().max(600),
  keys: z.object({
    p256dh: z.string().min(10).max(200),
    auth: z.string().min(10).max(100)
  })
});

push.post("/assinar", exigeCliente, async (req, res, next) => {
  try {
    const corpo = Assinatura.safeParse(req.body);
    if (!corpo.success) return res.status(400).json({ erro: "DADOS_INVALIDOS" });

    const { endpoint, keys } = corpo.data;

    // O mesmo aparelho pode reassinar (o navegador troca a chave de tempos em
    // tempos). A chave (user_id, endpoint) faz a segunda vez virar atualização.
    const linha = await uma(
      `insert into push_assinaturas (user_id, endpoint, p256dh, auth)
       values ($1, $2, $3, $4)
       on conflict (user_id, endpoint) do update
          set p256dh = excluded.p256dh, auth = excluded.auth
       returning id`,
      [req.usuario.id, endpoint, keys.p256dh, keys.auth]
    );

    res.status(201).json({ ok: true, id: linha.id });
  } catch (erro) { next(erro); }
});

push.delete("/assinar", exigeCliente, async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint || "");
    if (!endpoint) return res.status(400).json({ erro: "DADOS_INVALIDOS" });

    await q("delete from push_assinaturas where user_id = $1 and endpoint = $2",
      [req.usuario.id, endpoint]);

    res.json({ ok: true });
  } catch (erro) { next(erro); }
});
