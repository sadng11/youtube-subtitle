// Popup UI Logic

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const videoActionCard = document.getElementById('videoActionCard');
  const videoStatusDot = document.getElementById('videoStatusDot');
  const videoActionTitle = document.getElementById('videoActionTitle');
  const videoActionDesc = document.getElementById('videoActionDesc');
  const startTranslateBtn = document.getElementById('startTranslateBtn');
  const startTranslateBtnText = document.getElementById('startTranslateBtnText');
  const downloadSrtBtn = document.getElementById('downloadSrtBtn');
  const downloadSrtEnBtn = document.getElementById('downloadSrtEnBtn');
  const uploadSrtBtn = document.getElementById('uploadSrtBtn');
  const srtFileInput = document.getElementById('srtFileInput');

  const enabledToggle = document.getElementById('enabledToggle');
  const autoTranslateToggle = document.getElementById('autoTranslateToggle');
  const bilingualToggle = document.getElementById('bilingualToggle');
  const providerSelect = document.getElementById('providerSelect');
  const geminiSettings = document.getElementById('geminiSettings');
  const openaiSettings = document.getElementById('openaiSettings');
  const customSettings = document.getElementById('customSettings');
  const geminiApiKey = document.getElementById('geminiApiKey');
  const openaiApiKey = document.getElementById('openaiApiKey');
  const customApiKey = document.getElementById('customApiKey');
  const customBaseUrl = document.getElementById('customBaseUrl');
  const customModel = document.getElementById('customModel');
  const geminiModel = document.getElementById('geminiModel');
  const openaiModel = document.getElementById('openaiModel');
  const toggleGeminiKey = document.getElementById('toggleGeminiKey');
  const toggleOpenaiKey = document.getElementById('toggleOpenaiKey');
  const toggleCustomKey = document.getElementById('toggleCustomKey');
  const fontBtns = document.querySelectorAll('.font-btn');
  const saveBtn = document.getElementById('saveBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const toast = document.getElementById('toast');

  let selectedFontSize = 20;
  let activeTabId = null;

  // 1. Load saved configuration
  const config = await chrome.storage.local.get([
    'enabled',
    'autoTranslate',
    'bilingual',
    'provider',
    'geminiApiKey',
    'openaiApiKey',
    'customBaseUrl',
    'customApiKey',
    'customModel',
    'geminiModel',
    'openaiModel',
    'fontSize'
  ]);

  if (config.enabled !== undefined) enabledToggle.checked = config.enabled;
  autoTranslateToggle.checked = config.autoTranslate === true; // Default false
  if (config.bilingual !== undefined) bilingualToggle.checked = config.bilingual;
  if (config.provider) providerSelect.value = config.provider;
  if (config.geminiApiKey) geminiApiKey.value = config.geminiApiKey;
  if (config.openaiApiKey) openaiApiKey.value = config.openaiApiKey;
  if (config.customBaseUrl) customBaseUrl.value = config.customBaseUrl;
  if (config.customApiKey) customApiKey.value = config.customApiKey;
  if (config.customModel) customModel.value = config.customModel;
  if (config.geminiModel) geminiModel.value = config.geminiModel;
  if (config.openaiModel) openaiModel.value = config.openaiModel;
  if (config.fontSize) {
    selectedFontSize = config.fontSize;
    updateFontButtons(selectedFontSize);
  }

  updateProviderVisibility();

  // 2. Provider Select Change
  providerSelect.addEventListener('change', () => {
    updateProviderVisibility();
  });

  function updateProviderVisibility() {
    const p = providerSelect.value;
    geminiSettings.classList.toggle('hidden', p !== 'gemini');
    openaiSettings.classList.toggle('hidden', p !== 'openai');
    customSettings.classList.toggle('hidden', p !== 'custom');
  }

  // 3. Password Visibility Toggles
  setupEyeToggle(toggleGeminiKey, geminiApiKey);
  setupEyeToggle(toggleOpenaiKey, openaiApiKey);
  setupEyeToggle(toggleCustomKey, customApiKey);

  function setupEyeToggle(btn, input) {
    btn.addEventListener('click', () => {
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.textContent = isPassword ? '🔒' : '👁';
    });
  }

  // 4. Font Size Selectors
  fontBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedFontSize = parseInt(btn.dataset.size, 10);
      updateFontButtons(selectedFontSize);
    });
  });

  function updateFontButtons(size) {
    fontBtns.forEach((b) => {
      b.classList.toggle('active', parseInt(b.dataset.size, 10) === size);
    });
  }

  // 5. Quick Auto-save for toggles
  enabledToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ enabled: enabledToggle.checked });
  });

  autoTranslateToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ autoTranslate: autoTranslateToggle.checked });
  });

  bilingualToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ bilingual: bilingualToggle.checked });
  });

  // 6. Save Configuration Button
  saveBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const gKey = geminiApiKey.value.trim();
    const oKey = openaiApiKey.value.trim();
    const cUrl = customBaseUrl.value.trim();
    const cKey = customApiKey.value.trim();
    const cModel = customModel.value.trim();

    if (provider === 'gemini' && !gKey) {
      showToast('لطفاً کلید Gemini API را وارد کنید.', true);
      return;
    }
    if (provider === 'openai' && !oKey) {
      showToast('لطفاً کلید OpenAI API را وارد کنید.', true);
      return;
    }
    if (provider === 'custom') {
      if (!cUrl) {
        showToast('لطفاً آدرس پایه (Base URL) را وارد کنید.', true);
        return;
      }
      if (!cModel) {
        showToast('لطفاً نام مدل (Model) را وارد کنید.', true);
        return;
      }
    }

    await chrome.storage.local.set({
      enabled: enabledToggle.checked,
      autoTranslate: autoTranslateToggle.checked,
      bilingual: bilingualToggle.checked,
      provider: provider,
      geminiApiKey: gKey,
      openaiApiKey: oKey,
      customBaseUrl: cUrl,
      customApiKey: cKey,
      customModel: cModel,
      geminiModel: geminiModel.value,
      openaiModel: openaiModel.value,
      fontSize: selectedFontSize
    });

    showToast('تنظیمات با موفقیت ذخیره شد ✓');
  });

  // 7. Active YouTube Tab Detection & Quick Action
  async function checkActiveYouTubeTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id || !tab.url || !tab.url.includes('youtube.com/watch')) {
        videoActionCard.classList.add('hidden');
        return;
      }

      activeTabId = tab.id;
      videoActionCard.classList.remove('hidden');

      // Request state from content script
      chrome.tabs.sendMessage(activeTabId, { type: 'GET_VIDEO_TRANSLATION_STATE' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          videoActionDesc.textContent = 'در ویدیوی یوتیوب، برای شروع ترجمه روی دکمه زیر کلیک کنید.';
          return;
        }

        updateActionCardUI(res);
      });
    } catch (e) {
      console.warn('Could not query active tab:', e);
    }
  }

  let currentVideoState = null;

  function updateActionCardUI(state) {
    currentVideoState = state;
    if (state.isTranslating) {
      videoStatusDot.className = 'video-status-dot loading';
      videoActionDesc.textContent = 'هوش مصنوعی در حال ترجمه زیرنویس ویدیو است...';
      startTranslateBtn.disabled = false;
      startTranslateBtn.className = 'btn btn-action-translate state-cancel';
      startTranslateBtnText.textContent = '⏹ لغو و توقف ترجمه';
    } else if (state.hasSubtitles && state.isEnabled) {
      videoStatusDot.className = 'video-status-dot active';
      videoActionDesc.textContent = 'زیرنویس فارسی ترجمه شده و روی ویدیو در حال نمایش است.';
      startTranslateBtn.disabled = false;
      startTranslateBtn.className = 'btn btn-action-translate state-active';
      startTranslateBtnText.textContent = '✓ زیرنویس فارسی فعال است (کلیک برای خاموش‌کردن)';
    } else if (state.hasSubtitles && !state.isEnabled) {
      videoStatusDot.className = 'video-status-dot';
      videoActionDesc.textContent = 'زیرنویس فارسی ترجمه شده اما فعلاً پنهان است (زبان اصلی).';
      startTranslateBtn.disabled = false;
      startTranslateBtn.className = 'btn btn-action-translate';
      startTranslateBtnText.textContent = '🌐 نمایش زیرنویس فارسی';
    } else if (state.isCached) {
      videoStatusDot.className = 'video-status-dot active';
      videoActionDesc.textContent = 'ترجمه این ویدیو قبلاً ذخیره شده و بدون مصرف توکن آماده است.';
      startTranslateBtn.disabled = false;
      startTranslateBtn.className = 'btn btn-action-translate state-cached';
      startTranslateBtnText.textContent = '⚡ بارگذاری ترجمه ذخیره‌شده';
    } else {
      videoStatusDot.className = 'video-status-dot';
      videoActionDesc.textContent = 'ویدیو با زبان اصلی پخش می‌شود. برای شروع ترجمه کلیک کنید:';
      startTranslateBtn.disabled = false;
      startTranslateBtn.className = 'btn btn-action-translate';
      startTranslateBtnText.textContent = '✨ شروع ترجمه هوشمند این ویدیو';
    }
  }

  startTranslateBtn.addEventListener('click', () => {
    if (!activeTabId) return;

    if (currentVideoState && currentVideoState.isTranslating) {
      chrome.tabs.sendMessage(activeTabId, { type: 'CANCEL_TRANSLATION_CMD' }, () => {
        setTimeout(checkActiveYouTubeTab, 300);
      });
      return;
    }

    chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_TRANSLATION_CMD' }, () => {
      setTimeout(checkActiveYouTubeTab, 300);
    });
  });

  if (downloadSrtBtn) {
    downloadSrtBtn.addEventListener('click', () => {
      if (!activeTabId) return;
      chrome.tabs.sendMessage(activeTabId, { type: 'DOWNLOAD_SRT_CMD', lang: 'fa' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          showToast('امکان دریافت زیرنویس از صفحه وجود ندارد.', true);
          return;
        }
        if (!res.success) {
          showToast(res.error || 'زیرنویسی در حافظه کش یافت نشد.', true);
          return;
        }
        showToast(`زیرنویس فارسی با موفقیت دانلود شد (${res.count} خط) ✓`);
      });
    });
  }

  if (downloadSrtEnBtn) {
    downloadSrtEnBtn.addEventListener('click', () => {
      if (!activeTabId) return;
      chrome.tabs.sendMessage(activeTabId, { type: 'DOWNLOAD_SRT_CMD', lang: 'en' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          showToast('امکان دریافت زیرنویس از صفحه وجود ندارد.', true);
          return;
        }
        if (!res.success) {
          showToast(res.error || 'زیرنویس انگلیسی یافت نشد.', true);
          return;
        }
        showToast(`زیرنویس انگلیسی با موفقیت دانلود شد (${res.count} خط) ✓`);
      });
    });
  }

  if (uploadSrtBtn) {
    uploadSrtBtn.addEventListener('click', () => {
      let videoId = currentVideoState?.videoId || '';
      let url = chrome.runtime.getURL('popup/uploader.html');
      const params = [];
      if (videoId) params.push(`videoId=${encodeURIComponent(videoId)}`);
      if (activeTabId) params.push(`tabId=${activeTabId}`);
      if (params.length > 0) url += `?${params.join('&')}`;

      chrome.tabs.create({ url });
      window.close();
    });

    if (srtFileInput) {
      srtFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      showToast(`در حال پردازش فایل ${file.name}...`);
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const srtText = ev.target.result;
          const parsedItems = parseSrtToItems(srtText);

          if (!parsedItems || parsedItems.length === 0) {
            showToast('قالب فایل SRT نامعتبر است یا خطی یافت نشد.', true);
            return;
          }

          // Determine videoId
          let videoId = currentVideoState?.videoId;
          if (!videoId && activeTabId) {
            try {
              const tab = await chrome.tabs.get(activeTabId);
              if (tab && tab.url) {
                const url = new URL(tab.url);
                videoId = url.searchParams.get('v');
                if (!videoId && url.pathname.startsWith('/shorts/')) {
                  videoId = url.pathname.split('/shorts/')[1]?.split('/')[0]?.split('?')[0];
                }
              }
            } catch (_) {}
          }

          if (!videoId) {
            showToast('خطا: ویدیوی فعال یوتیوب شناسایی نشد.', true);
            return;
          }

          // Save directly to chrome.storage.local!
          const key = `yt_sub_${videoId}`;
          await chrome.storage.local.set({ [key]: parsedItems });
          console.log(`[Popup] 💾 Saved ${parsedItems.length} lines to storage key: ${key}`);

          showToast(`فایل SRT لود شد (${parsedItems.length} خط) ✓`);

          // Notify content script to display immediately
          if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, {
              type: 'LOAD_SRT_ITEMS_CMD',
              items: parsedItems,
              videoId
            }, () => {
              setTimeout(checkActiveYouTubeTab, 300);
            });
          }
        } catch (err) {
          console.error('[Popup] Upload error:', err);
          showToast(`خطا در پردازش فایل: ${err.message}`, true);
        }
      };
      reader.onerror = () => {
        showToast('خطا در خواندن فایل از دیسک.', true);
      };
      reader.readAsText(file);
      srtFileInput.value = '';
    });
    }
  }

  function parseSrtToItems(srtText) {
    const items = [];
    if (!srtText) return items;

    const cleanText = srtText.replace(/^\uFEFF/, '');
    const normalized = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    function parseTimestamp(timeStr) {
      if (!timeStr) return 0;
      const match = timeStr.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
      if (!match) {
        const m2 = timeStr.match(/(\d{1,2}):(\d{2})/);
        if (m2) return parseInt(m2[1], 10) * 60 + parseInt(m2[2], 10);
        return parseFloat(timeStr) || 0;
      }
      const hours = match[1] ? parseInt(match[1], 10) : 0;
      const minutes = parseInt(match[2], 10);
      const seconds = parseInt(match[3], 10);
      const ms = parseInt(match[4].padEnd(3, '0').slice(0, 3), 10);
      return hours * 3600 + minutes * 60 + seconds + ms / 1000;
    }

    const blocks = normalized.split(/\n\s*\n/);
    let autoId = 1;

    for (const block of blocks) {
      const lines = block.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      let timeLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
          timeLineIdx = i;
          break;
        }
      }
      if (timeLineIdx === -1) continue;

      const timeLine = lines[timeLineIdx];
      const arrowIdx = timeLine.indexOf('-->');
      const start = parseTimestamp(timeLine.slice(0, arrowIdx));
      const end = parseTimestamp(timeLine.slice(arrowIdx + 3));
      const textLines = lines.slice(timeLineIdx + 1).join('\n').trim();

      if (textLines && !isNaN(start) && !isNaN(end)) {
        items.push({
          id: autoId++,
          start,
          end,
          text: textLines,
          fa: textLines
        });
      }
    }

    if (items.length === 0) {
      const regex = /(?:(\d+)\s*\n)?(?:((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3}))\s*\n([\s\S]*?)(?=(?:\n\s*\d+\s*\n(?:\d+:)?\d{1,2}:\d{2}|$))/g;
      let match;
      while ((match = regex.exec(normalized)) !== null) {
        const start = parseTimestamp(match[2]);
        const end = parseTimestamp(match[3]);
        const text = match[4].trim();
        if (text) {
          items.push({
            id: autoId++,
            start,
            end,
            text,
            fa: text
          });
        }
      }
    }

    return items;
  }

  checkActiveYouTubeTab();

  // 8. Test Connection Button
  const testBtn = document.getElementById('testBtn');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const provider = providerSelect.value;
      let key = '';
      let model = '';
      let customBaseUrlVal = '';

      if (provider === 'openai') {
        key = openaiApiKey.value.trim();
        model = openaiModel.value;
        if (!key) {
          showToast('لطفاً ابتدا کلید OpenAI API را وارد کنید.', true);
          return;
        }
      } else if (provider === 'gemini') {
        key = geminiApiKey.value.trim();
        model = geminiModel.value;
        if (!key) {
          showToast('لطفاً ابتدا کلید Gemini API را وارد کنید.', true);
          return;
        }
      } else if (provider === 'custom') {
        customBaseUrlVal = customBaseUrl.value.trim();
        key = customApiKey.value.trim();
        model = customModel.value.trim();
        if (!customBaseUrlVal) {
          showToast('لطفاً آدرس پایه (Base URL) را وارد کنید.', true);
          return;
        }
        if (!model) {
          showToast('لطفاً نام مدل را وارد کنید.', true);
          return;
        }
      }

      showToast('در حال بررسی اتصال به API...');

      try {
        const res = await chrome.runtime.sendMessage({
          type: 'TEST_CONNECTION',
          provider,
          apiKey: key,
          model,
          customBaseUrl: customBaseUrlVal
        });

        if (res && res.success) {
          showToast(res.message || 'اتصال با موفقیت برقرار شد ✓');
        } else {
          showToast(`خطا: ${res?.error || 'ارتباط برقرار نشد'}`, true);
        }
      } catch (err) {
        showToast(`خطا: ${err.message}`, true);
      }
    });
  }

  // 9. Clear Cache Button
  clearCacheBtn.addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(all).filter((k) => k.startsWith('yt_sub_'));
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      showToast(`حافظه کش پاک شد (${keysToRemove.length} ویدیو)`);
    } else {
      showToast('حافظه کش در حال حاضر خالی است.');
    }
  });

  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.className = `toast ${isError ? 'error' : ''}`;
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 3000);
  }
});
