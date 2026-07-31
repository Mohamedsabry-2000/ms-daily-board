// notify.js
// بيتشغل كل شوية عن طريق GitHub Actions، بيدور على المهام المستحقة لكل المستخدمين
// وبيبعت إشعار حقيقي (push) حتى لو التطبيق مقفول تمامًا.

const admin = require('firebase-admin');

// بيقرأ مفتاح حساب الخدمة من متغير بيئة (GitHub Secret) اسمه FIREBASE_SERVICE_ACCOUNT
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

function todayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// وقت الجرد الحالي بصيغة HH:MM، عشان نقارنه بوقت المهمة (dueTime) لو محدد
function nowHHMM(){
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function main(){
  const today = todayStr();
  const currentTime = nowHHMM();

  // بنجيب كل المستخدمين
  const usersSnap = await db.collection('users').get();
  console.log(`عدد المستخدمين: ${usersSnap.size}`);

  for(const userDoc of usersSnap.docs){
    const uid = userDoc.id;

    // المهام المستحقة اليوم واللي لسه ماتعملهاش
    const tasksSnap = await db.collection('users').doc(uid).collection('tasks')
      .where('dueDate', '==', today)
      .where('done', '==', false)
      .get();

    if(tasksSnap.empty) continue;

    // فلترة: مهام مستحقة اليوم ولسه ما اتبعتش عليها إشعار النهاردة
    const dueNow = [];
    tasksSnap.forEach(doc => {
      const t = doc.data();
      if(t.lastNotified === today) return;
      if(t.dueTime && t.dueTime > currentTime) return; // لسه معدهاش وقتها
      dueNow.push({ ref: doc.ref, task: t });
    });

    if(dueNow.length === 0) continue;

    // نجيب أجهزة المستخدم المسجلة للإشعارات
    const devicesSnap = await db.collection('users').doc(uid).collection('devices').get();
    const tokens = devicesSnap.docs.map(d => d.id);
    if(tokens.length === 0){ console.log(`المستخدم ${uid} معندوش أجهزة مسجلة`); continue; }

    const title = dueNow.length === 1 ? '🔔 تذكير بمهمة' : `🔔 لديك ${dueNow.length} مهام مستحقة`;
    const body = dueNow.length === 1
      ? dueNow[0].task.title
      : dueNow.slice(0, 3).map(x => '• ' + x.task.title).join('\n');

    try{
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        webpush: {
          fcmOptions: { link: 'https://YOUR_USERNAME.github.io/ms-daily-board/' },
          notification: { icon: 'https://YOUR_USERNAME.github.io/ms-daily-board/icon-192.png' }
        }
      });
      console.log(`اتبعت لـ ${uid}: ${response.successCount} نجح، ${response.failureCount} فشل`);

      // تنظيف التوكنات المنتهية/الغير صالحة
      response.responses.forEach((r, i) => {
        if(!r.success && (r.error.code === 'messaging/registration-token-not-registered')){
          db.collection('users').doc(uid).collection('devices').doc(tokens[i]).delete().catch(()=>{});
        }
      });
    }catch(err){
      console.error(`فشل الإرسال للمستخدم ${uid}:`, err.message);
      continue;
    }

    // تعليم المهام كـ "اتبعتلها إشعار النهاردة" عشان ما نكررش (نفس الحقل اللي بيستخدمه التطبيق نفسه)
    const batch = db.batch();
    dueNow.forEach(({ ref }) => {
      batch.update(ref, { lastNotified: today });
    });
    await batch.commit();
  }

  console.log('خلصت الجولة ✓');
}

main().catch(err => {
  console.error('حصل خطأ عام:', err);
  process.exit(1);
});
