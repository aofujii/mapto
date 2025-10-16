const NOTIFICATION_WINDOWS = [
  { startHour: 7, endHour: 10 },
  { startHour: 12, endHour: 14 },
  { startHour: 18, endHour: 21 },
];
const NOTIFICATION_MESSAGES = [
  "近くの景色をマップで共有してみませんか？",
  "今いる場所のおすすめを一言投稿しましょう！",
  "今日の出来事を地図に残してみてください。",
  "散歩中の発見をシェアすると誰かが喜ぶかも！",
  "お気に入りのスポットをMapToに投稿しませんか？",
];
const REMINDER_LOOKAHEAD_DAYS = 3;
const map = L.map("map").setView([35.6812, 139.7671], 12);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markersLayer = L.layerGroup().addTo(map);
const postForm = document.getElementById("post-form");
const postText = document.getElementById("post-text");
const selectedLocationEl = document.getElementById("selected-location");
const radiusSelect = document.getElementById("radius");
const timelineEl = document.getElementById("timeline");
const useCurrentLocationBtn = document.getElementById("use-current-location");
const enableNotificationsBtn = document.getElementById("enable-notifications");
const moodPicker = document.getElementById("mood-picker");
const defaultPlaceholder =
  postText?.getAttribute("placeholder") ||
  "メッセージやおすすめを残してみよう（なくてもOK）";

let selectedLatLng = null;
let selectionMarker = null;
let isFetching = false;
let notificationsEnabled = false;
let notificationTimers = [];
let selectedMood = null;
let swRegistration = null;
let supportsTriggerScheduling = false;

initialize();

function initialize() {
  registerServiceWorker();
  fetchPosts();
  requestCurrentLocation({ centerMap: true, setSelection: true, silent: true });

  map.on("click", handleMapClick);
  map.on("moveend", debounce(fetchPosts, 500));

  radiusSelect.addEventListener("change", fetchPosts);

  postForm.addEventListener("submit", handleSubmit);

  if (useCurrentLocationBtn) {
    useCurrentLocationBtn.addEventListener("click", () => {
      useCurrentLocationBtn.disabled = true;
      const started = requestCurrentLocation({
        centerMap: true,
        setSelection: true,
        onComplete: () => {
          useCurrentLocationBtn.disabled = false;
        },
      });
      if (!started) {
        useCurrentLocationBtn.disabled = false;
        alert("現在地が利用できません。ブラウザの設定をご確認ください。");
      }
    });
  }

  if (moodPicker) {
    moodPicker.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mood]");
      if (!button) return;
      const mood = button.dataset.mood;
      if (selectedMood === mood) {
        setSelectedMood(null);
      } else {
        setSelectedMood(mood);
      }
    });
  }

  if (enableNotificationsBtn) {
    enableNotificationsBtn.addEventListener("click", handleNotificationButton);
    restoreNotificationPreference();
  }

  setInterval(fetchPosts, 30000);
}

function handleMapClick(event) {
  setSelectedLocation(event.latlng, { source: "map" });
}

function setSelectedLocation(latlng, { source } = {}) {
  selectedLatLng = latlng;
  selectedLocationEl.classList.remove("error");

  if (!selectionMarker) {
    selectionMarker = L.marker(latlng, { draggable: true }).addTo(map);
    selectionMarker.on("moveend", (moveEvent) => {
      setSelectedLocation(moveEvent.target.getLatLng(), { source: "drag" });
    });
  } else {
    const current = selectionMarker.getLatLng();
    if (!current.equals(latlng)) {
      selectionMarker.setLatLng(latlng);
    }
  }

  if (source === "geolocation") {
    selectedLocationEl.textContent = "投稿位置: 現在地";
  } else {
    selectedLocationEl.textContent = `投稿位置: ${latlng.lat.toFixed(
      4
    )}, ${latlng.lng.toFixed(4)}`;
  }
}

function setSelectedMood(mood) {
  selectedMood = mood;
  if (!moodPicker) return;
  Array.from(moodPicker.querySelectorAll("button[data-mood]")).forEach(
    (button) => {
      if (button.dataset.mood === mood) {
        button.classList.add("active");
      } else {
        button.classList.remove("active");
      }
    }
  );
  if (selectedMood && !postText.value.trim()) {
    postText.placeholder = defaultPlaceholder;
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register(
      "/service-worker.js"
    );
    const ready = await navigator.serviceWorker.ready;
    swRegistration = ready || registration;
    supportsTriggerScheduling = supportsNotificationTriggerCapability();
  } catch (error) {
    console.error("Service worker registration failed", error);
  }
}

function requestCurrentLocation({
  centerMap = false,
  setSelection = false,
  onComplete,
  silent = false,
} = {}) {
  if (!("geolocation" in navigator)) {
    if (typeof onComplete === "function") {
      onComplete(false);
    }
    if (!silent) {
      alert("このブラウザでは位置情報が利用できません。");
    }
    return false;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const latLng = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (centerMap) {
        const targetZoom = Math.max(map.getZoom(), 14);
        map.setView(latLng, targetZoom);
      }
      if (setSelection) {
        setSelectedLocation(latLng, { source: "geolocation" });
      }
      fetchPosts();
      if (typeof onComplete === "function") {
        onComplete(true);
      }
    },
    (error) => {
      console.error(error);
      if (!silent) {
        alert("現在地を取得できませんでした。位置情報の権限を確認してください。");
      }
      if (typeof onComplete === "function") {
        onComplete(false);
      }
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );

  return true;
}

function handleNotificationButton() {
  if (notificationsEnabled) {
    disableNotificationReminders();
  } else {
    enableNotificationReminders();
  }
}

async function enableNotificationReminders() {
  if (!enableNotificationsBtn) return;
  if (!("Notification" in window)) {
    alert("このブラウザは通知機能に対応していません。");
    return;
  }

  enableNotificationsBtn.disabled = true;

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (error) {
      console.error(error);
      permission = "denied";
    }
  }

  if (permission !== "granted") {
    alert("通知が許可されませんでした。ブラウザの設定をご確認ください。");
    enableNotificationsBtn.disabled = false;
    updateNotificationButton();
    return;
  }

  notificationsEnabled = true;
  await scheduleDailyNotifications();
  persistNotificationPreference(notificationsEnabled);
  enableNotificationsBtn.disabled = false;
  updateNotificationButton();
}

function disableNotificationReminders() {
  clearScheduledNotifications();
  if (supportsTriggerScheduling) {
    sendMessageToServiceWorker({ type: "cancelReminders" });
  }
  notificationsEnabled = false;
  persistNotificationPreference(false);
  updateNotificationButton();
}

async function scheduleDailyNotifications() {
  if (!supportsTriggerScheduling) {
    supportsTriggerScheduling = supportsNotificationTriggerCapability();
  }
  if (!("Notification" in window) || Notification.permission !== "granted") {
    disableNotificationReminders();
    return;
  }
  if (supportsTriggerScheduling && swRegistration) {
    await scheduleNotificationsWithTriggers();
    return;
  }
  scheduleFallbackNotifications();
}

function scheduleFallbackNotifications() {
  clearScheduledNotifications();
  NOTIFICATION_WINDOWS.forEach((windowSlot) => {
    scheduleNotificationForWindow(windowSlot);
  });
}

async function scheduleNotificationsWithTriggers() {
  try {
    clearScheduledNotifications();
    const registration =
      swRegistration || (await navigator.serviceWorker.ready);
    if (!registration?.active) {
      scheduleFallbackNotifications();
      return;
    }
    const reminders = buildReminderSchedule();
    await sendMessageToServiceWorker({ type: "cancelReminders" });
    if (reminders.length) {
      await sendMessageToServiceWorker({
        type: "scheduleReminders",
        reminders,
      });
    }
  } catch (error) {
    console.error("Failed to schedule notifications with triggers", error);
    scheduleFallbackNotifications();
  }
}

function buildReminderSchedule() {
  const schedule = [];
  const now = new Date();
  for (let dayOffset = 0; dayOffset < REMINDER_LOOKAHEAD_DAYS; dayOffset += 1) {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() + dayOffset);

    NOTIFICATION_WINDOWS.forEach((windowSlot, index) => {
      const windowStart = new Date(dayStart);
      windowStart.setHours(windowSlot.startHour, windowSlot.startMinute || 0, 0, 0);
      const windowEnd = new Date(dayStart);
      windowEnd.setHours(windowSlot.endHour, windowSlot.endMinute || 0, 0, 0);

      if (dayOffset === 0 && now >= windowEnd) {
        return;
      }
      if (windowEnd <= windowStart) {
        windowEnd.setTime(windowStart.getTime() + 60 * 60 * 1000);
      }

      let effectiveStart = windowStart;
      if (dayOffset === 0 && now > windowStart) {
        effectiveStart = new Date(now);
      }

      if (effectiveStart >= windowEnd) {
        return;
      }

      const diff = Math.max(
        1,
        windowEnd.getTime() - effectiveStart.getTime()
      );
      const triggerTime =
        effectiveStart.getTime() + Math.random() * diff;
      if (triggerTime <= Date.now()) {
        return;
      }
      schedule.push({
        time: triggerTime,
        title: "MapToからのお知らせ",
        body: pickNotificationMessage(),
        tag: `mapto-reminder-${dayOffset}-${windowSlot.startHour}-${index}`,
      });
    });
  }
  return schedule;
}

async function sendMessageToServiceWorker(message) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const controller = navigator.serviceWorker.controller;
    if (controller) {
      controller.postMessage(message);
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage(message);
  } catch (error) {
    console.error("Failed to communicate with service worker", error);
  }
}

function scheduleNotificationForWindow(windowSlot, baseDate = new Date()) {
  if (!notificationsEnabled) return;
  const nextTrigger = computeNextTrigger(windowSlot, baseDate);
  const delay = Math.max(0, nextTrigger.getTime() - Date.now());

  const timerId = setTimeout(() => {
    if (!notificationsEnabled) return;
    showReminderNotification();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    scheduleNotificationForWindow(windowSlot, tomorrow);
  }, delay);

  notificationTimers.push(timerId);
}

function computeNextTrigger(windowSlot, baseDate = new Date()) {
  const now = new Date(baseDate);
  const start = new Date(baseDate);
  start.setHours(windowSlot.startHour, windowSlot.startMinute || 0, 0, 0);
  const end = new Date(baseDate);
  end.setHours(windowSlot.endHour, windowSlot.endMinute || 0, 0, 0);

  let effectiveStart = start;
  let effectiveEnd = end;

  if (now >= end) {
    effectiveStart = new Date(start);
    effectiveEnd = new Date(end);
    effectiveStart.setDate(effectiveStart.getDate() + 1);
    effectiveEnd.setDate(effectiveEnd.getDate() + 1);
  } else if (now > start && now < end) {
    effectiveStart = new Date(now);
  } else {
    effectiveStart = start;
  }

  if (effectiveStart >= effectiveEnd) {
    effectiveEnd = new Date(effectiveStart.getTime() + 60 * 60 * 1000);
  }

  const diff = Math.max(
    1,
    effectiveEnd.getTime() - effectiveStart.getTime()
  );
  const triggerMs =
    effectiveStart.getTime() + Math.random() * diff;
  return new Date(triggerMs);
}

function showReminderNotification() {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    disableNotificationReminders();
    return;
  }
  const message = pickNotificationMessage();
  try {
    new Notification("MapToからのお知らせ", {
      body: message,
      tag: "mapto-reminder",
      renotify: false,
    });
  } catch (error) {
    console.error(error);
    disableNotificationReminders();
  }
}

function clearScheduledNotifications() {
  notificationTimers.forEach((timerId) => clearTimeout(timerId));
  notificationTimers = [];
}

function persistNotificationPreference(enabled) {
  try {
    if (enabled) {
      localStorage.setItem("mapto.notificationsEnabled", "true");
    } else {
      localStorage.removeItem("mapto.notificationsEnabled");
    }
  } catch (error) {
    console.error("Failed to persist notification preference", error);
  }
}

function restoreNotificationPreference() {
  updateNotificationButton();
  if (!enableNotificationsBtn) return;
  let stored = null;
  try {
    stored = localStorage.getItem("mapto.notificationsEnabled");
  } catch (error) {
    console.error(error);
  }

  if (
    stored === "true" &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    notificationsEnabled = true;
    scheduleDailyNotifications().catch((error) =>
      console.error("Failed to reschedule notifications", error)
    );
  } else if (stored === "true" && (!("Notification" in window) || Notification.permission !== "granted")) {
    persistNotificationPreference(false);
  }

  updateNotificationButton();
}

function updateNotificationButton() {
  if (!enableNotificationsBtn) return;
  if (!("Notification" in window)) {
    enableNotificationsBtn.textContent = "通知非対応のブラウザです";
    enableNotificationsBtn.disabled = true;
    return;
  }

  if (Notification.permission === "denied") {
    enableNotificationsBtn.textContent = "ブラウザ設定で通知がブロックされています";
    enableNotificationsBtn.disabled = true;
    return;
  }

  enableNotificationsBtn.disabled = false;
  if (notificationsEnabled) {
    enableNotificationsBtn.textContent = "投稿リマインダーを停止";
  } else {
    enableNotificationsBtn.textContent = "投稿リマインダーを受け取る";
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const text = postText.value.trim();
  if (!text && !selectedMood) {
    postText.placeholder = "気分だけでもOK！絵文字を選んでみてください。";
    postText.focus();
    return;
  }

  if (!selectedLatLng) {
    selectedLocationEl.textContent =
      "投稿位置が選択されていません。地図をクリックするか現在地を使用してください。";
    selectedLocationEl.classList.add("error");
    return;
  }

  postText.placeholder = defaultPlaceholder;
  setFormDisabled(true);

  try {
    const response = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: selectedLatLng.lat,
        lng: selectedLatLng.lng,
        text,
        mood: selectedMood,
      }),
    });

    if (!response.ok) {
      const payload = await safeJson(response);
      throw new Error(payload?.error || "投稿に失敗しました");
    }

    postText.value = "";
    postText.placeholder = defaultPlaceholder;
    setSelectedMood(null);
    const created = await response.json();
    highlightNewPost(created.id);
    fetchPosts();
  } catch (error) {
    console.error(error);
    alert(error.message);
  } finally {
    setFormDisabled(false);
  }
}

async function fetchPosts() {
  if (isFetching) return;
  isFetching = true;

  const center = map.getCenter();
  const radius = Number(radiusSelect.value) || 5000;

  try {
    const response = await fetch(
      `/api/posts?lat=${center.lat}&lng=${center.lng}&radius=${radius}`
    );
    if (!response.ok) {
      throw new Error("投稿の取得に失敗しました");
    }
    const posts = await response.json();
    renderPosts(posts, center);
  } catch (error) {
    console.error(error);
  } finally {
    isFetching = false;
  }
}

function renderPosts(posts, centerLatLng) {
  markersLayer.clearLayers();
  timelineEl.innerHTML = "";

  if (!posts.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "近くの投稿はまだありません。最初の投稿をしてみましょう！";
    timelineEl.appendChild(empty);
    return;
  }

  posts.forEach((post) => {
    addMarker(post);
    timelineEl.appendChild(buildTimelineItem(post, centerLatLng));
  });
}

function addMarker(post) {
  const marker = L.marker([post.lat, post.lng], {
    icon: L.divIcon({
      className: "post-marker",
      html: buildMarkerHtml(post),
      iconSize: null,
    }),
  });
  const created = new Date(post.timestamp);

  const bodyContent = post.text
    ? `<p>${escapeHtml(post.text)}</p>`
    : `<p class="popup-muted">気分だけの投稿</p>`;
  const moodContent = post.mood
    ? `<p class="popup-mood">${post.mood}</p>`
    : "";

  marker.bindPopup(
    `<div class="popup">
        ${moodContent}
        ${bodyContent}
        <small>${created.toLocaleString()}</small><br />
        <small>いいね ${post.likes}</small>
      </div>`
  );

  markersLayer.addLayer(marker);
}

function buildMarkerHtml(post) {
  const MAX_LENGTH = 60;
  const baseText = (post.text || "").trim();
  const truncated =
    baseText.length > MAX_LENGTH
      ? `${baseText.slice(0, MAX_LENGTH)}…`
      : baseText;
  const escapedText = escapeHtml(truncated);
  let displayText = "新しい投稿";
  if (post.mood && truncated) {
    displayText = `${post.mood} ${escapedText}`;
  } else if (post.mood) {
    displayText = post.mood;
  } else if (truncated) {
    displayText = escapedText;
  }
  return `
    <div class="post-marker__bubble">
      <div class="post-marker__text">${displayText}</div>
      <div class="post-marker__meta">❤️ ${post.likes}</div>
    </div>
  `;
}

function buildTimelineItem(post, centerLatLng) {
  const li = document.createElement("li");
  li.className = "timeline-item";
  li.dataset.id = post.id;

  if (post.mood) {
    const moodBadge = document.createElement("span");
    moodBadge.className = "mood-tag";
    moodBadge.textContent = post.mood;
    li.appendChild(moodBadge);
  }

  const textPara = document.createElement("p");
  textPara.className = "body";
  if (post.text) {
    textPara.textContent = post.text;
  } else if (post.mood) {
    textPara.classList.add("body-muted");
    textPara.textContent = "気分だけの投稿";
  } else {
    textPara.textContent = "";
  }
  li.appendChild(textPara);

  const meta = document.createElement("div");
  meta.className = "meta";

  const created = new Date(post.timestamp);
  const distance = centerLatLng
    ? formatDistance(
        distanceInMeters(
          centerLatLng.lat,
          centerLatLng.lng,
          post.lat,
          post.lng
        )
      )
    : "";

  const pieces = [`${created.toLocaleString()}`];
  if (distance) {
    pieces.push(`約${distance}`);
  }
  meta.innerHTML = `<span>${pieces.join(" ・ ")}</span><span>❤️ ${post.likes}</span>`;
  li.appendChild(meta);

  const likeButton = document.createElement("button");
  likeButton.className = "like-button";
  likeButton.type = "button";
  likeButton.textContent = `いいね ${post.likes}`;
  likeButton.addEventListener("click", () => handleLike(post.id, likeButton));
  li.appendChild(likeButton);

  return li;
}

async function handleLike(postId, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/posts/${postId}/like`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error("いいねに失敗しました");
    }
    const updated = await response.json();
    button.textContent = `いいね ${updated.likes}`;
    fetchPosts();
  } catch (error) {
    console.error(error);
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

function highlightNewPost(postId) {
  setTimeout(() => {
    const item = Array.from(
      timelineEl.querySelectorAll(".timeline-item")
    ).find((li) => li.dataset?.id === postId);
    if (item) {
      item.classList.add("highlight");
      setTimeout(() => item.classList.remove("highlight"), 2000);
    }
  }, 800);
}

function setFormDisabled(disabled) {
  Array.from(postForm.elements).forEach((el) => {
    el.disabled = disabled;
  });
}

function safeJson(response) {
  return response
    .clone()
    .json()
    .catch(() => null);
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn.apply(null, args);
    }, delay);
  };
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function distanceInMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

function supportsNotificationTriggerCapability() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "Notification" in window &&
    typeof Notification.prototype !== "undefined" &&
    "showTrigger" in Notification.prototype &&
    "TimestampTrigger" in window
  );
}

function pickNotificationMessage() {
  return NOTIFICATION_MESSAGES[
    Math.floor(Math.random() * NOTIFICATION_MESSAGES.length)
  ];
}
