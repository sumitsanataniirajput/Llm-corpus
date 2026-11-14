/* Service worker for optional browser push (Firebase Cloud Messaging).
   The public Firebase web config is passed in the registration URL by js/notifications.js. */
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');
try {
  const cfg = JSON.parse(new URL(self.location.href).searchParams.get('c') || 'null');
  if (cfg && cfg.apiKey) {
    firebase.initializeApp(cfg);
    firebase.messaging().onBackgroundMessage((payload) => {
      const n = payload.notification || {};
      self.registration.showNotification(n.title || 'Ride Manager', { body: n.body || '', icon: 'assets/icons/favicon.svg', data: payload.data || {}, requireInteraction: (payload.data || {}).priority === 'emergency' });
    });
  }
} catch (e) { /* push stays disabled */ }
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const page = (event.notification.data || {}).priority === 'emergency' ? '#/support?tab=incidents' : '#/notifications';
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => { for (const c of list) if ('focus' in c) { c.navigate(page); return c.focus(); } return self.clients.openWindow('./' + page); }));
});
