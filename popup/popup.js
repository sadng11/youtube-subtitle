// Popup UI Logic

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const videoActionCard = document.getElementById('videoActionCard');
  const videoStatusDot = document.getElementById('videoStatusDot');
  const videoActionTitle = document.getElementById('videoActionTitle');
  const videoActionDesc = document.getElementById('videoActionDesc');
  const startTranslateBtn = document.getElementById('startTranslateBtn');
  const startTranslateBtnText = document.getElementById('startTranslateBtnText');

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
