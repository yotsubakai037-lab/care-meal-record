'use strict';
const express = require('express');
const admin   = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');
const path = require('path');
const crypto = require('crypto');

const app  = express();
const PORT = process.env.PORT || 8080;
const PROJECT  = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.VERTEX_LOCATION || 'asia-northeast1';

// ── Firebase Admin（Cloud Run では ADC で自動認証） ──
admin.initializeApp();
const db = admin.firestore();

// ── Vertex AI Gemini ──
const vertexAI = new VertexAI({ project: PROJECT, location: LOCATION });
const gemini = vertexAI.getGenerativeModel({ model: 'gemini-2.0-flash-001' });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================
// 認証ミドルウェア
// ============================
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証が必要です' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(header.slice(7));
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: '認証トークンが無効です' });
  }
}

// ============================
// Firebase 設定（フロント用）
// ============================
app.get('/api/firebase-config', (_req, res) => {
  res.json({
    apiKey:     process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${PROJECT}.firebaseapp.com`,
    projectId:  PROJECT,
  });
});

// ============================
// 利用者 API
// ============================
const residentsCol = (uid) => db.collection(`users/${uid}/residents`);

app.get('/api/residents', requireAuth, async (req, res) => {
  try {
    const snap = await residentsCol(req.uid).orderBy('createdAt', 'asc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: toISO(d.data().createdAt) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/residents', requireAuth, async (req, res) => {
  const { name, room, defaultMealTexture } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '名前は必須です' });
  try {
    const data = {
      name: name.trim(),
      room: (room || '').trim(),
      defaultMealTexture: defaultMealTexture || '普通食',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await residentsCol(req.uid).add(data);
    res.json({ id: ref.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/residents/:id', requireAuth, async (req, res) => {
  try {
    // 関連する記録を一括削除
    const recSnap = await recordsCol(req.uid, req.params.id).get();
    const batch = db.batch();
    recSnap.forEach(d => batch.delete(d.ref));
    batch.delete(residentsCol(req.uid).doc(req.params.id));
    await batch.commit();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================
// 記録 API
// ============================
const recordsCol = (uid, residentId) =>
  db.collection(`users/${uid}/residents/${residentId}/records`);

app.get('/api/records/:residentId', requireAuth, async (req, res) => {
  try {
    const snap = await recordsCol(req.uid, req.params.residentId)
      .orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: toISO(d.data().createdAt) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/records', requireAuth, async (req, res) => {
  const { residentId, mealTime, mealTexture, thumbnailBase64,
          amount, percentage, aiComment, note } = req.body;
  if (!residentId) return res.status(400).json({ error: '利用者IDが必要です' });
  try {
    const data = {
      residentId,
      mealTime:       mealTime       || '昼食',
      mealTexture:    mealTexture    || '普通食',
      thumbnailBase64: thumbnailBase64 || null,   // 200px サムネイル
      amount:         amount         || '',
      percentage:     typeof percentage === 'number' ? percentage : 0,
      aiComment:      aiComment      || '',
      note:           note           || '',
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await recordsCol(req.uid, residentId).add(data);
    res.json({ id: ref.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/records/:residentId/:id', requireAuth, async (req, res) => {
  try {
    await recordsCol(req.uid, req.params.residentId).doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================
// AI 分析（Vertex AI Gemini）
// ============================
app.post('/api/analyze', requireAuth, async (req, res) => {
  const { imageBase64, mealTexture, mealTime } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '画像が必要です' });

  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  try {
    const result = await gemini.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
          { text: `介護施設の${mealTime || '食事'}記録です。食事形態「${mealTexture || '普通食'}」。

写真を分析し、必ずJSON形式のみで返答してください（説明文不要）:
{
  "amount": "半量",
  "percentage": 50,
  "comment": "主食を半量程度摂取。副菜の摂取は少なめ。食欲は普通。"
}

amountは必ず以下から選択:
"全量"(90%以上) / "3/4量"(75%) / "半量"(50%) / "1/4量"(25%) / "ほとんど食べず"(10%以下)

commentは介護記録として有用な観察を1〜2文、日本語で。` }
        ]
      }]
    });

    const text = result.response.candidates[0].content.parts[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse((text.match(/\{[\s\S]*?\}/) || ['{}'])[0]);
    } catch {
      parsed = { amount: '判定不可', percentage: 0, comment: text.slice(0, 100) };
    }
    res.json(parsed);
  } catch (e) {
    console.error('Vertex AI error:', e.message);
    res.status(500).json({ error: 'AI分析に失敗: ' + e.message });
  }
});

// ユーティリティ
function toISO(ts) {
  return ts?.toDate?.()?.toISOString() || ts || null;
}

app.listen(PORT, () => {
  console.log(`\n🏥 介護食事記録システム (GCP版)`);
  console.log(`Port: ${PORT}  Project: ${PROJECT}  Location: ${LOCATION}\n`);
});
