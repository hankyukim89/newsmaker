const express = require('express');
const fetch = require('node-fetch');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULT_SETTINGS = {
  apiKeys: { gemini: '', openai: '', anthropic: '' },
  aiRouting: {
    translation: { provider: 'gemini', model: 'gemini-2.5-flash' },
    titles:      { provider: 'gemini', model: 'gemini-2.5-flash' },
    image:       { provider: 'openai', model: 'gpt-image-2-2026-04-21', imageSize: '1536x1024' }
  },
  prompts: {
    translation: `당신은 전문 한국어 신문 기자 겸 번역가입니다.
아래 영어 뉴스 기사를 한국어 신문 기사체로 번역하세요.
- 격식체(합쇼체)를 사용하세요
- 객관적인 보도 문체를 유지하세요
- 모든 핵심 사실, 인용구, 데이터를 보존하세요
- 강력한 첫 문단(리드)으로 시작하세요
- 번역된 기사 본문만 출력하고 설명은 생략하세요`,
    titles: `당신은 한국 신문 편집장입니다. 아래 한국어 뉴스 기사를 바탕으로 제목과 소제목 쌍을 정확히 3개 생성하세요.
다음 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
[
  {"title": "제목1", "subtitle": "소제목1"},
  {"title": "제목2", "subtitle": "소제목2"},
  {"title": "제목3", "subtitle": "소제목3"}
]
제목: 20자 이내, 임팩트 있게. 소제목: 40자 이내, 정보 전달 위주.`,
    image: `Create a professional editorial news photograph for a Korean newspaper article about: {summary}. Photorealistic, editorial style, neutral and objective, suitable for front page newspaper use. No text or watermarks.`
  },
  saveFolder: path.join(os.homedir(), 'Documents', '뉴스번역'),
  autoLoadToday: true
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        ...DEFAULT_SETTINGS, ...saved,
        apiKeys:   { ...DEFAULT_SETTINGS.apiKeys,   ...saved.apiKeys },
        aiRouting: {
          ...DEFAULT_SETTINGS.aiRouting, ...saved.aiRouting,
          translation: { ...DEFAULT_SETTINGS.aiRouting.translation, ...(saved.aiRouting?.translation || {}) },
          titles:      { ...DEFAULT_SETTINGS.aiRouting.titles,      ...(saved.aiRouting?.titles      || {}) },
          image:       { ...DEFAULT_SETTINGS.aiRouting.image,       ...(saved.aiRouting?.image       || {}) },
        },
        prompts:   { ...DEFAULT_SETTINGS.prompts,   ...saved.prompts }
      };
    }
  } catch (e) { console.error('Settings load error:', e.message); }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function todayFolder(settings) {
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return path.join(settings.saveFolder, dateStr);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ── Settings ──────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(loadSettings()));

app.post('/api/settings', (req, res) => {
  saveSettings(req.body);
  res.json({ ok: true });
});

// ── Scrape ────────────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
      timeout: 20000
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) throw new Error('기사 내용을 추출할 수 없습니다');
    res.json({ title: article.title, content: article.textContent.trim(), excerpt: article.excerpt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Translate ─────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { text, customInstruction } = req.body;
  const settings = loadSettings();
  const { provider, model } = settings.aiRouting.translation;
  let prompt = `${settings.prompts.translation}\n\n기사 원문:\n${text}`;
  if (customInstruction) prompt += `\n\n추가 지시사항: ${customInstruction}`;
  try {
    const result = provider === 'openai'
      ? await callOpenAIText(settings.apiKeys.openai, model, prompt)
      : await callGemini(settings.apiKeys.gemini, model, prompt);
    res.json({ text: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model, provider });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Titles ────────────────────────────────────────────────
app.post('/api/titles', async (req, res) => {
  const { article, customInstruction } = req.body;
  const settings = loadSettings();
  const { provider, model } = settings.aiRouting.titles;
  let prompt = `${settings.prompts.titles}\n\n기사:\n${article}`;
  if (customInstruction) prompt += `\n\n추가 지시사항: ${customInstruction}`;
  try {
    const result = provider === 'openai'
      ? await callOpenAIText(settings.apiKeys.openai, model, prompt)
      : await callGemini(settings.apiKeys.gemini, model, prompt);
    const jsonMatch = result.text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) throw new Error('제목 생성 응답을 파싱할 수 없습니다');
    const titles = JSON.parse(jsonMatch[0]);
    res.json({ titles, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model, provider });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Image ─────────────────────────────────────────────────
app.post('/api/image', async (req, res) => {
  const { summary, articleText, customInstruction } = req.body;
  const settings = loadSettings();
  const { provider, model } = settings.aiRouting.image;
  const textRouting = settings.aiRouting.translation; // use translation model for prompt gen

  // Step 1: AI generates a creative, article-specific image prompt
  const sourceText = (articleText || summary || '').slice(0, 3000);
  const promptInstruction = `You are an editorial photo director for a Korean newspaper. Based on the news article below, write a concise and vivid image generation prompt (2–3 sentences) describing the ideal editorial photograph. Be specific: describe the scene, subjects, setting, lighting, and mood. Output ONLY the image description with no extra text or explanation.\n\nArticle:\n${sourceText}`;

  let creativePrompt = summary || 'news photograph';
  let promptInputTokens = 0, promptOutputTokens = 0;
  try {
    const textResult = textRouting.provider === 'openai'
      ? await callOpenAIText(settings.apiKeys.openai, textRouting.model, promptInstruction)
      : await callGemini(settings.apiKeys.gemini, textRouting.model, promptInstruction);
    if (textResult.text) {
      creativePrompt = textResult.text.trim();
      promptInputTokens = textResult.inputTokens;
      promptOutputTokens = textResult.outputTokens;
    }
  } catch (_) { /* fall back to summary */ }

  // Step 2: Combine with user's pre-prompt template (+ optional custom instruction)
  let imagePrompt = settings.prompts.image.replace('{summary}', creativePrompt);
  if (customInstruction) imagePrompt += `\n\nAdditional instruction: ${customInstruction}`;

  // Step 3: Generate image
  try {
    const imageSize = settings.aiRouting.image.imageSize || '1024x1024';
    let imageData;
    if (provider === 'gemini') {
      imageData = await generateImageGemini(settings.apiKeys.gemini, model, imagePrompt);
    } else {
      imageData = await generateImageOpenAI(settings.apiKeys.openai, model, imagePrompt, imageSize);
    }
    res.json({
      image: imageData,
      prompt: imagePrompt,
      creativePrompt,
      model, provider,
      promptInputTokens, promptOutputTokens,
      promptModel: textRouting.model,
      promptProvider: textRouting.provider,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Save state (auto-save) ────────────────────────────────
app.post('/api/save-state', (req, res) => {
  const { articles } = req.body;
  const settings = loadSettings();
  try {
    const folder = todayFolder(settings);
    ensureDir(folder);
    fs.writeFileSync(path.join(folder, 'articles.json'), JSON.stringify(articles, null, 2), 'utf8');

    // Write individual txt + jpg for done articles
    articles.forEach((article, i) => {
      if (article.status !== 'done') return;
      const num = String(i + 1).padStart(2, '0');
      const sel = article.titleIterations?.[article.selectedTitleIteration]?.[article.selectedTitleIndex];
      const titleText = sel?.title || `article_${num}`;
      const safeName = titleText.replace(/[^가-힣\w]/g, '_').slice(0, 50);
      const baseName = `${num}_${safeName}`;
      const body = article.bodyIterations?.[article.selectedBodyIteration] || '';
      const txt = [sel?.title || '', sel?.subtitle || '', '', body].join('\n');
      fs.writeFileSync(path.join(folder, `${baseName}.txt`), txt, 'utf8');

      const imgData = article.imageIterations?.[article.selectedImageIteration]?.data;
      if (imgData) {
        const b64 = imgData.replace(/^data:image\/\w+;base64,/, '');
        try { fs.writeFileSync(path.join(folder, `${baseName}.jpg`), Buffer.from(b64, 'base64')); } catch (_) {}
      }
    });

    res.json({ ok: true, folder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Load today ────────────────────────────────────────────
app.get('/api/load-today', (req, res) => {
  const settings = loadSettings();
  const folder = todayFolder(settings);
  const file = path.join(folder, 'articles.json');
  if (fs.existsSync(file)) {
    try {
      return res.json({ articles: JSON.parse(fs.readFileSync(file, 'utf8')), folder });
    } catch (_) {}
  }
  res.json({ articles: [], folder });
});

// ── AI helpers ────────────────────────────────────────────
async function callGemini(apiKey, model, prompt) {
  if (!apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    inputTokens: data.usageMetadata?.promptTokenCount || 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
  };
}

async function callOpenAIText(apiKey, model, prompt) {
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return {
    text: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

async function generateImageGemini(apiKey, model, prompt) {
  if (!apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData);
  if (!imgPart) throw new Error('Gemini에서 이미지를 받지 못했습니다');
  const mime = imgPart.inlineData.mimeType || 'image/jpeg';
  return `data:${mime};base64,${imgPart.inlineData.data}`;
}

async function generateImageOpenAI(apiKey, model, prompt, size) {
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const resolvedModel = model || 'gpt-image-2';
  const imgSize = size || '1024x1024';
  const body = resolvedModel.startsWith('dall-e')
    ? { model: resolvedModel, prompt, n: 1, size: imgSize, response_format: 'b64_json' }
    : { model: resolvedModel, prompt, n: 1, size: imgSize };
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('이미지 데이터를 받지 못했습니다');
  return `data:image/jpeg;base64,${b64}`;
}

const PORT = 3737;
app.listen(PORT, () => {
  console.log(`\n✅ 뉴스 번역기 실행 중`);
  console.log(`👉 브라우저에서 열기: http://localhost:${PORT}\n`);
});
