// YouTube Persian Subtitle Translator - Content Script

(function () {
  let currentVideoId = null;
  let activeSubtitles = [];
  let cachedSubtitles = null;
  let latestRawTimedText = null;
  let isEnabled = true;
  let autoTranslate = false;
  let isTranslationRequested = false;
  let isBilingual = true;
  let fontSize = 20;
  let overlayEl = null;
  let statusBadgeEl = null;
  let subBoxEl = null;
  let subFaEl = null;
  let subEnEl = null;
  let videoEl = null;
  let toggleBtnEl = null;
  let uploadBtnEl = null;
  let isTranslating = false;
  let hasStartedTranslation = false;
  let activeTranslationRunId = 0;
  let captionObserver = null;
  let liveDebounceTimer = null;
  let lastObservedText = '';
  let preparingTimeout = null;
  const realtimeTranslations = new Map();

  function cancelTranslation(reason = 'user_cancelled') {
    console.log(`[YT-FA-Translator] 🛑 Cancelling translation. Reason: ${reason}`);
    activeTranslationRunId++;
    isTranslating = false;
    isTranslationRequested = false;
    hasStartedTranslation = false;
    clearTimeout(preparingTimeout);
    clearTimeout(liveDebounceTimer);

    const vid = getVideoId();
    try {
      chrome.runtime.sendMessage({
        type: 'CANCEL_TRANSLATION',
        videoId: vid,
        reason
      });
    } catch (_) {}
  }

  // 1. Inject page-script.js to read captions and intercept player traffic
  function injectPageScript() {
    try {
      if (document.getElementById('yt-fa-page-script')) return;
      const script = document.createElement('script');
      script.id = 'yt-fa-page-script';
      script.src = chrome.runtime.getURL('content/page-script.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[YT-FA-Translator] Could not inject page-script:', e);
    }
  }

  // 2. Listen for messages from page context
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'YT_FA_INTERCEPTED_TIMEDTEXT') {
      const rawText = event.data.rawText;
      if (rawText && rawText.trim().length > 0) {
        latestRawTimedText = rawText;
        if (isTranslationRequested || autoTranslate) {
          handleInterceptedTimedText(rawText);
        }
      }
    }

    if (event.data.type === 'YT_FA_TIMEDTEXT_BASEURL') {
      const url = event.data.url;
      if (url && (isTranslationRequested || autoTranslate) && !hasStartedTranslation && activeSubtitles.length === 0) {
        console.log('[YT-FA-Translator] Received timedtext baseUrl from page-script, fetching via background service worker...');
        chrome.runtime.sendMessage({ type: 'FETCH_TIMEDTEXT', url }).then((res) => {
          if (res && res.success && res.rawText && res.rawText.trim().length > 0) {
            latestRawTimedText = res.rawText;
            handleInterceptedTimedText(res.rawText);
          }
        }).catch((err) => {
          console.warn('[YT-FA-Translator] Background timedtext fetch error:', err);
        });
      }
    }

    if (event.data.type === 'YT_FA_PAGE_SCRIPT_READY') {
      console.log('[YT-FA-Translator] Page script confirmed ready.');
      if (autoTranslate) {
        window.postMessage({ type: 'YT_FA_START_TRANSLATION' }, '*');
      }
    }
  });

  // 3. Listen for commands from Popup or Background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_VIDEO_TRANSLATION_STATE') {
      sendResponse({
        videoId: getVideoId(),
        isTranslating,
        hasSubtitles: activeSubtitles.length > 0,
        isCached: !!(cachedSubtitles && cachedSubtitles.length > 0),
        isEnabled,
        autoTranslate
      });
      return true;
    }
    if (message.type === 'TRIGGER_TRANSLATION_CMD') {
      onTranslateBtnClick();
      sendResponse({ success: true });
      return true;
    }
    if (message.type === 'CANCEL_TRANSLATION_CMD') {
      cancelTranslation('popup_cmd');
      setStatus('ترجمه متوقف شد', false);
      setTimeout(() => setStatus(null), 2500);
      updateTranslateButtonUI('idle');
      applyStyles();
      sendResponse({ success: true, cancelled: true });
      return true;
    }
    if (message.type === 'DOWNLOAD_SRT_CMD') {
      handleDownloadSrt(message.lang || 'fa', sendResponse);
      return true;
    }
    if (message.type === 'UPLOAD_SRT_CMD') {
      handleUploadSrt(message.srtText, sendResponse);
      return true;
    }
    if (message.type === 'LOAD_SRT_ITEMS_CMD') {
      applyCustomSrtItems(message.items, message.videoId || getVideoId());
      sendResponse({ success: true, count: message.items?.length || 0 });
      return true;
    }
    if (message.type === 'TRIGGER_PAGE_FILE_INPUT') {
      showDropzoneOverlay();
      sendResponse({ success: true });
      return true;
    }
  });

  // 4. Load user settings
  async function loadSettings() {
    try {
      const settings = await chrome.storage.local.get(['enabled', 'bilingual', 'fontSize', 'autoTranslate']);
      isEnabled = settings.enabled !== false;
      isBilingual = settings.bilingual !== false;
      fontSize = settings.fontSize || 20;
      autoTranslate = settings.autoTranslate === true;
      applyStyles();
    } catch (e) {
      console.warn('[YT-FA-Translator] Error loading settings:', e);
    }
  }

  function applyStyles() {
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    const shouldShowPersian = isEnabled && (isTranslationRequested || isTranslating || activeSubtitles.length > 0);

    if (player) {
      // ONLY hide YouTube's default CC if Persian subtitles are active and visible
      player.classList.toggle('yt-fa-hide-default-cc', shouldShowPersian);
    }

    if (overlayEl) {
      overlayEl.style.setProperty('--yt-fa-font-size', `${fontSize}px`);
      overlayEl.style.display = shouldShowPersian ? 'flex' : 'none';
    }
    if (subEnEl) {
      subEnEl.style.display = isBilingual ? 'block' : 'none';
    }

    updateTranslateButtonUI();
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) isEnabled = changes.enabled.newValue;
    if (changes.bilingual) isBilingual = changes.bilingual.newValue;
    if (changes.fontSize) fontSize = changes.fontSize.newValue;
    if (changes.autoTranslate) autoTranslate = changes.autoTranslate.newValue;
    applyStyles();
  });

  // 5. Setup Custom Subtitle Overlay inside YouTube Player
  function ensureOverlay() {
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (!player) return false;

    videoEl = player.querySelector('video');

    if (!overlayEl || !player.contains(overlayEl)) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'yt-fa-sub-overlay';
      overlayEl.style.display = (isEnabled && (isTranslationRequested || isTranslating || activeSubtitles.length > 0)) ? 'flex' : 'none';
      overlayEl.style.setProperty('--yt-fa-font-size', `${fontSize}px`);

      // Subtitle Box
      subBoxEl = document.createElement('div');
      subBoxEl.className = 'yt-fa-sub-box';
      subBoxEl.style.display = 'none';

      subEnEl = document.createElement('div');
      subEnEl.className = 'yt-fa-sub-en';
      subEnEl.style.display = isBilingual ? 'block' : 'none';

      subFaEl = document.createElement('div');
      subFaEl.className = 'yt-fa-sub-fa';

      subBoxEl.appendChild(subEnEl);
      subBoxEl.appendChild(subFaEl);
      overlayEl.appendChild(subBoxEl);

      player.appendChild(overlayEl);
    }

    if (videoEl && !videoEl._hasYtFaListener) {
      videoEl.addEventListener('timeupdate', onTimeUpdate);
      videoEl._hasYtFaListener = true;
    }

    injectControlsElements();
    setupLiveCaptionObserver(player);
    setupDragAndDrop(player);
    return true;
  }

  let lastStatusState = null;

  // 6. Update Translate Button Appearance based on State
  function updateTranslateButtonUI(state) {
    if (!toggleBtnEl) return;

    if (!state) {
      if (isTranslating) {
        state = 'loading';
      } else if (activeSubtitles.length > 0) {
        state = isEnabled ? 'active' : 'inactive';
      } else if (cachedSubtitles && cachedSubtitles.length > 0 && cachedSubtitles.every((s) => s.fa && s.fa.trim().length > 0)) {
        state = 'cached';
      } else {
        state = 'idle';
      }
    }

    const iconEl = toggleBtnEl.querySelector('.yt-fa-btn-icon');
    const labelEl = toggleBtnEl.querySelector('.yt-fa-btn-label');

    toggleBtnEl.className = `ytp-button yt-fa-control-btn state-${state}`;

    const sparkleIcon = `
      <svg viewBox="0 0 24 24">
        <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </svg>
    `;

    if (state === 'loading') {
      if (iconEl) {
        iconEl.style.display = '';
        iconEl.innerHTML = `<div class="yt-fa-spinner" style="width:13px;height:13px;border-width:2px;margin:0;"></div>`;
      }
      if (labelEl) labelEl.textContent = 'در حال ترجمه... (لغو)';
      toggleBtnEl.title = 'ترجمه هوشمند زیرنویس در حال پردازش است. برای انصراف و توقف کلیک کنید.';
    } else if (state === 'active') {
      if (iconEl) {
        iconEl.style.display = '';
        iconEl.innerHTML = sparkleIcon;
      }
      if (labelEl) labelEl.textContent = '✓ زیرنویس فارسی';
      toggleBtnEl.title = 'زیرنویس فارسی فعال است. برای مشاهده زبان اصلی کلیک کنید.';
    } else if (state === 'inactive') {
      if (iconEl) {
        iconEl.style.display = '';
        iconEl.innerHTML = sparkleIcon;
      }
      if (labelEl) labelEl.textContent = '🌐 فارسی (خاموش)';
      toggleBtnEl.title = 'زیرنویس فارسی غیرفعال است. برای نمایش مجدد کلیک کنید.';
    } else if (state === 'cached') {
      if (iconEl) {
        iconEl.style.display = '';
        iconEl.innerHTML = sparkleIcon;
      }
      if (labelEl) labelEl.textContent = '⚡ نمایش ترجمه';
      toggleBtnEl.title = 'ترجمه فارسی این ویدیو در حافظه موجود است (بدون هزینه). برای نمایش کلیک کنید.';
    } else {
      if (iconEl) {
        iconEl.style.display = 'none';
        iconEl.innerHTML = '';
      }
      if (labelEl) labelEl.textContent = '✨';
      toggleBtnEl.title = 'شروع ترجمه هوشمند این ویدیو با هوش مصنوعی (کلیک کنید)';
    }
  }

  // 7. Button Click Handler
  async function onTranslateBtnClick() {
    // If currently translating, clicking cancels/stops the translation!
    if (isTranslating) {
      console.log('[YT-FA-Translator] 🛑 User cancelled translation via button click.');
      cancelTranslation('user_clicked_button');
      setStatus('ترجمه متوقف شد', false);
      setTimeout(() => setStatus(null), 2500);
      updateTranslateButtonUI('idle');
      applyStyles();
      return;
    }

    // A. Subtitles already active in memory -> Toggle Persian overlay on/off
    if (activeSubtitles.length > 0) {
      const isFully = activeSubtitles.every((s) => s.fa && s.fa.trim().length > 0);
      if (isFully) {
        isEnabled = !isEnabled;
        await chrome.storage.local.set({ enabled: isEnabled });
        applyStyles();
        updateTranslateButtonUI(isEnabled ? 'active' : 'inactive');
        return;
      }
    }

    // B. Subtitles cached in storage -> Load instantly without LLM request if fully cached!
    if (cachedSubtitles && cachedSubtitles.length > 0) {
      const isFully = cachedSubtitles.every((s) => s.fa && s.fa.trim().length > 0);
      if (isFully) {
        activeSubtitles = cachedSubtitles;
        isEnabled = true;
        isTranslationRequested = true;
        await chrome.storage.local.set({ enabled: true });
        applyStyles();
        updateTranslateButtonUI('active');
        setStatus('زیرنویس فارسی از حافظه بارگذاری شد ✓', false);
        setTimeout(() => setStatus(null), 2500);
        return;
      }
    }

    // C. Not translated yet or partially cached -> Start/Resume translation
    startTranslationProcess();
  }

  // 8. Trigger Translation
  async function startTranslationProcess() {
    const videoId = getVideoId();
    if (!videoId) return;

    isTranslationRequested = true;
    isEnabled = true;
    applyStyles();
    updateTranslateButtonUI('loading');
    setStatus('در حال آماده‌سازی و دریافت زیرنویس...', true);

    // Check cache first
    const cacheRes = await chrome.runtime.sendMessage({ type: 'CHECK_CACHE', videoId });
    if (cacheRes && cacheRes.cached && Array.isArray(cacheRes.items) && cacheRes.items.length > 0) {
      // Clean up any items where text was wrongly set to Persian
      cacheRes.items.forEach((it) => {
        if (!it.fa && hasPersianText(it.text)) {
          it.fa = it.text;
        }
        if (it.text === it.fa || hasPersianText(it.text)) {
          it.text = '';
        }
      });

      // Try enriching with English if available
      if (latestRawTimedText) {
        const enItems = parseSubtitleRawData(latestRawTimedText);
        enrichItemsWithEnglish(cacheRes.items, enItems);
      }

      const isFully = cacheRes.items.every((s) => s.fa && s.fa.trim().length > 0);
      if (isFully) {
        console.log('[YT-FA-Translator] ⚡ Loaded full translation from local cache:', cacheRes.items.length, 'lines.');
        activeSubtitles = cacheRes.items;
        cachedSubtitles = cacheRes.items;
        setStatus(null);
        applyStyles();
        updateTranslateButtonUI('active');
        onTimeUpdate();

        // If English is missing, request captions so handleInterceptedTimedText can enrich them
        const needsEn = activeSubtitles.some((s) => !s.text);
        if (needsEn && !latestRawTimedText) {
          window.postMessage({ type: 'YT_FA_START_TRANSLATION' }, '*');
        }
        return;
      } else {
        const translatedCount = cacheRes.items.filter((s) => s.fa && s.fa.trim()).length;
        console.log(`[YT-FA-Translator] ⚡ Found partial cache: ${translatedCount}/${cacheRes.items.length} lines. Resuming translation...`);
        cachedSubtitles = cacheRes.items;
        activeSubtitles = cacheRes.items;
        applyStyles();
        onTimeUpdate();
      }
    }

    // If we already intercepted the timedtext
    if (latestRawTimedText) {
      handleInterceptedTimedText(latestRawTimedText);
      return;
    }

    // Force player to load captions
    window.postMessage({ type: 'YT_FA_START_TRANSLATION' }, '*');

    clearTimeout(preparingTimeout);
    preparingTimeout = setTimeout(() => {
      if (!isTranslating && (!activeSubtitles || activeSubtitles.length === 0 || !activeSubtitles.some((s) => s.fa))) {
        console.log('[YT-FA-Translator] Timedtext not received. Ready for live capture if CC enabled.');
        setStatus('زیرنویس پیش‌فرض یافت نشد. لطفاً CC یوتیوب را روشن کنید.', false, true);
        updateTranslateButtonUI('idle');
      }
    }, 6000);
  }

  // 9. Inject Quick Translate Button and Status Badge into YouTube Control Bar
  function injectControlsElements() {
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    const rightControls = player?.querySelector('.ytp-right-controls') || document.querySelector('.ytp-right-controls');
    if (!rightControls) return;

    // 1. Translate / Toggle Button
    if (!toggleBtnEl || !rightControls.contains(toggleBtnEl)) {
      if (!toggleBtnEl) {
        toggleBtnEl = document.createElement('button');
        toggleBtnEl.id = 'yt-fa-toggle-btn';
        toggleBtnEl.setAttribute('type', 'button');
        toggleBtnEl.setAttribute('aria-label', 'ترجمه هوشمند زیرنویس');
        toggleBtnEl.innerHTML = `
          <span class="yt-fa-btn-icon"></span>
          <span class="yt-fa-btn-label">✨</span>
        `;

        toggleBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          onTranslateBtnClick();
        });
      }
      rightControls.insertBefore(toggleBtnEl, rightControls.firstChild);
      updateTranslateButtonUI();
    }

    // 2. Status Badge placed directly before the toggle button
    if (!statusBadgeEl || !rightControls.contains(statusBadgeEl)) {
      if (!statusBadgeEl) {
        statusBadgeEl = document.createElement('div');
        statusBadgeEl.id = 'yt-fa-status-badge';
        statusBadgeEl.className = 'yt-fa-status-badge';
        statusBadgeEl.style.display = 'none';
      }
      rightControls.insertBefore(statusBadgeEl, toggleBtnEl);
    }

    // 3. Quick Upload Button right on YouTube player controls
    if (!uploadBtnEl || !rightControls.contains(uploadBtnEl)) {
      if (!uploadBtnEl) {
        uploadBtnEl = document.createElement('button');
        uploadBtnEl.id = 'yt-fa-upload-btn';
        uploadBtnEl.setAttribute('type', 'button');
        uploadBtnEl.className = 'ytp-button yt-fa-control-btn';
        uploadBtnEl.setAttribute('aria-label', 'آپلود زیرنویس SRT');
        uploadBtnEl.title = 'آپلود مستقیم فایل زیرنویس SRT روی این ویدیو';
        uploadBtnEl.innerHTML = `<span style="font-size: 14px; display: inline-flex; align-items: center; justify-content: center;">📤</span>`;

        uploadBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          triggerPageFileInput();
        });
      }
      rightControls.insertBefore(uploadBtnEl, toggleBtnEl.nextSibling);
    }

    if (lastStatusState) {
      applyStatusUI(lastStatusState.text, lastStatusState.showSpinner, lastStatusState.allowRetry);
    }
  }

  function applyStatusUI(text, showSpinner = true, allowRetry = false) {
    if (!statusBadgeEl) return;
    if (!text) {
      statusBadgeEl.style.display = 'none';
      return;
    }
    let html = '';
    if (showSpinner) {
      html = `<div class="yt-fa-spinner"></div><span class="yt-fa-status-text">${text}</span>`;
    } else if (allowRetry) {
      html = `<span class="yt-fa-status-text">${text}</span> <button class="yt-fa-retry-btn">تلاش مجدد</button>`;
    } else {
      html = `<span class="yt-fa-status-text">${text}</span>`;
    }
    statusBadgeEl.innerHTML = html;
    statusBadgeEl.title = text;
    statusBadgeEl.style.display = 'inline-flex';

    if (allowRetry) {
      const retryBtn = statusBadgeEl.querySelector('.yt-fa-retry-btn');
      if (retryBtn) {
        retryBtn.onclick = (e) => {
          e.stopPropagation();
          hasStartedTranslation = false;
          isTranslating = false;
          startTranslationProcess();
        };
      }
    }
  }

  function setStatus(text, showSpinner = true, allowRetry = false) {
    if (!text) {
      lastStatusState = null;
      if (statusBadgeEl) statusBadgeEl.style.display = 'none';
      return;
    }
    lastStatusState = { text, showSpinner, allowRetry };
    if (!statusBadgeEl || !document.contains(statusBadgeEl)) {
      injectControlsElements();
    }
    applyStatusUI(text, showSpinner, allowRetry);
  }

  // 6. Handle Video Subtitles on Time Update (Synced batch mode)
  function onTimeUpdate() {
    if (!isEnabled || !videoEl || activeSubtitles.length === 0) {
      return;
    }

    const currTime = videoEl.currentTime;
    const currentItem = activeSubtitles.find(
      (item) => currTime >= item.start && currTime <= item.end
    );

    if (currentItem && (currentItem.fa || currentItem.text)) {
      // 1. Determine Persian text
      let faText = currentItem.fa || '';
      if (!faText && hasPersianText(currentItem.text)) {
        faText = currentItem.text;
      }

      if (faText) {
        subFaEl.textContent = faText;
        subFaEl.style.opacity = '1';
      } else if (isTranslating) {
        subFaEl.textContent = '... در حال ترجمه';
        subFaEl.style.opacity = '0.7';
      } else {
        subFaEl.textContent = '';
      }

      // 2. Determine English text (MUST NOT be Persian or duplicate)
      let enText = '';
      if (currentItem.text && currentItem.text !== faText && !hasPersianText(currentItem.text)) {
        enText = currentItem.text;
      }

      // If bilingual mode is active and we have real English text, display English line
      if (isBilingual && enText) {
        subEnEl.textContent = enText;
        subEnEl.style.display = 'block';
      } else {
        subEnEl.textContent = '';
        subEnEl.style.display = 'none';
      }

      subBoxEl.style.display = 'inline-flex';
    } else {
      subBoxEl.style.display = 'none';
    }
  }

  function cleanCaptionText(raw) {
    if (!raw) return '';
    return raw
      .replace(/\bEnglish\s*(?:\(auto-generated\))?/gi, '')
      .replace(/\bClick\s+for\s+settings\b/gi, '')
      .replace(/\bauto-generated\b/gi, '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 7. Live DOM Caption Observer (Fallback when batch not yet ready)
  function setupLiveCaptionObserver(player) {
    if (captionObserver) return;

    captionObserver = new MutationObserver(() => {
      if (!isEnabled || !isTranslationRequested || activeSubtitles.length > 0) return;

      const segments = player.querySelectorAll('.ytp-caption-segment');
      if (!segments || segments.length === 0) {
        if (activeSubtitles.length === 0 && subBoxEl) {
          subBoxEl.style.display = 'none';
        }
        return;
      }

      const rawText = Array.from(segments).map((s) => s.textContent).join(' ');
      const enText = cleanCaptionText(rawText);

      if (!enText || enText === lastObservedText) return;
      lastObservedText = enText;

      // Dismiss any stuck preparation loading badge immediately!
      clearTimeout(preparingTimeout);
      setStatus(null);

      // Show English text immediately
      subEnEl.textContent = enText;
      subBoxEl.style.display = 'inline-flex';

      if (realtimeTranslations.has(enText)) {
        subFaEl.textContent = realtimeTranslations.get(enText);
        return;
      }

      // Show loading indicator in Persian box while translating
      if (!subFaEl.textContent || subFaEl.textContent === '') {
        subFaEl.textContent = '...';
      }

      clearTimeout(liveDebounceTimer);
      liveDebounceTimer = setTimeout(async () => {
        if (activeSubtitles.length > 0) return;
        const textToSend = enText;

        console.log(
          `%c[YT-FA-Translator] 🚀 [LLM Request Sent] Live caption: "${textToSend}"`,
          'color: #2563eb; font-weight: bold;'
        );

        try {
          const res = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_SINGLE',
            text: textToSend
          });

          if (res && res.success && res.fa) {
            console.log(
              `%c[YT-FA-Translator] 📥 [LLM Response Received] Provider: ${res.provider || 'AI'} (${res.model || ''}):\n  "${textToSend}" => "${res.fa}"`,
              'color: #059669; font-weight: bold;'
            );
            realtimeTranslations.set(textToSend, res.fa);

            // Display in Persian line if current caption relates to what we translated
            const currentEn = cleanCaptionText(subEnEl.textContent);
            if (currentEn.includes(textToSend) || textToSend.includes(currentEn) || subFaEl.textContent === '...' || !subFaEl.textContent) {
              subFaEl.textContent = res.fa;
            }
          } else {
            console.error(
              `%c[YT-FA-Translator] ❌ [LLM Response Error]`,
              'color: #dc2626; font-weight: bold;',
              res?.error
            );
            if (res?.error && (res.error.includes('API') || res.error.includes('کلید'))) {
              setStatus(res.error, false, true);
            }
          }
        } catch (err) {
          console.error(
            `%c[YT-FA-Translator] ❌ [LLM Request Failed Exception]`,
            'color: #dc2626; font-weight: bold;',
            err
          );
        }
      }, 300);
    });

    captionObserver.observe(player, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  async function handleInterceptedTimedText(rawText) {
    const videoId = getVideoId();
    if (!videoId) return;

    const parsedItems = parseSubtitleRawData(rawText);
    if (!parsedItems || parsedItems.length === 0) {
      return;
    }

    // Check Cache first
    const cacheRes = await chrome.runtime.sendMessage({ type: 'CHECK_CACHE', videoId });
    const cachedItems = (cacheRes && cacheRes.cached && Array.isArray(cacheRes.items)) ? cacheRes.items : (cachedSubtitles || []);

    // Clean up Persian from English text field in cache
    cachedItems.forEach((it) => {
      if (!it.fa && hasPersianText(it.text)) {
        it.fa = it.text;
      }
      if (it.text === it.fa || hasPersianText(it.text)) {
        it.text = '';
      }
    });

    // Enrich cached items with the newly intercepted English subtitles!
    if (cachedItems.length > 0) {
      const enriched = enrichItemsWithEnglish(cachedItems, parsedItems);
      if (enriched) {
        chrome.storage.local.set({ [`yt_sub_${videoId}`]: cachedItems }).catch(() => {});
      }
    }

    const isFullyCached = cachedItems.length > 0 && cachedItems.every((s) => s.fa && s.fa.trim().length > 0);

    if (isFullyCached) {
      console.log('[YT-FA-Translator] ⚡ Loaded full translation from local cache with English subtitles:', cachedItems.length, 'lines.');
      activeSubtitles = cachedItems;
      cachedSubtitles = cachedItems;
      clearTimeout(preparingTimeout);
      setStatus(null);
      applyStyles();
      updateTranslateButtonUI('active');
      onTimeUpdate();
      return;
    }

    hasStartedTranslation = true;
    clearTimeout(preparingTimeout);
    activeTranslationRunId++;
    const currentRunId = activeTranslationRunId;

    // Populate translationMap with already-cached lines
    const translationMap = new Map();
    cachedItems.forEach((it) => {
      if (it.fa && it.fa.trim()) {
        translationMap.set(it.id, it.fa);
      }
    });

    // Immediately populate activeSubtitles with English text & timings (and any previously translated Persian lines!)
    activeSubtitles = parsedItems.map((item) => ({
      ...item,
      fa: translationMap.get(item.id) || ''
    }));
    isTranslating = true;
    isTranslationRequested = true;
    applyStyles();
    onTimeUpdate();
    updateTranslateButtonUI('loading');

    console.log(
      `%c[YT-FA-Translator] 🎬 Intercepted full timedtext: ${parsedItems.length} lines (${translationMap.size} already translated). Starting prioritized batch translation...`,
      'color: #2563eb; font-weight: bold;'
    );

    const CHUNK_SIZE = 25;
    const allChunks = [];
    for (let i = 0; i < parsedItems.length; i += CHUNK_SIZE) {
      allChunks.push({
        index: allChunks.length,
        items: parsedItems.slice(i, i + CHUNK_SIZE)
      });
    }

    // Only process chunks that still have untranslated lines
    const pendingChunks = allChunks.filter((c) =>
      c.items.some((item) => !translationMap.get(item.id))
    );

    if (pendingChunks.length === 0) {
      console.log('[YT-FA-Translator] ⚡ All chunks already translated!');
      setStatus('ترجمه زیرنویس کامل شد ✓', false);
      setTimeout(() => setStatus(null), 3000);
      cachedSubtitles = activeSubtitles;
      chrome.runtime.sendMessage({
        type: 'SAVE_FULL_CACHE',
        videoId: videoId,
        items: activeSubtitles
      }).catch(() => {});
      updateTranslateButtonUI('active');
      isTranslating = false;
      return;
    }

    const totalChunks = allChunks.length;
    let completedChunks = totalChunks - pendingChunks.length;

    // Priority: Find which pending chunk corresponds to user's current playback position
    const currTime = videoEl ? videoEl.currentTime : 0;
    let currentChunkIdx = pendingChunks.findIndex((c) =>
      c.items.some((item) => currTime >= item.start && currTime <= item.end)
    );
    if (currentChunkIdx === -1) {
      currentChunkIdx = pendingChunks.findIndex((c) =>
        c.items.length > 0 && c.items[c.items.length - 1].end >= currTime
      );
    }
    if (currentChunkIdx === -1) currentChunkIdx = 0;

    // Put current and upcoming scenes FIRST, then previous scenes
    const prioritizedChunks = [];
    for (let i = currentChunkIdx; i < pendingChunks.length; i++) {
      prioritizedChunks.push(pendingChunks[i]);
    }
    for (let i = 0; i < currentChunkIdx; i++) {
      prioritizedChunks.push(pendingChunks[i]);
    }

    for (const chunkObj of prioritizedChunks) {
      if (!isTranslating || !isTranslationRequested || videoId !== getVideoId() || currentRunId !== activeTranslationRunId) {
        console.log('[YT-FA-Translator] 🛑 Translation loop cancelled before chunk', chunkObj.index);
        break;
      }

      completedChunks++;
      setStatus(`در حال ترجمه هوشمند: دسته ${completedChunks} از ${totalChunks}...`, true);

      // Only send items that are not yet translated
      const itemsToSend = chunkObj.items.filter((item) => !translationMap.get(item.id));
      if (itemsToSend.length === 0) continue;

      const MAX_CHUNK_RETRIES = 3;
      let chunkSuccess = false;

      for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        if (!isTranslating || !isTranslationRequested || videoId !== getVideoId() || currentRunId !== activeTranslationRunId) {
          console.log('[YT-FA-Translator] 🛑 Translation loop cancelled before chunk', chunkObj.index);
          break;
        }

        try {
          const res = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_CHUNK',
            videoId: videoId,
            chunkItems: itemsToSend
          });

          if (!isTranslating || !isTranslationRequested || videoId !== getVideoId() || currentRunId !== activeTranslationRunId || res?.cancelled) {
            console.log('[YT-FA-Translator] 🛑 Translation cancelled or tab/video changed. Discarding chunk', chunkObj.index);
            break;
          }

          if (res && res.success && Array.isArray(res.translations)) {
            res.translations.forEach((t) => {
              if (t && t.id !== undefined && t.fa) {
                translationMap.set(t.id, t.fa);
              }
            });

            // Immediately update activeSubtitles with translated lines
            activeSubtitles = parsedItems.map((item) => ({
              ...item,
              fa: translationMap.get(item.id) || ''
            }));

            // Live update the subtitle overlay on screen!
            applyStyles();
            onTimeUpdate();

            // PROGRESSIVE CACHE: Save to storage right after each chunk completes!
            chrome.runtime.sendMessage({
              type: 'SAVE_FULL_CACHE',
              videoId: videoId,
              items: activeSubtitles
            }).catch(() => {});

            chunkSuccess = true;
            break;
          } else {
            if (res?.cancelled) {
              console.log('[YT-FA-Translator] 🛑 Translation chunk was cancelled by backend.');
              break;
            }

            const errorText = res?.error || 'خطای اتصال به سرور هوش مصنوعی';
            console.warn(
              `%c[YT-FA-Translator] ⚠️ [LLM Batch Attempt ${attempt}/${MAX_CHUNK_RETRIES} Failed]`,
              'color: #f59e0b; font-weight: bold;',
              errorText
            );

            // If API key is missing or unauthorized, fail immediately without waiting
            const isAuthError = errorText.includes('کلید') || errorText.includes('401') || errorText.includes('403') || errorText.includes('API key');
            if (isAuthError) {
              console.error(`%c[YT-FA-Translator] ❌ [Auth Error]`, 'color: #dc2626; font-weight: bold;', errorText);
              setStatus(`خطا: ${errorText}`, false, true);
              isTranslating = false;
              updateTranslateButtonUI('idle');
              return;
            }

            if (attempt < MAX_CHUNK_RETRIES) {
              const waitSeconds = attempt * 3;
              setStatus(`خطای موقت سرور (${errorText.slice(0, 35)}...). تلاش مجدد دسته ${completedChunks} تا ${waitSeconds} ثانیه دیگر (${attempt + 1}/${MAX_CHUNK_RETRIES})...`, true);
              await new Promise((r) => setTimeout(r, waitSeconds * 1000));
            } else {
              console.error(
                `%c[YT-FA-Translator] ❌ [LLM Batch Error - Chunk ${chunkObj.index} Failed]`,
                'color: #dc2626; font-weight: bold;',
                errorText
              );
              setStatus(`خطا در دسته ${completedChunks} (${errorText.slice(0, 30)}...). ادامه ترجمه سایر بخش‌ها...`, true);
              await new Promise((r) => setTimeout(r, 1500));
              break;
            }
          }
        } catch (err) {
          if (!isTranslating || !isTranslationRequested || videoId !== getVideoId() || currentRunId !== activeTranslationRunId) {
            break;
          }
          console.warn(
            `%c[YT-FA-Translator] ⚠️ [LLM Batch Request Exception on Attempt ${attempt}/${MAX_CHUNK_RETRIES}]`,
            'color: #f59e0b; font-weight: bold;',
            err
          );
          if (attempt < MAX_CHUNK_RETRIES) {
            const waitSeconds = attempt * 3;
            setStatus(`خطای موقت ارتباط. تلاش مجدد دسته ${completedChunks} تا ${waitSeconds} ثانیه دیگر...`, true);
            await new Promise((r) => setTimeout(r, waitSeconds * 1000));
          } else {
            console.error(
              `%c[YT-FA-Translator] ❌ [LLM Batch Exception]`,
              'color: #dc2626; font-weight: bold;',
              err
            );
            setStatus(`خطای ارتباط در دسته ${completedChunks}. ادامه سایر بخش‌ها...`, true);
            await new Promise((r) => setTimeout(r, 1500));
            break;
          }
        }
      }

      if (!isTranslating || !isTranslationRequested || videoId !== getVideoId() || currentRunId !== activeTranslationRunId) {
        break;
      }
    }

    // Finished all chunks!
    if (videoId === getVideoId() && isTranslating && isTranslationRequested && currentRunId === activeTranslationRunId) {
      setStatus('ترجمه زیرنویس کامل شد ✓', false);
      setTimeout(() => setStatus(null), 3000);
      chrome.runtime.sendMessage({
        type: 'SAVE_FULL_CACHE',
        videoId: videoId,
        items: activeSubtitles
      }).catch(() => {});
      cachedSubtitles = activeSubtitles;
      updateTranslateButtonUI('active');
      applyStyles();
      onTimeUpdate();
    }
    if (currentRunId === activeTranslationRunId) {
      isTranslating = false;
    }
  }

  // 9. Parse Subtitle Formats (JSON3, XML, WebVTT)
  function decodeEntities(str) {
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value;
  }

  function parseSubtitleRawData(rawText) {
    const items = [];
    const trimmed = rawText.trim();
    if (!trimmed) return items;

    // Format 1: JSON3
    if (trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed);
        const events = data.events || [];
        let id = 1;
        for (const ev of events) {
          if (!ev.segs) continue;
          const text = decodeEntities(
            ev.segs
              .map((s) => s.utf8)
              .join('')
              .replace(/[\r\n]+/g, ' ')
              .trim()
          );
          if (!text) continue;

          const start = (ev.tStartMs || 0) / 1000;
          const dur = (ev.dDurationMs || 0) / 1000;
          items.push({
            id: id++,
            start: start,
            end: start + dur,
            text: text
          });
        }
        if (items.length > 0) return items;
      } catch (e) {
        console.warn('[YT-FA-Translator] JSON3 parse error:', e);
      }
    }

    // Format 2: Regex for <text start="X" dur="Y">
    const textRegex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/gi;
    let match;
    let id = 1;
    while ((match = textRegex.exec(trimmed)) !== null) {
      const start = parseFloat(match[1]);
      const dur = parseFloat(match[2]);
      const text = decodeEntities(match[3].replace(/<[^>]+>/g, '').trim());
      if (text) {
        items.push({ id: id++, start, end: start + dur, text });
      }
    }
    if (items.length > 0) return items;

    // Format 3: Regex for <p t="X" d="Y">
    const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/gi;
    while ((match = pRegex.exec(trimmed)) !== null) {
      const startMs = parseInt(match[1], 10);
      const durMs = parseInt(match[2], 10);
      const text = decodeEntities(match[3].replace(/<[^>]+>/g, '').trim());
      if (text) {
        items.push({
          id: id++,
          start: startMs / 1000,
          end: (startMs + durMs) / 1000,
          text
        });
      }
    }
    if (items.length > 0) return items;

    return items;
  }

  function getVideoId() {
    const urlParams = new URLSearchParams(window.location.search);
    const v = urlParams.get('v');
    if (v) return v;
    if (window.location.pathname.startsWith('/shorts/')) {
      return window.location.pathname.split('/shorts/')[1].split('/')[0].split('?')[0];
    }
    return null;
  }

  // 10. SRT Export & Import Utilities
  function formatSrtTime(seconds) {
    const totalMs = Math.max(0, Math.floor((seconds || 0) * 1000));
    const hrs = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  function itemsToSrt(items, lang = 'fa') {
    let srtContent = '';
    let index = 1;
    for (const item of items) {
      let text = '';
      if (lang === 'en') {
        text = (item.text && item.text.trim()) ? item.text.trim() : '';
      } else {
        text = (item.fa && item.fa.trim()) ? item.fa.trim() : (item.text ? item.text.trim() : '');
      }
      if (!text) continue;
      const startStr = formatSrtTime(item.start);
      const endStr = formatSrtTime(item.end);
      srtContent += `${index}\n${startStr} --> ${endStr}\n${text}\n\n`;
      index++;
    }
    return srtContent.trim() + '\n';
  }

  function hasPersianText(str) {
    if (!str || typeof str !== 'string') return false;
    return /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(str);
  }

  function enrichItemsWithEnglish(targetItems, englishItems) {
    if (!Array.isArray(targetItems) || !Array.isArray(englishItems) || englishItems.length === 0) {
      return false;
    }
    let updatedCount = 0;
    targetItems.forEach((item) => {
      if (!item.text || item.text === item.fa || hasPersianText(item.text)) {
        const overlaps = englishItems.filter((en) => {
          if (!en.text || hasPersianText(en.text)) return false;
          const overlap = Math.min(en.end, item.end) - Math.max(en.start, item.start);
          return overlap > 0.05;
        });
        if (overlaps.length > 0) {
          item.text = overlaps.map((o) => o.text.trim()).filter(Boolean).join(' ');
          updatedCount++;
        } else {
          item.text = '';
        }
      }
    });
    return updatedCount > 0;
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

    function separateLanguages(textLines) {
      const subLines = textLines.split('\n').map((l) => l.trim()).filter(Boolean);
      const faLines = [];
      const enLines = [];
      for (const line of subLines) {
        if (hasPersianText(line)) {
          faLines.push(line);
        } else {
          enLines.push(line);
        }
      }
      if (faLines.length > 0 && enLines.length > 0) {
        return { en: enLines.join('\n'), fa: faLines.join('\n') };
      } else if (faLines.length > 0) {
        return { en: '', fa: faLines.join('\n') };
      } else {
        return { en: enLines.join('\n'), fa: '' };
      }
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
      const startStr = timeLine.slice(0, arrowIdx).trim().split(/\s+/)[0];
      const endStr = timeLine.slice(arrowIdx + 3).trim().split(/\s+/)[0];
      const start = parseTimestamp(startStr);
      const end = parseTimestamp(endStr);
      const textLines = lines.slice(timeLineIdx + 1).join('\n').trim();

      if (textLines && !isNaN(start) && !isNaN(end)) {
        const langResult = separateLanguages(textLines);
        items.push({
          id: autoId++,
          start,
          end,
          text: langResult.en,
          fa: langResult.fa
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
          const langResult = separateLanguages(text);
          items.push({
            id: autoId++,
            start,
            end,
            text: langResult.en,
            fa: langResult.fa
          });
        }
      }
    }

    return items;
  }

  function handleDownloadSrt(lang = 'fa', sendResponse) {
    const vid = getVideoId();
    let sourceItems = activeSubtitles.length > 0 ? activeSubtitles : (cachedSubtitles || []);

    const triggerDownload = (items) => {
      const validItems = items.filter((s) => {
        if (lang === 'en') {
          return (s.text && s.text.trim());
        }
        return (s.fa && s.fa.trim()) || (s.text && s.text.trim());
      });

      if (!validItems || validItems.length === 0) {
        sendResponse({
          success: false,
          error: lang === 'en' ? 'زیرنویس انگلیسی یافت نشد. لطفاً ابتدا CC را در یوتیوب روشن کنید.' : 'هیچ زیرنویسی برای این ویدیو در حافظه کش یافت نشد.'
        });
        return;
      }

      const srtText = itemsToSrt(validItems, lang);
      const title = (document.title || 'subtitles')
        .replace(' - YouTube', '')
        .replace(/[\/\\?%*:|"<>]/g, '_')
        .trim();
      const suffix = lang === 'en' ? 'en' : 'fa';
      const filename = `${title || vid || 'youtube'}_${suffix}.srt`;

      const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      sendResponse({ success: true, count: validItems.length, filename, lang });
    };

    if (sourceItems.length > 0) {
      triggerDownload(sourceItems);
    } else if (latestRawTimedText) {
      const parsed = parseSubtitleRawData(latestRawTimedText);
      if (parsed && parsed.length > 0) {
        triggerDownload(parsed);
      } else {
        checkStorage();
      }
    } else {
      checkStorage();
    }

    function checkStorage() {
      if (vid) {
        chrome.runtime.sendMessage({ type: 'CHECK_CACHE', videoId: vid }, (res) => {
          if (res && res.cached && Array.isArray(res.items) && res.items.length > 0) {
            triggerDownload(res.items);
          } else if (latestRawTimedText) {
            const parsed = parseSubtitleRawData(latestRawTimedText);
            if (parsed && parsed.length > 0) {
              triggerDownload(parsed);
            } else {
              sendResponse({ success: false, error: 'زیرنویسی یافت نشد. لطفاً دکمه CC یوتیوب را فعال کنید.' });
            }
          } else {
            sendResponse({ success: false, error: 'زیرنویسی یافت نشد. لطفاً دکمه CC یوتیوب را فعال کنید.' });
          }
        });
      } else {
        sendResponse({ success: false, error: 'شناسه ویدیوی یوتیوب یافت نشد.' });
      }
    }
  }

  function handleUploadSrt(srtText, sendResponse) {
    const vid = getVideoId();
    if (!vid) {
      sendResponse({ success: false, error: 'شناسه ویدیوی یوتیوب یافت نشد.' });
      return;
    }
    if (!srtText) {
      sendResponse({ success: false, error: 'فایل زیرنویس خالی است.' });
      return;
    }

    const parsedItems = parseSrtToItems(srtText);
    if (parsedItems.length === 0) {
      sendResponse({ success: false, error: 'قالب فایل SRT نامعتبر است یا خطی یافت نشد.' });
      return;
    }

    applyCustomSrtItems(parsedItems, vid);
    sendResponse({ success: true, count: parsedItems.length });
  }

  async function applyCustomSrtItems(parsedItems, vid) {
    if (!vid) vid = getVideoId();

    // 1. Clean up any item where text was wrongly set to Persian
    parsedItems.forEach((it) => {
      if (!it.fa && hasPersianText(it.text)) {
        it.fa = it.text;
      }
      if (it.text === it.fa || hasPersianText(it.text)) {
        it.text = '';
      }
    });

    // 2. Enrich with English if timedtext is already intercepted or active
    if (latestRawTimedText) {
      const enItems = parseSubtitleRawData(latestRawTimedText);
      enrichItemsWithEnglish(parsedItems, enItems);
    } else if (activeSubtitles.length > 0) {
      const enItems = activeSubtitles.filter((s) => s.text && !hasPersianText(s.text));
      enrichItemsWithEnglish(parsedItems, enItems);
    }

    activeSubtitles = parsedItems;
    cachedSubtitles = parsedItems;
    isEnabled = true;
    isTranslationRequested = true;
    isTranslating = false;

    if (vid) {
      const key = `yt_sub_${vid}`;
      try {
        await chrome.storage.local.set({ [key]: parsedItems });
        console.log(`[YT-FA-Translator] 💾 Saved ${parsedItems.length} lines directly to storage with key ${key}`);
      } catch (err) {
        console.warn('[YT-FA-Translator] Direct storage.set error, attempting via background:', err);
        chrome.runtime.sendMessage({
          type: 'SAVE_FULL_CACHE',
          videoId: vid,
          items: parsedItems
        }).catch(() => {});
      }
    }

    // 3. Trigger CC load so if English is still missing, it gets intercepted & enriched automatically
    const stillNeedsEn = parsedItems.some((s) => !s.text);
    if (stillNeedsEn) {
      window.postMessage({ type: 'YT_FA_START_TRANSLATION' }, '*');
    }

    ensureOverlay();
    applyStyles();
    onTimeUpdate();
    updateTranslateButtonUI('active');
    setStatus(`زیرنویس SRT لود شد (${parsedItems.length} خط) ✓`, false);
    setTimeout(() => setStatus(null), 3500);
  }

  let pageFileInputEl = null;

  function triggerPageFileInput() {
    if (!pageFileInputEl) {
      pageFileInputEl = document.createElement('input');
      pageFileInputEl.type = 'file';
      pageFileInputEl.accept = '.srt,text/plain';
      pageFileInputEl.style.display = 'none';
      document.body.appendChild(pageFileInputEl);

      pageFileInputEl.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) {
          handleDroppedFile(file);
        }
        pageFileInputEl.value = '';
      });
    }
    pageFileInputEl.click();
  }

  function handleDroppedFile(file) {
    if (!file) return;
    setStatus(`در حال پردازش ${file.name}...`, true);
    console.log(`[YT-FA-Translator] 📂 Reading SRT file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const srtText = ev.target.result;
        const vid = getVideoId();
        if (!vid) {
          setStatus('خطا: شناسه ویدیوی یوتیوب یافت نشد.', false, true);
          return;
        }

        const parsed = parseSrtToItems(srtText);
        console.log(`[YT-FA-Translator] 🔍 Parsed ${parsed.length} items from ${file.name}`);

        if (parsed.length === 0) {
          setStatus('خطا: قالب فایل SRT نامعتبر است یا خطی یافت نشد.', false, true);
          return;
        }

        await applyCustomSrtItems(parsed, vid);
      } catch (err) {
        console.error('[YT-FA-Translator] File processing error:', err);
        setStatus(`خطا: ${err.message}`, false, true);
      }
    };
    reader.onerror = () => {
      setStatus('خطا در خواندن فایل از دیسک.', false, true);
    };
    reader.readAsText(file);
  }

  function showDropzoneOverlay() {
    let dropzone = document.getElementById('yt-fa-dropzone-modal');
    if (!dropzone) {
      dropzone = document.createElement('div');
      dropzone.id = 'yt-fa-dropzone-modal';
      dropzone.innerHTML = `
        <div class="yt-fa-dropzone-box">
          <div class="yt-fa-dropzone-icon">📤</div>
          <div class="yt-fa-dropzone-title">آپلود زیرنویس SRT</div>
          <div class="yt-fa-dropzone-desc">برای انتخاب فایل SRT از کامپیوتر کلیک کنید<br>یا فایل را مستقیماً اینجا بکشید و رها کنید (Drag & Drop)</div>
          <button type="button" class="yt-fa-dropzone-close">✕ انصراف</button>
        </div>
      `;
      document.body.appendChild(dropzone);

      dropzone.querySelector('.yt-fa-dropzone-box').addEventListener('click', (e) => {
        if (e.target.classList.contains('yt-fa-dropzone-close')) return;
        dropzone.style.display = 'none';
        triggerPageFileInput();
      });

      dropzone.querySelector('.yt-fa-dropzone-close').addEventListener('click', (e) => {
        e.stopPropagation();
        dropzone.style.display = 'none';
      });

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dropzone.querySelector('.yt-fa-dropzone-box')?.classList.add('drag-over');
      });

      dropzone.addEventListener('dragleave', () => {
        dropzone.querySelector('.yt-fa-dropzone-box')?.classList.remove('drag-over');
      });

      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.querySelector('.yt-fa-dropzone-box')?.classList.remove('drag-over');
        dropzone.style.display = 'none';
        const file = e.dataTransfer?.files?.[0];
        if (file) {
          handleDroppedFile(file);
        }
      });
    }
    dropzone.style.display = 'flex';
  }

  function setupDragAndDrop(player) {
    if (!player || player._hasSrtDrop) return;
    player._hasSrtDrop = true;

    player.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    player.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && (file.name.endsWith('.srt') || file.type.includes('text') || file.name.endsWith('.txt'))) {
        handleDroppedFile(file);
      }
    });
  }

  // 10. Navigation & Initialization
  async function onVideoChange() {
    const newVideoId = getVideoId();
    if (!newVideoId) {
      if (isTranslating) {
        cancelTranslation('navigated_away_from_video');
      }
      currentVideoId = null;
      hasStartedTranslation = false;
      isTranslationRequested = false;
      isTranslating = false;
      activeSubtitles = [];
      cachedSubtitles = null;
      latestRawTimedText = null;
      clearTimeout(preparingTimeout);
      setStatus(null);
      if (overlayEl) overlayEl.style.display = 'none';
      return;
    }

    if (newVideoId !== currentVideoId) {
      if (isTranslating) {
        cancelTranslation('switched_video');
      }
      currentVideoId = newVideoId;
      hasStartedTranslation = false;
      isTranslationRequested = false;
      isTranslating = false;
      activeSubtitles = [];
      cachedSubtitles = null;
      latestRawTimedText = null;
      realtimeTranslations.clear();
      lastObservedText = '';
      if (subBoxEl) subBoxEl.style.display = 'none';

      clearTimeout(preparingTimeout);
      setStatus(null);

      ensureOverlay();
      applyStyles();

      // Check cache first!
      const cacheRes = await chrome.runtime.sendMessage({ type: 'CHECK_CACHE', videoId: newVideoId });
      if (cacheRes && cacheRes.cached && Array.isArray(cacheRes.items) && cacheRes.items.length > 0) {
        cachedSubtitles = cacheRes.items;
        const isFullyCached = cacheRes.items.every((it) => it.fa && it.fa.trim().length > 0);
        if (autoTranslate) {
          activeSubtitles = cachedSubtitles;
          isTranslationRequested = true;
          applyStyles();
          if (isFullyCached) {
            updateTranslateButtonUI('active');
          } else {
            startTranslationProcess();
          }
        } else {
          updateTranslateButtonUI(isFullyCached ? 'cached' : 'idle');
        }
        return;
      }

      // If auto-translate is enabled, automatically start
      if (autoTranslate) {
        startTranslationProcess();
      } else {
        updateTranslateButtonUI('idle');
      }
    }
  }

  window.addEventListener('yt-navigate-start', () => {
    if (isTranslating) {
      cancelTranslation('yt-navigate-start');
    }
  });

  window.addEventListener('pagehide', () => {
    if (isTranslating) {
      cancelTranslation('pagehide');
    }
  });

  window.addEventListener('beforeunload', () => {
    if (isTranslating) {
      cancelTranslation('beforeunload');
    }
  });

  window.addEventListener('yt-navigate-finish', () => {
    ensureOverlay();
    onVideoChange();
  });

  window.addEventListener('load', () => {
    loadSettings();
    injectPageScript();
    ensureOverlay();
    onVideoChange();
  });

  loadSettings();
  injectPageScript();
  ensureOverlay();
  onVideoChange();

  setInterval(() => {
    const vid = getVideoId();
    if (vid) {
      ensureOverlay();
      if (activeSubtitles.length === 0 && !isTranslating && !hasStartedTranslation && (autoTranslate || isTranslationRequested)) {
        window.postMessage({ type: 'YT_FA_START_TRANSLATION' }, '*');
      }
    }
  }, 4000);
})();
