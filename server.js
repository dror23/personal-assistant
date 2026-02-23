const express = require('express');
const { google } = require('googleapis');
const cron = require('node-cron');
const webpush = require('web-push');

const app = express();
app.use(express.json());

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════
//  Google OAuth2
// ══════════════════════════════════════════
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://localhost'
);

// אם יש טוקן שמור — טען אותו
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// ══════════════════════════════════════════
//  Web Push (התראות)
// ══════════════════════════════════════════
webpush.setVapidDetails(
  'mailto:' + (process.env.ADMIN_EMAIL || 'admin@example.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// שמירת subscriptions בזיכרון (פשוט לשלב זה)
let pushSubscriptions = [];

// ══════════════════════════════════════════
//  Routes
// ══════════════════════════════════════════

// בדיקת חיות
app.get('/', (req, res) => {
  res.json({ status: 'Personal Assistant Server running ✅' });
});

// שמירת push subscription
app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!pushSubscriptions.find(s => s.endpoint === sub.endpoint)) {
    pushSubscriptions.push(sub);
  }
  res.json({ ok: true });
});

// Google OAuth — קבלת URL להתחברות
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/spreadsheets'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

// Google OAuth — callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.json({
      message: 'התחברות הצליחה! שמור את ה-refresh_token הזה כ-GOOGLE_REFRESH_TOKEN',
      refresh_token: tokens.refresh_token
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// שליפת אירועים מ-Google Calendar להיום
app.get('/calendar/today', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = (response.data.items || []).map(e => ({
      title: e.summary,
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      location: e.location || ''
    }));

    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// שמירת הכרת תודה ב-Google Sheets
app.post('/gratitude', async (req, res) => {
  const { text, date } = req.body;
  const spreadsheetId = process.env.SPREADSHEET_ID;

  if (!spreadsheetId) {
    return res.status(400).json({ error: 'SPREADSHEET_ID חסר' });
  }

  try {
    const d = new Date(date || new Date());
    const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                        'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const sheetName = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    const dateStr = `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;

    // בדוק אם הגליון קיים, אם לא — צור אותו
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetExists = spreadsheet.data.sheets.some(
      s => s.properties.title === sheetName
    );

    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [{
            addSheet: {
              properties: { title: sheetName }
            }
          }]
        }
      });
      // כותרות
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1:B1`,
        valueInputOption: 'RAW',
        resource: { values: [['תאריך', 'הכרת תודה']] }
      });
    }

    // הוסף שורה חדשה
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:B`,
      valueInputOption: 'RAW',
      resource: { values: [[dateStr, text]] }
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// שליחת התראה ידנית (לבדיקה)
app.post('/notify', async (req, res) => {
  const { title, body } = req.body;
  await sendPushToAll({ title, body });
  res.json({ ok: true, sent: pushSubscriptions.length });
});

// ══════════════════════════════════════════
//  פונקציית שליחת התראה
// ══════════════════════════════════════════
async function sendPushToAll(payload) {
  const message = JSON.stringify(payload);
  const results = await Promise.allSettled(
    pushSubscriptions.map(sub => webpush.sendNotification(sub, message))
  );
  // הסר subscriptions שנכשלו
  pushSubscriptions = pushSubscriptions.filter((_, i) =>
    results[i].status === 'fulfilled'
  );
}

// ══════════════════════════════════════════
//  CRON — התראות אוטומטיות (שעון ישראל UTC+2/3)
// ══════════════════════════════════════════

// 07:00 — בוקר טוב + הכרת תודה (UTC 04:00 בקיץ / 05:00 בחורף)
cron.schedule('0 5 * * *', () => {
  sendPushToAll({
    title: '🌅 בוקר טוב דרור!',
    body: 'הגיע הזמן להכרת תודה ובריפינג יומי',
    url: '/?action=morning'
  });
});

// 11:00 — בדיקת התקדמות (UTC 08:00)
cron.schedule('0 8 * * *', () => {
  sendPushToAll({
    title: '📋 בדיקת משימות',
    body: 'מה הספקת עד עכשיו?',
    url: '/?action=checkin'
  });
});

// 15:00 — לפני סוף עבודה (UTC 12:00)
cron.schedule('0 12 * * *', () => {
  sendPushToAll({
    title: '⏰ עוד שעה וחצי לסוף העבודה',
    body: 'מה נשאר לסיים?',
    url: '/?action=afternoon'
  });
});

// 18:00 — ערב (UTC 15:00) — נשלח תמיד, האפליקציה תחליט אם להציג
cron.schedule('0 15 * * *', () => {
  sendPushToAll({
    title: '🌆 תזכורת ערב',
    body: 'יש משימות פתוחות שדורשות התייחסות',
    url: '/?action=evening'
  });
});

// 21:30 — סיכום יום (UTC 18:30)
cron.schedule('30 18 * * *', () => {
  sendPushToAll({
    title: '🌙 סיכום יום',
    body: 'הגיע הזמן לסכם את היום ולהוקיר תודה',
    url: '/?action=summary'
  });
});

// שישי 14:00 — תזכורת שיחה עם הורים (UTC 11:00, יום 5 = שישי)
cron.schedule('0 11 * * 5', () => {
  sendPushToAll({
    title: '📞 שיחה עם ההורים',
    body: 'היום שישי — זמן לשיחה עם אמא ואבא',
    url: '/?action=parents'
  });
});

// ══════════════════════════════════════════
//  הפעלת השרת
// ══════════════════════════════════════════
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Personal Assistant Server פועל על פורט ${PORT}`);
});
