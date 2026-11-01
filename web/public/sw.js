// Shows the bridge's pushes (a run that needs an approval, a run that ended) and opens the page at that item on tap.
// iOS requires every push to show a notification, so one is always shown.
self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || "Agent dashboard", {
      body: d.body || "",
      tag: d.tag || undefined,
      icon: "/icon-192.png",
      data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
      for (const c of open) {
        if ("navigate" in c) return c.navigate(url).then((w) => (w || c).focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});
