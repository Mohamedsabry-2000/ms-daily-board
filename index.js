// functions/index.js
// نفس منطق فحص الإشعارات، لكن بيشتغل على بنية جوجل نفسها (Cloud Scheduler)
// بدل GitHub Actions — أضمن وأدق في التوقيت، ومفيش سكريت لازم تديره بنفسك.

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

const CAIRO_TZ = "Africa/Cairo";
const APP_URL = "https://Mohamedsabry-2000.github.io/ms-daily-board/";

function todayStr() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function nowHHMM() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CAIRO_TZ, hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return `${map.hour}:${map.minute}`;
}

function subtractMinutes(hhmm, minutes) {
  if (!minutes) return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m - minutes;
  if (total < 0) total = 0;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return String(nh).padStart(2, "0") + ":" + String(nm).padStart(2, "0");
}

async function runNotificationCheck() {
  const today = todayStr();
  const currentTime = nowHHMM();
  const runStart = Date.now();
  let usersWithDueTasks = 0;
  let usersWithoutDevices = 0;
  let totalNotificationsSent = 0;
  let totalSendFailures = 0;

  const usersSnap = await db.collection("users").get();

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const tasksSnap = await db.collection("users").doc(uid).collection("tasks").get();
    if (tasksSnap.empty) continue;

    const dueNow = [];
    tasksSnap.forEach((doc) => {
      const t = doc.data();
      if (t.lastNotified === today) return;

      if (t.dueDate) {
        if (t.dueDate !== today) return;
        if (t.done) return;
        if (t.dueTime) {
          const notifyAt = subtractMinutes(t.dueTime, t.reminderLead || 0);
          if (notifyAt > currentTime) return;
        }
      } else {
        if (t.lastDoneDate === today) return;
      }
      dueNow.push({ ref: doc.ref, task: t });
    });

    if (dueNow.length === 0) continue;
    usersWithDueTasks++;

    const devicesSnap = await db.collection("users").doc(uid).collection("devices").get();
    const tokens = devicesSnap.docs.map((d) => d.id);
    if (tokens.length === 0) {
      usersWithoutDevices++;
      continue;
    }

    const title = dueNow.length === 1 ? "🔔 تذكير" : `🔔 لديك ${dueNow.length} حاجات مستحقة`;
    const body = dueNow.length === 1 ?
      `${dueNow[0].task.icon ? dueNow[0].task.icon + " " : ""}${dueNow[0].task.title}` :
      dueNow.slice(0, 3).map((x) => "• " + (x.task.icon ? x.task.icon + " " : "") + x.task.title).join("\n") +
        (dueNow.length > 3 ? `\n+ ${dueNow.length - 3} تانيين` : "");

    try {
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        webpush: {
          fcmOptions: { link: APP_URL },
          notification: { icon: APP_URL + "icon-192.png" }
        }
      });
      totalNotificationsSent += response.successCount;
      totalSendFailures += response.failureCount;

      response.responses.forEach((r, i) => {
        if (!r.success && r.error.code === "messaging/registration-token-not-registered") {
          db.collection("users").doc(uid).collection("devices").doc(tokens[i]).delete().catch(() => {});
        }
      });
    } catch (err) {
      console.error(`فشل الإرسال للمستخدم ${uid}:`, err.message);
      totalSendFailures += tokens.length;
      continue;
    }

    const batch = db.batch();
    dueNow.forEach(({ ref }) => batch.update(ref, { lastNotified: today }));
    await batch.commit();
  }

  await db.collection("system").doc("notifyStatus").set({
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    triggeredBy: "cloud-scheduler",
    usersChecked: usersSnap.size,
    usersWithDueTasks,
    usersWithoutDevices,
    totalNotificationsSent,
    totalSendFailures,
    durationMs: Date.now() - runStart
  });
}

// بيشتغل كل 5 دقايق بضمانة جوجل نفسها (Cloud Scheduler) — أضمن بكتير من GitHub Actions
exports.checkAndNotify = onSchedule(
  { schedule: "every 5 minutes", timeZone: CAIRO_TZ, region: "us-central1" },
  async () => {
    await runNotificationCheck();
  }
);

// ============================================================
// مفتاح الإيقاف التلقائي للفوترة (Billing Kill-Switch)
// بيتفعّل لما تنبيه ميزانية (Budget Alert) يوصل من Google Cloud،
// وبيوقف الفوترة على المشروع فورًا لو المصروف تخطّى الحد اللي حددته.
// مبني على مثال جوجل الرسمي لنفس الغرض بالظبط.
// ============================================================
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { CloudBillingClient } = require("@google-cloud/billing");

const billingClient = new CloudBillingClient();
const PROJECT_ID = "ms-daily-board";
const PROJECT_NAME = `projects/${PROJECT_ID}`;

async function isBillingEnabled(projectName) {
  try {
    const [res] = await billingClient.getProjectBillingInfo({ name: projectName });
    return res.billingEnabled;
  } catch (err) {
    console.error("تعذر التأكد من حالة الفوترة، هنفترض إنها لسه شغالة:", err.message);
    return true;
  }
}

async function disableBillingForProject(projectName) {
  const [res] = await billingClient.updateProjectBillingInfo({
    name: projectName,
    resource: { billingAccountName: "" } // فاضي = فصل الفوترة عن المشروع
  });
  console.log("تم إيقاف الفوترة:", JSON.stringify(res));
  return "تم إيقاف الفوترة بنجاح";
}

// اسم موضوع Pub/Sub لازم يتطابق بالظبط مع اللي هتربطه بالميزانية في Google Cloud Console
exports.stopBillingOnBudgetAlert = onMessagePublished(
  { topic: "billing-alerts", region: "us-central1" },
  async (event) => {
    const pubsubData = event.data.message.json;

    if (pubsubData.costAmount <= pubsubData.budgetAmount) {
      console.log(`لسه تحت الحد المسموح (المصروف: ${pubsubData.costAmount})`);
      return;
    }

    console.warn(`⚠️ المصروف (${pubsubData.costAmount}) تخطّى الحد (${pubsubData.budgetAmount}) — هيتم إيقاف الفوترة الآن`);

    const enabled = await isBillingEnabled(PROJECT_NAME);
    if (enabled) {
      await disableBillingForProject(PROJECT_NAME);
    } else {
      console.log("الفوترة متوقفة بالفعل");
    }
  }
);
