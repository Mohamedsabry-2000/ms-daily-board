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

// GitHub Actions بيشغّل السكريبت بتوقيت UTC، لكن مواعيدك متسجلة بتوقيت القاهرة —
// من غير التحويل ده، أي مقارنة للوقت هتبقى غلط بفارق ساعتين أو أكتر.
const CAIRO_TZ = 'Africa/Cairo';

function todayStr(){
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

// وقت الجرد الحالي بصيغة HH:MM بتوقيت القاهرة، عشان نقارنه بوقت المهمة (dueTime) لو محدد
function nowHHMM(){
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CAIRO_TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.hour}:${map.minute}`;
}

// بيحسب "وقت التنبيه الفعلي" بطرح مدة التذكير المسبق من وقت الميعاد (نفس منطق التطبيق بالظبط)
function subtractMinutes(hhmm, minutes){
  if(!minutes) return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  let total = h * 60 + m - minutes;
  if(total < 0) total = 0;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return String(nh).padStart(2, '0') + ':' + String(nm).padStart(2, '0');
}

async function main(){
  const today = todayStr();
  const currentTime = nowHHMM();

  // بنجيب كل المستخدمين
  const usersSnap = await db.collection('users').get();
  console.log(`عدد المستخدمين: ${usersSnap.size}`);

  for(const userDoc of usersSnap.docs){
    const uid = userDoc.id;

    // بنجيب كل مهام المستخدم (مش بس اللي ليها تاريخ) عشان نغطي المهام اليومية والعادات كمان
    const tasksSnap = await db.collection('users').doc(uid).collection('tasks').get();
    if(tasksSnap.empty) continue;

    // فلترة: أي مهمة (بتاريخ أو يومية/عادة) مستحقة النهاردة ولسه ما اتبعتش عليها إشعار
    const dueNow = [];
    tasksSnap.forEach(doc => {
      const t = doc.data();
      if(t.lastNotified === today) return;

      if(t.dueDate){
        // مهمة بتاريخ محدد: تتفحص بتاريخها ووقتها وحالة الإنجاز العادية
        if(t.dueDate !== today) return;
        if(t.done) return;
        if(t.dueTime){
          const notifyAt = subtractMinutes(t.dueTime, t.reminderLead || 0);
          if(notifyAt > currentTime) return;
        }
      } else {
        // مهمة يومية متكررة أو عادة: تتفحص بـ lastDoneDate (بترجع "مش خلصانة" كل يوم جديد)
        if(t.lastDoneDate === today) return;
      }
      dueNow.push({ ref: doc.ref, task: t });
    });

    if(dueNow.length === 0) continue;

    // نجيب أجهزة المستخدم المسجلة للإشعارات
    const devicesSnap = await db.collection('users').doc(uid).collection('devices').get();
    const tokens = devicesSnap.docs.map(d => d.id);
    if(tokens.length === 0){ console.log(`المستخدم ${uid} معندوش أجهزة مسجلة`); continue; }

    const title = dueNow.length === 1 ? '🔔 تذكير' : `🔔 لديك ${dueNow.length} حاجات مستحقة`;
    const body = dueNow.length === 1
      ? `${dueNow[0].task.icon ? dueNow[0].task.icon + ' ' : ''}${dueNow[0].task.title}`
      : dueNow.slice(0, 3).map(x => '• ' + (x.task.icon ? x.task.icon + ' ' : '') + x.task.title).join('\n')
        + (dueNow.length > 3 ? `\n+ ${dueNow.length - 3} تانيين` : '');

    try{
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        webpush: {
          fcmOptions: { link: 'https://Mohamedsabry-2000.github.io/ms-daily-board/' },
          notification: { icon: 'https://Mohamedsabry-2000.github.io/ms-daily-board/icon-192.png' }
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
