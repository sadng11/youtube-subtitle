// Background Service Worker for YouTube Persian Subtitle Translator

// Active translation controllers keyed by tabId: tabId -> { videoId, controller: AbortController, cancelled: boolean }
const activeTranslationsByTab = new Map();

function cancelTabTranslation(tabId, reason = 'unknown') {
  if (!tabId) return;
  const active = activeTranslationsByTab.get(tabId);
  if (active) {
    console.log(`[YT-FA-Translator SW] 🛑 Cancelling translation for tab ${tabId} (video: ${active.videoId || 'unknown'}). Reason: ${reason}`);
    active.cancelled = true;
    if (active.controller) {
      try {
        active.controller.abort();
      } catch (_) {}
    }
    activeTranslationsByTab.delete(tabId);
  }
}

// 1. Listen for tab closed -> Immediately abort translation
chrome.tabs.onRemoved.addListener((tabId) => {
  cancelTabTranslation(tabId, 'Tab closed');
});

// 2. Listen for tab navigation / URL change -> Abort previous video translation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    cancelTabTranslation(tabId, 'Tab navigated to ' + changeInfo.url);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE_CHUNK') {
    const tabId = sender.tab?.id;
    const videoId = message.videoId;

    if (tabId && activeTranslationsByTab.get(tabId)?.cancelled) {
      console.log(`[YT-FA-Translator SW] 🛑 Rejecting chunk request for cancelled tab ${tabId}`);
      sendResponse({ success: false, cancelled: true, error: 'ترجمه لغو شده است.' });
      return true;
    }

    const controller = new AbortController();
    if (tabId) {
      activeTranslationsByTab.set(tabId, { videoId, controller, cancelled: false });
    }

    translateChunk(message, controller.signal)
      .then((result) => {
        if (tabId && activeTranslationsByTab.get(tabId)?.cancelled) {
          sendResponse({ success: false, cancelled: true, error: 'ترجمه لغو شده است.' });
        } else {
          sendResponse({ success: true, ...result });
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === 'AbortError') {
          console.log(`[YT-FA-Translator SW] 🛑 Translation chunk aborted for tab ${tabId}`);
          sendResponse({ success: false, cancelled: true, error: 'درخواست لغو شد.' });
        } else {
          console.error('[YT-FA-Translator SW] ❌ Chunk translation error:', error);
          sendResponse({ success: false, error: error.message });
        }
      });
    return true;
  }

  if (message.type === 'CANCEL_TRANSLATION') {
    const tabId = sender.tab?.id || message.tabId;
    console.log(`[YT-FA-Translator SW] 🛑 Received CANCEL_TRANSLATION for tab ${tabId}, videoId: ${message.videoId}`);
    cancelTabTranslation(tabId, 'Explicit user/page cancellation');
    sendResponse({ success: true, cancelled: true });
    return true;
  }

  if (message.type === 'SAVE_FULL_CACHE') {
    saveToCache(message.videoId, message.items)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CHECK_CACHE') {
    checkCache(message.videoId)
      .then((data) => sendResponse({ success: true, cached: !!data, items: data }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'TEST_CONNECTION') {
    testApiConnection(message.provider, message.apiKey, message.model, message.customBaseUrl)
      .then((res) => sendResponse({ success: true, ...res }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'TRANSLATE_SINGLE') {
    const tabId = sender.tab?.id;
    if (tabId && activeTranslationsByTab.get(tabId)?.cancelled) {
      sendResponse({ success: false, cancelled: true, error: 'ترجمه لغو شده است.' });
      return true;
    }

    const controller = new AbortController();
    if (tabId) {
      activeTranslationsByTab.set(tabId, { controller, cancelled: false });
    }

    translateSingleText(message.text, controller.signal)
      .then((res) => {
        if (tabId && activeTranslationsByTab.get(tabId)?.cancelled) {
          sendResponse({ success: false, cancelled: true, error: 'ترجمه لغو شده است.' });
        } else {
          sendResponse({ success: true, ...res });
        }
      })
      .catch((err) => {
        if (controller.signal.aborted || err.name === 'AbortError') {
          sendResponse({ success: false, cancelled: true, error: 'درخواست لغو شد.' });
        } else {
          console.error('[YT-FA-Translator SW] ❌ TRANSLATE_SINGLE error:', err);
          sendResponse({ success: false, error: err.message });
        }
      });
    return true;
  }

  if (message.type === 'FETCH_TIMEDTEXT') {
    fetchTimedTextUrl(message.url)
      .then((rawText) => sendResponse({ success: true, rawText }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

const singleLineCache = new Map();
let cachedGeminiModel = null;
let cachedGeminiKey = null;

async function fetchTimedTextUrl(url) {
  if (!url) throw new Error('TimedText URL is empty.');
  const fullUrl = url.includes('&fmt=') ? url : `${url}&fmt=json3`;
  console.log('[YT-FA-Translator SW] 🌐 Fetching timedtext directly:', fullUrl);
  const res = await fetch(fullUrl);
  if (!res.ok) {
    throw new Error(`TimedText fetch failed with status: ${res.status}`);
  }
  return await res.text();
}

async function checkCache(videoId) {
  if (!videoId) return null;
  const key = `yt_sub_${videoId}`;
  const res = await chrome.storage.local.get(key);
  return res[key] || null;
}

async function saveToCache(videoId, items) {
  if (!videoId || !items) return;
  const key = `yt_sub_${videoId}`;
  await chrome.storage.local.set({ [key]: items });
}

function normalizeChatCompletionsUrl(baseUrl) {
  if (!baseUrl) return '';
  let url = baseUrl.trim().replace(/\/+$/, '');

  if (url.endsWith('/chat/completions')) {
    return url;
  }
  if (url.endsWith('/v1')) {
    return `${url}/chat/completions`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${url}/v1/chat/completions`;
    }
  } catch (_) {}

  return `${url}/chat/completions`;
}

async function getApiCredentials() {
  const settings = await chrome.storage.local.get([
    'provider',
    'geminiApiKey',
    'openaiApiKey',
    'customBaseUrl',
    'customApiKey',
    'customModel',
    'geminiModel',
    'openaiModel'
  ]);

  const provider = settings.provider || 'gemini';

  if (provider === 'custom') {
    const baseUrl = (settings.customBaseUrl || '').trim();
    const model = (settings.customModel || '').trim();
    if (!baseUrl) {
      throw new Error('آدرس پایه (Base URL) برای سرویس سفارشی وارد نشده است. لطفاً در تنظیمات افزونه آن را تکمیل کنید.');
    }
    if (!model) {
      throw new Error('نام مدل (Model) برای سرویس سفارشی وارد نشده است. لطفاً در تنظیمات افزونه آن را تکمیل کنید.');
    }
    return {
      provider: 'custom',
      baseUrl: baseUrl,
      apiKey: (settings.customApiKey || '').trim(),
      model: model
    };
  }

  const apiKey = (provider === 'openai' ? settings.openaiApiKey : settings.geminiApiKey) || '';

  if (!apiKey.trim()) {
    throw new Error(
      `کلید API وارد نشده است. لطفاً روی آیکون افزونه کلیک کرده و کلید ${
        provider === 'openai' ? 'OpenAI' : 'Google Gemini'
      } را ذخیره کنید.`
    );
  }

  return {
    provider,
    apiKey: apiKey.trim(),
    model: provider === 'openai' ? settings.openaiModel || 'gpt-4o-mini' : settings.geminiModel || 'gemini-1.5-flash'
  };
}

async function translateChunk({ chunkItems }, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!chunkItems || chunkItems.length === 0) return { translations: [] };

  const creds = await getApiCredentials();
  const simplified = chunkItems.map((item) => ({ id: item.id, text: item.text }));

  console.log(
    `%c[YT-FA-Translator SW] 🚀 [LLM Request] Starting batch chunk of ${simplified.length} items via ${creds.provider.toUpperCase()}`,
    'color: #3b82f6; font-weight: bold;',
    simplified.slice(0, 2)
  );

  let translations = [];
  let usedModel = creds.model;

  if (creds.provider === 'openai') {
    translations = await callOpenAICompatible('https://api.openai.com/v1', creds.apiKey, creds.model, simplified, signal);
  } else if (creds.provider === 'custom') {
    translations = await callOpenAICompatible(creds.baseUrl, creds.apiKey, creds.model, simplified, signal);
  } else {
    const geminiRes = await callGeminiWithFallback(creds.apiKey, creds.model, simplified, signal);
    translations = geminiRes.translations;
    usedModel = geminiRes.usedModel;
  }

  console.log(
    `%c[YT-FA-Translator SW] 📥 [LLM Response] Successfully received ${translations.length} translations from ${creds.provider.toUpperCase()} (${usedModel})`,
    'color: #10b981; font-weight: bold;',
    translations.slice(0, 2)
  );

  return { translations, provider: creds.provider, model: usedModel };
}

async function translateSingleText(text, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!text || !text.trim()) return { fa: '' };
  const clean = text.trim();

  if (singleLineCache.has(clean)) {
    console.log('[YT-FA-Translator SW] ⚡ Cache hit for live caption:', clean);
    return { fa: singleLineCache.get(clean), cached: true };
  }

  const creds = await getApiCredentials();
  const batch = [{ id: 1, text: clean }];

  console.log(
    `%c[YT-FA-Translator SW] 🚀 [LLM Request] Live translation via ${creds.provider.toUpperCase()} (${creds.model}): "${clean}"`,
    'color: #3b82f6; font-weight: bold;'
  );

  let translations = [];
  let usedModel = creds.model;

  if (creds.provider === 'openai') {
    translations = await callOpenAICompatible('https://api.openai.com/v1', creds.apiKey, creds.model, batch, signal);
  } else if (creds.provider === 'custom') {
    translations = await callOpenAICompatible(creds.baseUrl, creds.apiKey, creds.model, batch, signal);
  } else {
    const geminiRes = await callGeminiWithFallback(creds.apiKey, creds.model, batch, signal);
    translations = geminiRes.translations;
    usedModel = geminiRes.usedModel;
  }

  const fa = translations?.[0]?.fa || clean;

  console.log(
    `%c[YT-FA-Translator SW] 📥 [LLM Response] Live caption translated via ${creds.provider.toUpperCase()} (${usedModel}):`,
    'color: #10b981; font-weight: bold;',
    `"${clean}" => "${fa}"`
  );

  singleLineCache.set(clean, fa);
  return { fa, provider: creds.provider, model: usedModel, cached: false };
}

async function testApiConnection(provider, apiKey, model, customBaseUrl) {
  const cleanKey = (apiKey || '').trim();

  if (provider === 'custom') {
    const baseUrl = (customBaseUrl || '').trim();
    if (!baseUrl) throw new Error('آدرس پایه (Base URL) وارد نشده است.');
    const targetModel = (model || '').trim();
    if (!targetModel) throw new Error('نام مدل (Model) وارد نشده است.');

    const chatUrl = normalizeChatCompletionsUrl(baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (cleanKey) {
      headers['Authorization'] = `Bearer ${cleanKey}`;
    }

    let res;
    try {
      res = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 5
        })
      });
    } catch (netErr) {
      throw new Error(`امکان برقراری ارتباط با ${chatUrl} وجود ندارد: ${netErr.message}`);
    }

    if (!res.ok) {
      const txt = await res.text();
      let err = `خطای سرور سفارشی (${res.status})`;
      try {
        const j = JSON.parse(txt);
        if (j.error?.message) err += `: ${j.error.message}`;
        else if (j.message) err += `: ${j.message}`;
      } catch (_) {
        err += `: ${txt.slice(0, 150)}`;
      }
      throw new Error(err);
    }

    return { message: `اتصال به مسیر سفارشی با مدل ${targetModel} با موفقیت برقرار شد ✓` };
  }

  if (!cleanKey) throw new Error('کلید API خالی است.');

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${cleanKey}` }
    });
    if (!res.ok) {
      const txt = await res.text();
      let err = `خطای OpenAI (${res.status})`;
      try {
        const j = JSON.parse(txt);
        if (j.error?.message) err += `: ${j.error.message}`;
      } catch (_) {}
      throw new Error(err);
    }
    return { message: 'اتصال به OpenAI با موفقیت برقرار شد ✓' };
  } else {
    // Gemini
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`,
      {
        headers: {
          'x-goog-api-key': cleanKey,
          'Content-Type': 'application/json'
        }
      }
    );
    if (!res.ok) {
      const txt = await res.text();
      let err = `خطای Gemini (${res.status})`;
      try {
        const j = JSON.parse(txt);
        if (j.error?.message) err += `: ${j.error.message}`;
      } catch (_) {}
      throw new Error(err);
    }
    const data = await res.json();
    const available = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));

    if (available.length === 0) {
      throw new Error('کلید معتبر است اما هیچ مدلی با قابلیت generateContent برای آن فعال نیست.');
    }

    return {
      message: `اتصال موفق به Gemini! مدل‌های در دسترس: ${available.slice(0, 3).join(', ')}`
    };
  }
}

async function getCandidateGeminiModels(cleanKey, preferredModel) {
  // If we already have a cached working model for this key, return it first!
  if (cachedGeminiModel && cachedGeminiKey === cleanKey) {
    return [cachedGeminiModel];
  }

  console.log('[YT-FA-Translator SW] 🔍 Fetching available Gemini models from Google API...');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`,
    {
      headers: {
        'x-goog-api-key': cleanKey,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    let msg = `خطای اعتبارسنجی کلید Gemini (${res.status})`;
    try {
      const errJson = JSON.parse(errBody);
      if (errJson.error?.message) msg += `: ${errJson.error.message}`;
    } catch (_) {
      msg += `: ${errBody.slice(0, 150)}`;
    }
    console.error('[YT-FA-Translator SW] ❌ ListModels error:', msg);
    throw new Error(msg);
  }

  const data = await res.json();
  const models = data.models || [];
  const contentModels = models
    .filter((m) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));

  console.log('[YT-FA-Translator SW] 📋 Supported Gemini models for this key:', contentModels);

  if (contentModels.length === 0) {
    throw new Error('هیچ مدلی با قابلیت تولید محتوا (generateContent) برای این کلید API یافت نشد.');
  }

  const orderedCandidates = [];

  // 1. Add preferred model if supported
  if (preferredModel) {
    const cleanPref = preferredModel.replace('models/', '');
    const match = contentModels.find((m) => m === cleanPref || m.includes(cleanPref));
    if (match && !orderedCandidates.includes(match)) {
      orderedCandidates.push(match);
    }
  }

  // 2. High priority fast models (2025/2026 standard)
  const priorityList = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-002',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-8b',
    'gemini-2.5-flash',
    'gemini-1.5-pro'
  ];

  for (const p of priorityList) {
    const match = contentModels.find((m) => m === p || m.includes(p));
    if (match && !orderedCandidates.includes(match)) {
      orderedCandidates.push(match);
    }
  }

  // 3. Any remaining models
  for (const m of contentModels) {
    if (!orderedCandidates.includes(m)) {
      orderedCandidates.push(m);
    }
  }

  return orderedCandidates;
}

async function callGeminiWithFallback(apiKey, modelName, batchItems, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const cleanKey = (apiKey || '').trim();
  const candidates = await getCandidateGeminiModels(cleanKey, modelName);

  let lastError = null;

  for (const model of candidates) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const translations = await executeGeminiCall(cleanKey, model, batchItems, signal);
      // Cache this working model!
      cachedGeminiModel = model;
      cachedGeminiKey = cleanKey;
      return { translations, usedModel: model };
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') {
        throw err;
      }
      console.warn(`[YT-FA-Translator SW] ⚠️ Model "${model}" failed: ${err.message}. Trying next candidate...`);
      lastError = err;
      if (cachedGeminiModel === model) {
        cachedGeminiModel = null;
      }
    }
  }

  throw lastError || new Error('هیچ‌یک از مدل‌های Gemini قادر به پردازش درخواست نبودند.');
}

async function executeGeminiCall(cleanKey, model, batchItems, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const startTime = Date.now();
  console.log(`[YT-FA-Translator SW] 🚀 [Gemini Calling] Model: ${model} | Items count: ${batchItems.length}`);

  const prompt = `You are a professional subtitle translator from English to Persian (Farsi).
Translate the English text in the following JSON array into natural, fluent, and conversational Persian.
Preserve the exact meaning and tone suitable for YouTube video captions.

CRITICAL RULES:
1. Return ONLY a valid JSON array of objects with schema: [{"id": <number>, "fa": "<persian translation>"}]
2. Do NOT add markdown code blocks (no \`\`\`json), no preambles, and no explanations.
3. Keep the exact same "id" for each item.
4. Translate every single item.

Input items:
${JSON.stringify(batchItems)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': cleanKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3
      }
    }),
    signal: signal
  });

  const duration = Date.now() - startTime;
  console.log(`[YT-FA-Translator SW] 📥 [Gemini Response Status]: ${response.status} (${duration}ms)`);

  if (!response.ok) {
    const errBody = await response.text();
    let msg = `خطای Gemini (${response.status})`;
    try {
      const errJson = JSON.parse(errBody);
      if (errJson.error?.message) msg += `: ${errJson.error.message}`;
    } catch (_) {
      msg += `: ${errBody.slice(0, 150)}`;
    }
    console.error('[YT-FA-Translator SW] ❌ [Gemini Error Body]:', msg);
    throw new Error(msg);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  console.log('[YT-FA-Translator SW] 📋 [Gemini Raw Text Snippet]:', rawText.slice(0, 150));

  const parsed = parseJsonResponse(rawText);
  if (!parsed || parsed.length === 0) {
    throw new Error('پاسخ مدل Gemini ساختار JSON معتبر نداشت.');
  }

  return parsed;
}

async function callOpenAI(apiKey, modelName, batchItems, signal) {
  return callOpenAICompatible('https://api.openai.com/v1', apiKey, modelName, batchItems, signal);
}

async function callOpenAICompatible(baseUrl, apiKey, modelName, batchItems, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const model = modelName || 'gpt-4o-mini';
  const cleanKey = (apiKey || '').trim();
  const url = normalizeChatCompletionsUrl(baseUrl);
  const startTime = Date.now();

  console.log(`[YT-FA-Translator SW] 🚀 [OpenAI-Compatible Request] Sending ${batchItems.length} items to ${url} (model: ${model})`);

  const systemPrompt = `You are an expert English-to-Persian subtitle translator.
Translate each item into natural, fluent Persian for video captions.
Always respond with valid JSON: {"translations": [{"id": <number>, "fa": "<persian translation>"}]}`;

  const headers = {
    'Content-Type': 'application/json'
  };
  if (cleanKey) {
    headers['Authorization'] = `Bearer ${cleanKey}`;
  }

  const baseBody = {
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(batchItems) }
    ],
    temperature: 0.3
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...baseBody,
        response_format: { type: 'json_object' }
      }),
      signal: signal
    });
  } catch (netErr) {
    if (signal?.aborted || netErr.name === 'AbortError') {
      throw new DOMException('Aborted', 'AbortError');
    }
    console.error(`[YT-FA-Translator SW] ❌ Network error connecting to ${url}:`, netErr);
    throw new Error(`خطای ارتباط با سرور (${url}): ${netErr.message}`);
  }

  // Gracefully retry without response_format if custom server rejects it
  if (!response.ok && response.status === 400) {
    try {
      const errClone = await response.clone().text();
      if (
        errClone.includes('response_format') ||
        errClone.includes('json_object') ||
        errClone.includes('schema') ||
        errClone.includes('Additional properties are not allowed')
      ) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        console.warn('[YT-FA-Translator SW] ⚠️ Server does not support response_format: json_object. Retrying without it...');
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(baseBody),
          signal: signal
        });
      }
    } catch (_) {}
  }

  const duration = Date.now() - startTime;
  console.log(`[YT-FA-Translator SW] 📥 [Response Status]: ${response.status} (${duration}ms)`);

  if (!response.ok) {
    const errBody = await response.text();
    let msg = `خطای سرور (${response.status})`;
    try {
      const errJson = JSON.parse(errBody);
      if (errJson.error?.message) msg += `: ${errJson.error.message}`;
      else if (errJson.message) msg += `: ${errJson.message}`;
    } catch (_) {
      msg += `: ${errBody.slice(0, 150)}`;
    }
    console.error('[YT-FA-Translator SW] ❌ [API Error]:', msg);
    throw new Error(msg);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  console.log('[YT-FA-Translator SW] 📋 [Raw Response Snippet]:', content.slice(0, 150));

  let parsed = [];
  try {
    const obj = JSON.parse(content);
    if (Array.isArray(obj.translations)) parsed = obj.translations;
    else if (Array.isArray(obj)) parsed = obj;
  } catch (e) {
    parsed = parseJsonResponse(content);
  }

  if (!parsed || parsed.length === 0) {
    parsed = parseJsonResponse(content);
  }

  if (!parsed || parsed.length === 0) {
    throw new Error('پاسخ دریافتی از مدل شامل ساختار ترجمه معتبر نبود.');
  }

  return parsed;
}

function parseJsonResponse(rawText) {
  try {
    let cleaned = rawText.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.translations && Array.isArray(parsed.translations)) return parsed.translations;
    return [];
  } catch (e) {
    console.error('[YT-FA-Translator SW] Failed to parse JSON response:', rawText, e);
    return [];
  }
}
