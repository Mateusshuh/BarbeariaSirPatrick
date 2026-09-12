// =============================================================================
// Service worker da agenda (cliente)
// =============================================================================
// Para o cliente, notificação é camada extra: o canal principal é o e-mail.
// Ele abre o site uma vez pelo navegador do celular e provavelmente não vai
// autorizar notificação de um site que acabou de conhecer — então aqui não há
// botão de ação, só o aviso e o toque que leva para os agendamentos.
// =============================================================================

self.addEventListener("install", (evento) => evento.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (evento) => evento.waitUntil(self.clients.claim()));

self.addEventListener("push", (evento) => {
  let dados = {};
  try {
    dados = evento.data ? evento.data.json() : {};
  } catch (_) {
    dados = { titulo: "Barbearia Sir. Patrick", corpo: evento.data ? evento.data.text() : "" };
  }

  evento.waitUntil(self.registration.showNotification(dados.titulo || "Barbearia Sir. Patrick", {
    body: dados.corpo || "",
    icon: "/admin/icone-192.png",
    badge: "/admin/badge-96.png",
    lang: "pt-BR",
    tag: dados.id ? `agendamento-${dados.id}` : "sir-patrick",
    renotify: true,
    data: { url: dados.url || "/agenda/minha-conta.html" }
  }));
});

self.addEventListener("notificationclick", (evento) => {
  evento.notification.close();
  const destino = (evento.notification.data && evento.notification.data.url) || "/agenda/minha-conta.html";

  evento.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const aba of abertas) {
      if (aba.url.includes("/agenda/")) {
        await aba.focus();
        if ("navigate" in aba) return aba.navigate(destino);
      }
    }
    return self.clients.openWindow(destino);
  })());
});
