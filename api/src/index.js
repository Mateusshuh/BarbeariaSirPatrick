// =============================================================================
// API da Barbearia Sir. Patrick
// =============================================================================
// Express puro, ESM, sem framework em cima. O que este serviço faz:
//   - recebe pedido, cancelamento, confirmação e recusa
//   - guarda as chaves privadas (VAPID, Resend, banco)
//   - envia as notificações da caixa de saída
//
// O que ele NÃO faz: entregar a grade de horários. Isso o navegador pede direto
// ao Supabase, porque este serviço dorme depois de 15 minutos no plano gratuito
// e leva cerca de um minuto para acordar — e ninguém encara um minuto de tela
// vazia para ver se tem vaga na terça.
// =============================================================================

import express from "express";
import cors from "cors";

import { publicas } from "./rotas/publicas.js";
import { pedidos } from "./rotas/pedidos.js";
import { admin } from "./rotas/admin.js";
import { push } from "./rotas/push.js";
import { iniciarFila } from "./notificacoes/fila.js";
import { descreverErro } from "./db.js";

const app = express();
app.set("trust proxy", 1);   // atrás do proxy do Render: req.ip vira o IP real

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------
// Só a origem do Static Site. Nada de "*": com "*" qualquer página da internet
// poderia disparar chamadas usando o token de quem estivesse logado.
const ORIGEM = process.env.ORIGEM_PERMITIDA || "";
const origensPermitidas = ORIGEM.split(",").map((o) => o.trim()).filter(Boolean);

app.use(cors({
  origin(origem, callback) {
    // Sem Origin é chamada de servidor (o ping do health check, por exemplo).
    if (!origem) return callback(null, true);
    if (origensPermitidas.includes(origem)) return callback(null, true);
    callback(new Error("origem não permitida"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
}));

app.use(express.json({ limit: "16kb" }));

// -----------------------------------------------------------------------------
// Log
// -----------------------------------------------------------------------------
// Uma linha por requisição: método, rota, status, tempo. Token, senha e corpo
// nunca entram no log — log é arquivo que vaza.
app.use((req, res, next) => {
  const t0 = Date.now();

  // A rota é lida AGORA, e não no finish: quando a resposta termina, o Express
  // já reescreveu req.path para o caminho relativo de dentro do router, e o log
  // sairia como "/saude" em vez de "/api/saude".
  const rota = req.originalUrl.split("?")[0];

  res.on("finish", () => {
    // O ping do health check bate a cada 10 minutos; registrar todos só afoga
    // o que interessa.
    if (rota === "/api/saude" && res.statusCode === 200) return;
    console.log(`${req.method} ${rota} ${res.statusCode} ${Date.now() - t0}ms`);
  });

  next();
});

// -----------------------------------------------------------------------------
// Limite de requisições
// -----------------------------------------------------------------------------
// Contador em memória por IP. Um Redis para isto seria mais infraestrutura para
// manter, mais uma coisa para cair, e este serviço é um só.
const janelas = new Map();

function limite(max, segundos) {
  return (req, res, next) => {
    const chave = `${req.ip}:${req.baseUrl}`;
    const agora = Date.now();
    const registro = janelas.get(chave);

    if (!registro || registro.ate < agora) {
      janelas.set(chave, { contagem: 1, ate: agora + segundos * 1000 });
      return next();
    }

    registro.contagem += 1;
    if (registro.contagem > max) {
      res.set("Retry-After", String(Math.ceil((registro.ate - agora) / 1000)));
      return res.status(429).json({ erro: "MUITAS_TENTATIVAS" });
    }
    next();
  };
}

// Faxina de vez em quando, para o mapa não crescer para sempre.
setInterval(() => {
  const agora = Date.now();
  for (const [chave, registro] of janelas) if (registro.ate < agora) janelas.delete(chave);
}, 60_000).unref();

// -----------------------------------------------------------------------------
// Rotas
// -----------------------------------------------------------------------------
app.use("/api", limite(300, 60), publicas);
app.use("/api", limite(60, 60), pedidos);
app.use("/api/admin", limite(300, 60), admin);
app.use("/api/push", limite(30, 60), push);

app.use((req, res) => res.status(404).json({ erro: "NAO_ENCONTRADO" }));

// Último recurso: qualquer erro não tratado vira 500 com código estável. O
// texto do Postgres nunca chega ao navegador.
app.use((erro, req, res, _next) => {
  console.error(`[erro] ${req.method} ${req.originalUrl}:`, descreverErro(erro));
  if (erro.message === "origem não permitida") {
    return res.status(403).json({ erro: "ORIGEM_NAO_PERMITIDA" });
  }
  res.status(500).json({ erro: "ERRO_INTERNO" });
});

// -----------------------------------------------------------------------------
// Arranque
// -----------------------------------------------------------------------------
const porta = process.env.PORT || 3000;

app.listen(porta, () => {
  console.log(`[api] no ar na porta ${porta}`);
  console.log(`[api] origem permitida: ${origensPermitidas.join(", ") || "(nenhuma!)"}`);
  iniciarFila();
});

// O Render manda SIGTERM antes de derrubar. Fechar direito evita erro de
// conexão cortada no meio de um pedido.
process.on("SIGTERM", () => {
  console.log("[api] SIGTERM, encerrando");
  process.exit(0);
});
