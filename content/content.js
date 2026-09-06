// YouTube Persian Subtitle Translator - Content Script

(function () {
  let currentVideoId = null;
  let activeSubtitles = [];
  let isEnabled = true;
  let isBilingual = true;
  let fontSize = 20;
  let overlayEl = null;
  let statusBadgeEl = null;
  let subBoxEl = null;
  let subFaEl = null;
  let subEnEl = null;
  let videoEl = null;
  let toggleBtnEl = null;
  let isTranslating = false;
  let hasStartedTranslation = false;
  let captionObserver = null;
  let liveDebounceTimer = null;
  let lastObservedText = '';
  const realtimeTranslations = new Map();

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
        handleInterceptedTimedText(rawText);
      }
    }

    if (event.data.type === 'YT_FA_TIMEDTEXT_BASEURL') {
      const url = event.data.url;
      if (url && !hasStartedTranslation && activeSubtitles.length === 0) {
        console.log('[YT-FA-Translator] Received timedtext baseUrl from page-script, fetching via background service worker...');
        chrome.runtime.sendMessage({ type: 'FETCH_TIMEDTEXT', url }).then((res) => {
          if (res && res.success && res.rawText && res.rawText.trim().length > 0) {
            console.log('[YT-FA-Translator] Successfully fetched timedtext via background! Length:', res.rawText.length);
            handleInterceptedTimedText(res.rawText);
          }
        }).catch((err) => {
          console.warn('[YT-FA-Translator] Background timedtext fetch error:', err);
        });
      }
    }

    if (event.data.type === 'YT_FA_PAGE_SCRIPT_READY') {
      console.log('[YT-FA-Translator] Page script confirmed ready.');
      window.postMessage({ type: 'YT_FA_FORCE_ENABLE_CC' }, '*');
    }
  });

  // 3. Load user settings
  async function loadSettings() {
    try {
      const settings = await chrome.storage.local.get(['enabled', 'bilingual', 'fontSize']);
      isEnabled = settings.enabled !== false;
      isBilingual = settings.bilingual !== false;
      fontSize = settings.fontSize || 20;
      applyStyles();
    } catch (e) {
      console.warn('[YT-FA-Translator] Error loading settings:', e);
    }
  }

  function applyStyles() {
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (player) {
      player.classList.toggle('yt-fa-hide-default-cc', isEnabled);
    }

    if (overlayEl) {
      overlayEl.style.setProperty('--yt-fa-font-size', `${fontSize}px`);
      overlayEl.style.display = isEnabled ? 'flex' : 'none';
    }
    if (subEnEl) {
      subEnEl.style.display = isBilingual ? 'block' : 'none';
    }
    if (toggleBtnEl) {
      toggleBtnEl.classList.toggle('active', isEnabled);
      toggleBtnEl.title = isEnabled ? 'زیرنویس فارسی: فعال' : 'زیرنویس فارسی: غیرفعال';
    }
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) isEnabled = changes.enabled.newValue;
    if (changes.bilingual) isBilingual = changes.bilingual.newValue;
    if (changes.fontSize) fontSize = changes.fontSize.newValue;
    applyStyles();
  });

  // 4. Setup Custom Subtitle Overlay inside YouTube Player
  function ensureOverlay() {
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (!player) return false;

    videoEl = player.querySelector('video');
    player.classList.toggle('yt-fa-hide-default-cc', isEnabled);

    if (!overlayEl || !player.contains(overlayEl)) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'yt-fa-sub-overlay';
      overlayEl.style.display = isEnabled ? 'flex' : 'none';
      overlayEl.style.setProperty('--yt-fa-font-size', `${fontSize}px`);

      // Status Badge
      statusBadgeEl = document.createElement('div');
      statusBadgeEl.className = 'yt-fa-status-badge';
      statusBadgeEl.style.display = 'none';
      overlayEl.appendChild(statusBadgeEl);

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

    injectControlsButton();
    setupLiveCaptionObserver(player);
    return true;
  }

  // 5. Inject Quick Toggle Button into YouTube Control Bar
  function injectControlsButton() {
    const rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls || document.getElementById('yt-fa-toggle-btn')) return;

    toggleBtnEl = document.createElement('button');
    toggleBtnEl.id = 'yt-fa-toggle-btn';
    toggleBtnEl.className = `ytp-button yt-fa-control-btn ${isEnabled ? 'active' : ''}`;
    toggleBtnEl.title = isEnabled ? 'زیرنویس فارسی: فعال' : 'زیرنویس فارسی: غیرفعال';
    toggleBtnEl.setAttribute('aria-label', 'ترجمه فارسی زیرنویس');

    toggleBtnEl.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </svg>
    `;

    toggleBtnEl.addEventListener('click', async () => {
      isEnabled = !isEnabled;
      await chrome.storage.local.set({ enabled: isEnabled });
      applyStyles();
    });

    rightControls.insertBefore(toggleBtnEl, rightControls.firstChild);
  }

  function setStatus(text, showSpinner = true, allowRetry = false) {
    if (!statusBadgeEl) return;
    if (!text) {
      statusBadgeEl.style.display = 'none';
      return;
    }
    let html = '';
    if (showSpinner) {
      html = `<div class="yt-fa-spinner"></div><span>${text}</span>`;
    } else if (allowRetry) {
      html = `<span>${text}</span> <button class="yt-fa-retry-btn" style="background:#ef4444;color:#fff;border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;margin-right:6px;">تلاش مجدد</button>`;
    } else {
      html = `<span>${text}</span>`;
    }
    statusBadgeEl.innerHTML = html;
    statusBadgeEl.style.display = 'flex';

    if (allowRetry) {
      const retryBtn = statusBadgeEl.querySelector('.yt-fa-retry-btn');
      if (retryBtn) {
        retryBtn.onclick = (e) => {
          e.stopPropagation();
          hasStartedTranslation = false;
          isTranslating = false;
          window.postMessage({ type: 'YT_FA_FORCE_ENABLE_CC' }, '*');
        };
      }
    }
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
      subFaEl.textContent = currentItem.fa || '...';
      subEnEl.textContent = currentItem.text || '';
      subBoxEl.style.display = 'inline-flex';
    } else {
      subBoxEl.style.display = 'none';
    }
  }

  let preparingTimeout = null;

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
      if (!isEnabled || activeSubtitles.length > 0) return;

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

  // 8. Progressive Batch Translation
  async function handleInterceptedTimedText(rawText) {
    const videoId = getVideoId();
    if (!videoId || hasStartedTranslation || activeSubtitles.length > 0) return;
    hasStartedTranslation = true;
    clearTimeout(preparingTimeout);

    // Check Cache first
    const cacheRes = await chrome.runtime.sendMessage({ type: 'CHECK_CACHE', videoId });
    if (cacheRes && cacheRes.cached && Array.isArray(cacheRes.items) && cacheRes.items.length > 0) {
      console.log('[YT-FA-Translator] ⚡ Loaded from local cache:', cacheRes.items.length, 'lines.');
      activeSubtitles = cacheRes.items;
      setStatus(null);
      return;
    }

    const parsedItems = parseSubtitleRawData(rawText);
    if (!parsedItems || parsedItems.length === 0) {
      hasStartedTranslation = false;
      return;
    }

    console.log(
      `%c[YT-FA-Translator] 🎬 Intercepted full timedtext: ${parsedItems.length} lines. Starting progressive batch translation...`,
      'color: #2563eb; font-weight: bold;'
    );
    isTranslating = true;

    const CHUNK_SIZE = 35;
    const totalLines = parsedItems.length;
    let completedLines = 0;
    const translationMap = new Map();

    for (let i = 0; i < totalLines; i += CHUNK_SIZE) {
      if (videoId !== getVideoId()) break;

      const chunk = parsedItems.slice(i, i + CHUNK_SIZE);
      const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
      const totalChunks = Math.ceil(totalLines / CHUNK_SIZE);

      setStatus(`در حال ترجمه هوشمند: دسته ${chunkNum} از ${totalChunks} (${Math.min(i + CHUNK_SIZE, totalLines)} از ${totalLines} سطر)...`, true);

      console.log(
        `%c[YT-FA-Translator] 🚀 [LLM Batch Request Sent] Chunk ${chunkNum}/${totalChunks} (${chunk.length} items):\n  Lines: ${i + 1} to ${Math.min(i + CHUNK_SIZE, totalLines)}`,
        'color: #2563eb; font-weight: bold;',
        chunk.map((c) => `[#${c.id}] ${c.text}`)
      );

      try {
        const res = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_CHUNK',
          chunkItems: chunk
        });

        if (res && res.success && Array.isArray(res.translations)) {
          console.log(
            `%c[YT-FA-Translator] 📥 [LLM Batch Response Received] Chunk ${chunkNum}/${totalChunks} succeeded! (${res.translations.length} items) via ${res.provider || 'AI'} (${res.model || ''})`,
            'color: #059669; font-weight: bold;',
            res.translations
          );

          res.translations.forEach((t) => {
            if (t && t.id !== undefined && t.fa) {
              translationMap.set(t.id, t.fa);
            }
          });

          // Immediately populate activeSubtitles with translated items so playback syncs right away!
          activeSubtitles = parsedItems.map((item) => ({
            ...item,
            fa: translationMap.get(item.id) || ''
          }));

          completedLines += chunk.length;
        } else {
          console.error(
            `%c[YT-FA-Translator] ❌ [LLM Batch Error]`,
            'color: #dc2626; font-weight: bold;',
            res?.error
          );
          setStatus(`خطا در ترجمه: ${res?.error || 'خطای اتصال به هوش مصنوعی'}`, false, true);
          isTranslating = false;
          return;
        }
      } catch (err) {
        console.error(
          `%c[YT-FA-Translator] ❌ [LLM Batch Request Failed Exception]`,
          'color: #dc2626; font-weight: bold;',
          err
        );
        setStatus(`خطا: ${err.message}`, false, true);
        isTranslating = false;
        return;
      }
    }

    // Finished all chunks!
    if (videoId === getVideoId()) {
      setStatus('ترجمه زیرنویس کامل شد ✓', false);
      setTimeout(() => setStatus(null), 3000);
      chrome.runtime.sendMessage({
        type: 'SAVE_FULL_CACHE',
        videoId: videoId,
        items: activeSubtitles
      });
    }
    isTranslating = false;
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
    return urlParams.get('v');
  }

  // 10. Navigation & Initialization
  function onVideoChange() {
    const newVideoId = getVideoId();
    if (!newVideoId) {
      currentVideoId = null;
      hasStartedTranslation = false;
      activeSubtitles = [];
      clearTimeout(preparingTimeout);
      if (overlayEl) overlayEl.style.display = 'none';
      return;
    }

    if (newVideoId !== currentVideoId) {
      currentVideoId = newVideoId;
      hasStartedTranslation = false;
      activeSubtitles = [];
      isTranslating = false;
      realtimeTranslations.clear();
      lastObservedText = '';
      if (subBoxEl) subBoxEl.style.display = 'none';

      clearTimeout(preparingTimeout);
      setStatus('در حال آماده‌سازی زیرنویس فارسی...', true);

      // Auto-clear preparation indicator after 3.5s so it never stays stuck indefinitely!
      preparingTimeout = setTimeout(() => {
        if (!isTranslating && activeSubtitles.length === 0) {
          console.log('[YT-FA-Translator] Subtitle preparation timed out. Ready for live captions.');
          setStatus(null);
        }
      }, 3500);

      ensureOverlay();
      applyStyles();

      // Trigger player captions
      window.postMessage({ type: 'YT_FA_FORCE_ENABLE_CC' }, '*');
    }
  }

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
      if (activeSubtitles.length === 0 && !isTranslating && !hasStartedTranslation) {
        window.postMessage({ type: 'YT_FA_FORCE_ENABLE_CC' }, '*');
      }
    }
  }, 4000);
})();
