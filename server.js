const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Anthropicクライアント初期化
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// データ読み書きユーティリティ
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJSON(filePath, defaultVal = []) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return defaultVal;
  }
}

async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ローカルIPアドレス取得
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================
// 利用者 API
// ============================

// 利用者一覧取得
app.get('/api/residents', async (req, res) => {
  const residents = await readJSON(path.join(DATA_DIR, 'residents.json'));
  res.json(residents);
});

// 利用者追加
app.post('/api/residents', async (req, res) => {
  const { name, room, defaultMealTexture } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '名前は必須です' });
  }
  const residents = await readJSON(path.join(DATA_DIR, 'residents.json'));
  const resident = {
    id: crypto.randomUUID(),
    name: name.trim(),
    room: (room || '').trim(),
    defaultMealTexture: defaultMealTexture || '普通食',
    createdAt: new Date().toISOString(),
  };
  residents.push(resident);
  await writeJSON(path.join(DATA_DIR, 'residents.json'), residents);
  res.json(resident);
});

// 利用者削除
app.delete('/api/residents/:id', async (req, res) => {
  const residents = await readJSON(path.join(DATA_DIR, 'residents.json'));
  const filtered = residents.filter(r => r.id !== req.params.id);
  await writeJSON(path.join(DATA_DIR, 'residents.json'), filtered);
  // 関連する記録も削除
  try {
    await fs.unlink(path.join(DATA_DIR, `records_${req.params.id}.json`));
  } catch {}
  res.json({ ok: true });
});

// ============================
// 記録 API
// ============================

// 記録一覧取得（新しい順）
app.get('/api/records/:residentId', async (req, res) => {
  const records = await readJSON(path.join(DATA_DIR, `records_${req.params.residentId}.json`));
  res.json([...records].reverse());
});

// 記録保存
app.post('/api/records', async (req, res) => {
  const { residentId, mealTime, mealTexture, imageBase64, amount, percentage, aiComment, note } = req.body;
  if (!residentId) {
    return res.status(400).json({ error: '利用者IDが必要です' });
  }
  const records = await readJSON(path.join(DATA_DIR, `records_${residentId}.json`));
  const record = {
    id: crypto.randomUUID(),
    residentId,
    mealTime: mealTime || '昼食',
    mealTexture: mealTexture || '普通食',
    imageBase64: imageBase64 || null,
    amount: amount || '',
    percentage: typeof percentage === 'number' ? percentage : 0,
    aiComment: aiComment || '',
    note: note || '',
    createdAt: new Date().toISOString(),
  };
  records.push(record);
  await writeJSON(path.join(DATA_DIR, `records_${residentId}.json`), records);
  res.json(record);
});

// 記録削除
app.delete('/api/records/:residentId/:recordId', async (req, res) => {
  const records = await readJSON(path.join(DATA_DIR, `records_${req.params.residentId}.json`));
  const filtered = records.filter(r => r.id !== req.params.recordId);
  await writeJSON(path.join(DATA_DIR, `records_${req.params.residentId}.json`), filtered);
  res.json({ ok: true });
});

// ============================
// AI分析 API
// ============================

app.post('/api/analyze', async (req, res) => {
  const { imageBase64, mealTexture, mealTime } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ error: '画像が必要です' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
  }

  // base64のプレフィックスを除去（data:image/jpeg;base64,... 形式の場合）
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64Data,
            },
          },
          {
            type: 'text',
            text: `介護施設の食事記録です。食事の種類は「${mealTime || '食事'}」、食事形態は「${mealTexture || '普通食'}」です。

写真を見て以下を判定してください。

回答はJSON形式のみで返してください（説明文は不要）:
{
  "amount": "全量",
  "percentage": 100,
  "comment": "コメント"
}

amountの選択肢: "全量"(100%) / "3/4量"(75%) / "半量"(50%) / "1/4量"(25%) / "ほとんど食べず"(10%以下)
commentは介護記録として有用な観察コメントを1〜2文で。`
          }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    let result;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('JSON not found');
      result = JSON.parse(jsonMatch[0]);
    } catch {
      result = { amount: '判定不可', percentage: 0, comment: '画像から食事量を判定できませんでした。' };
    }

    res.json(result);
  } catch (error) {
    console.error('AI分析エラー:', error.message);
    res.status(500).json({ error: 'AI分析に失敗しました: ' + error.message });
  }
});

// APIキー確認
app.get('/api/status', (req, res) => {
  res.json({
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    version: '1.0.0',
  });
});

// サーバー起動
ensureDir(DATA_DIR).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('\n====================================');
    console.log('  介護食事記録システム 起動中');
    console.log('====================================');
    console.log(`  PC用URL:      http://localhost:${PORT}`);
    console.log(`  iPhone用URL:  http://${ip}:${PORT}`);
    console.log('====================================');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('\n⚠️  警告: ANTHROPIC_API_KEY が未設定です');
      console.log('   AI分析機能は使用できません');
      console.log('   設定方法: set ANTHROPIC_API_KEY=your_key_here\n');
    } else {
      console.log('\n✅ AI分析機能: 有効\n');
    }
  });
});
