// Aviso do lembrete diário. Só mostra a notificação: não guarda páginas nem intercepta o site.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
const ES = new URL(self.location.href).searchParams.get("l") === "es";
self.addEventListener("push", e => e.waitUntil(self.registration.showNotification("Hipocampo Study", {
  body: ES ? "Es hora de tu repaso. 5 minutos para no olvidar lo que estudiaste." : "Hora da sua revisão. 5 minutos para não esquecer o que você estudou.",
  icon: "icone-192.png", badge: "icone-192.png", tag: "revisao", lang: ES ? "es" : "pt-BR"
})));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(l => l.length ? l[0].focus() : self.clients.openWindow("./")));
});
