// Dedicated SRT Uploader for YouTube Subtitle Translator
document.addEventListener('DOMContentLoaded', async () => {
  const videoUrlInput = document.getElementById('videoUrlInput');
  const detectTabBtn = document.getElementById('detectTabBtn');
  const keyPreviewCode = document.getElementById('keyPreviewCode');
  const videoInfoBadge = document.getElementById('videoInfoBadge');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const resultBox = document.getElementById('resultBox');
  const alertBox = document.getElementById('alertBox');
  const storageKeyName = document.getElementById('storageKeyName');
  const resFileName = document.getElementById('resFileName');
  const resFileSize = document.getElementById('resFileSize');
  const resLineCount = document.getElementById('resLineCount');
  const resDuration = document.getElementById('resDuration');
  const previewBox = document.getElementById('previewBox');
  const returnToYtBtn = document.getElementById('returnToYtBtn');
  const openVideoNowBtn = document.getElementById('openVideoNowBtn');
  const verifyStorageBtn = document.getElementById('verifyStorageBtn');

  let activeVideoId = null;
  let activeTabId = null;
  let currentParsedItems = [];

  // 1. Parse URL Parameters
  const urlParams = new URLSearchParams(window.location.search);
  const paramVid = urlParams.get('videoId');
  const paramTabId = urlParams.get('tabId');

  if (paramVid) {
    setVideoId(paramVid);
  }
  if (paramTabId) {
    activeTabId = parseInt(paramTabId, 10);
    returnToYtBtn.style.display = 'inline-flex';
  }

  // 2. Auto-detect active YouTube tab if not provided
  if (!activeVideoId) {
    await detectActiveYouTubeTab();
  }

  function extractVideoId(input) {
    if (!input) return null;
    const clean = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) {
      return clean;
    }
    try {
      const url = new URL(clean.startsWith('http') ? clean : `https://${clean}`);
      const v = url.searchParams.get('v');
      if (v) return v;
      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/shorts/')[1].split('/')[0].split('?')[0];
      }
      if (url.pathname.startsWith('/embed/')) {
        return url.pathname.split('/embed/')[1].split('/')[0].split('?')[0];
      }
      if (url.hostname === 'youtu.be') {
        return url.pathname.slice(1).split('?')[0];
      }
    } catch (_) {}
    return null;
  }

  function setVideoId(vid) {
    activeVideoId = vid;
    videoUrlInput.value = vid;
    keyPreviewCode.textContent = `yt_sub_${vid}`;
    videoInfoBadge.style.display = 'block';
    videoInfoBadge.textContent = `✓ ویدیوی فعال انتخاب شده: ${vid}`;
  }

  videoUrlInput.addEventListener('input', () => {
    const vid = extractVideoId(videoUrlInput.value);
    if (vid) {
      activeVideoId = vid;
      keyPreviewCode.textContent = `yt_sub_${vid}`;
      videoInfoBadge.style.display = 'block';
      videoInfoBadge.textContent = `✓ شناسه ویدیو تایید شد: ${vid}`;
    } else {
      activeVideoId = null;
      keyPreviewCode.textContent = 'yt_sub_...';
      videoInfoBadge.style.display = 'none';
    }
  });

  detectTabBtn.addEventListener('click', detectActiveYouTubeTab);

  async function detectActiveYouTubeTab() {
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
      const currentTab = tabs.find((t) => t.active) || tabs[0];
      if (currentTab && currentTab.url) {
        const vid = extractVideoId(currentTab.url);
        if (vid) {
          activeTabId = currentTab.id;
          setVideoId(vid);
          returnToYtBtn.style.display = 'inline-flex';
          showAlert('ویدیوی فعال یوتیوب شناسایی شد ✓', 'success');
          return;
        }
      }
      showAlert('تب یوتیوب بازی یافت نشد؛ شناسه یا لینک ویدیو را در کادر بالا وارد کنید.', 'error');
    } catch (e) {
      console.warn('Error querying tabs:', e);
    }
  }

  // 3. Dropzone & File Handling
  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) processFile(file);
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    fileInput.value = '';
  });

  async function processFile(file) {
    if (!activeVideoId) {
      showAlert('لطفاً ابتدا شناسه یا لینک ویدیوی یوتیوب را در کادر بالا مشخص کنید.', 'error');
      videoUrlInput.focus();
      return;
    }

    showAlert(`در حال خواندن و تجزیه فایل ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)...`, 'success');

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const srtText = ev.target.result;
        const items = parseSrtToItems(srtText);

        if (!items || items.length === 0) {
          showAlert('خطا: هیچ خط زیرنویسی در این فایل شناسایی نشد. مطمئن شوید فرمت فایل SRT استاندارد است.', 'error');
          return;
        }

        currentParsedItems = items;
        const key = `yt_sub_${activeVideoId}`;

        // Save directly to chrome.storage.local
        await chrome.storage.local.set({ [key]: items });

        // Double check from storage to guarantee it was written
        const verify = await chrome.storage.local.get(key);
        if (!verify || !verify[key] || verify[key].length === 0) {
          throw new Error('خطا در نوشتن داده‌ها روی حافظه محلی افزونه.');
        }

        displaySuccess(file, items, key);

        // Notify active tab if exists
        if (activeTabId) {
          chrome.tabs.sendMessage(activeTabId, {
            type: 'LOAD_SRT_ITEMS_CMD',
            items: items,
            videoId: activeVideoId
          }, () => {});
        }
      } catch (err) {
        console.error('Error processing SRT:', err);
        showAlert(`خطا در ذخیره‌سازی: ${err.message}`, 'error');
      }
    };

    reader.onerror = () => {
      showAlert('خطا در خواندن فایل از دیسک.', 'error');
    };

    reader.readAsText(file, 'utf-8');
  }

  function displaySuccess(file, items, key) {
    storageKeyName.textContent = `کلید در استورج: ${key}`;
    resFileName.textContent = file.name;
    resFileSize.textContent = `${(file.size / 1024).toFixed(1)} KB`;
    resLineCount.textContent = `${items.length.toLocaleString('fa-IR')} خط`;

    const lastItem = items[items.length - 1];
    const durationMins = Math.floor((lastItem?.end || 0) / 60);
    const durationSecs = Math.floor((lastItem?.end || 0) % 60);
    resDuration.textContent = `${durationMins}:${String(durationSecs).padStart(2, '0')}`;

    // Render first 5 preview items
    previewBox.innerHTML = '';
    const sample = items.slice(0, 5);
    sample.forEach((it) => {
      const lineDiv = document.createElement('div');
      lineDiv.className = 'preview-line';
      lineDiv.innerHTML = `
        <span class="preview-time">[${formatTime(it.start)} -> ${formatTime(it.end)}]</span>
        <span>${escapeHtml(it.fa || it.text)}</span>
      `;
      previewBox.appendChild(lineDiv);
    });

    resultBox.classList.add('show');
    showAlert(`زیرنویس با موفقیت تجزیه و ذخیره شد! (${items.length} خط)`, 'success');
  }

  verifyStorageBtn.addEventListener('click', async () => {
    if (!activeVideoId) return;
    const key = `yt_sub_${activeVideoId}`;
    const data = await chrome.storage.local.get(key);
    if (data && data[key] && data[key].length > 0) {
      showAlert(`✓ کلید ${key} با موفقیت بررسی شد و دارای ${data[key].length} خط زیرنویس است.`, 'success');
    } else {
      showAlert(`❌ کلید ${key} در حافظه یافت نشد!`, 'error');
    }
  });

  openVideoNowBtn.addEventListener('click', openYouTubeVideo);
  returnToYtBtn.addEventListener('click', openYouTubeVideo);

  async function openYouTubeVideo() {
    if (!activeVideoId) return;
    const ytUrl = `https://www.youtube.com/watch?v=${activeVideoId}`;
    if (activeTabId) {
      try {
        await chrome.tabs.update(activeTabId, { active: true });
        const tab = await chrome.tabs.get(activeTabId);
        if (tab && tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
      } catch (_) {}
    }
    chrome.tabs.create({ url: ytUrl });
  }

  function showAlert(text, type = 'error') {
    alertBox.className = `alert alert-${type}`;
    alertBox.textContent = text;
    alertBox.style.display = 'flex';
  }

  function formatTime(secs) {
    const s = Math.floor(secs || 0);
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return `${m}:${String(remS).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m]);
  }

  // 4. Robust SRT Parser
  function parseSrtToItems(srtText) {
    if (!srtText || typeof srtText !== 'string') return [];
    const items = [];
    const cleanText = srtText.replace(/^\uFEFF/, '');
    const normalized = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    function parseTimestamp(timeStr) {
      if (!timeStr) return 0;
      const clean = timeStr.trim().replace(',', '.');
      const match = clean.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
      if (!match) {
        const m2 = clean.match(/(\d{1,2}):(\d{2})/);
        if (m2) return parseInt(m2[1], 10) * 60 + parseInt(m2[2], 10);
        return parseFloat(clean) || 0;
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
      const startStr = timeLine.slice(0, arrowIdx).trim().split(/\s+/)[0];
      const endStr = timeLine.slice(arrowIdx + 3).trim().split(/\s+/)[0];

      const start = parseTimestamp(startStr);
      const end = parseTimestamp(endStr);
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

    // Fallback regex scanner if block splitting missed cues
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
});
