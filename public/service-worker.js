const scheduledTags = new Set();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const { type, reminders } = event.data || {};
  if (type === "scheduleReminders") {
    event.waitUntil(scheduleReminders(reminders));
  } else if (type === "cancelReminders") {
    event.waitUntil(cancelReminders());
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if (allClients.length > 0) {
        const client = allClients[0];
        await client.focus();
      } else if (self.registration?.navigationPreload) {
        await clients.openWindow("/");
      } else {
        await clients.openWindow("/");
      }
    })()
  );
});

async function scheduleReminders(reminders = []) {
  if (!supportsNotificationTriggers() || !Array.isArray(reminders)) {
    return;
  }
  if (!reminders.length) return;

  await cancelReminders();

  for (const reminder of reminders) {
    if (!reminder || typeof reminder.time !== "number") continue;
    try {
      const trigger = new TimestampTrigger(reminder.time);
      await self.registration.showNotification(
        reminder.title || "MapToからのお知らせ",
        {
          body: reminder.body || "",
          tag: reminder.tag || "mapto-reminder",
          showTrigger: trigger,
          data: {
            tag: reminder.tag || "mapto-reminder",
          },
        }
      );
      if (reminder.tag) {
        scheduledTags.add(reminder.tag);
      }
    } catch (error) {
      console.error("Failed to schedule reminder", error);
    }
  }
}

async function cancelReminders() {
  if (!supportsNotificationTriggers()) {
    return;
  }
  try {
    const notifications = await self.registration.getNotifications({
      includeTriggered: true,
    });
    notifications.forEach((notification) => {
      const tag =
        notification?.data?.tag ||
        notification.tag;
      if (!tag || scheduledTags.size === 0) {
        notification.close();
        return;
      }
      if (scheduledTags.has(tag)) {
        notification.close();
      }
    });
  } catch (error) {
    console.error("Failed to cancel scheduled reminders", error);
  } finally {
    scheduledTags.clear();
  }
}

function supportsNotificationTriggers() {
  return (
    "showNotification" in (self.registration || {}) &&
    "TimestampTrigger" in self
  );
}
