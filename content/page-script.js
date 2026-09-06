// Page script injected into YouTube page context

(function () {
  // 1. Intercept fetch for timedtext requests
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && url.includes('/api/timedtext')) {
        const clone = response.clone();
        clone.text().then((text) => {
          if (text && text.trim().length > 0) {
            console.log('[YT-FA-Translator] 🎯 Intercepted timedtext via fetch! Length:', text.length);
            window.postMessage({ type: 'YT_FA_INTERCEPTED_TIMEDTEXT', rawText: text }, '*');
          }
        }).catch(() => {});
      }
    } catch (e) {}
    return response;
  };

  // 2. Intercept XMLHttpRequest for timedtext requests
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ytFaUrl = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._ytFaUrl && typeof this._ytFaUrl === 'string' && this._ytFaUrl.includes('/api/timedtext')) {
      this.addEventListener('load', function () {
        try {
          if (this.responseText && this.responseText.trim().length > 0) {
            console.log('[YT-FA-Translator] 🎯 Intercepted timedtext via XHR! Length:', this.responseText.length);
            window.postMessage({ type: 'YT_FA_INTERCEPTED_TIMEDTEXT', rawText: this.responseText }, '*');
          }
        } catch (e) {}
      });
    }
    return originalSend.apply(this, args);
  };

  // 3. Force YouTube Player to reload captions
  function forceReloadCaptions() {
    try {
      const player = document.getElementById('movie_player');
      if (!player) return;

      if (typeof player.loadModule === 'function') {
        player.loadModule('captions');
      }

      let tracklist = [];
      if (typeof player.getOption === 'function') {
        tracklist = player.getOption('captions', 'tracklist') || [];
      }

      // Find English track (manual or auto ASR)
      let targetTrack = tracklist.find((t) => (t.languageCode === 'en' || t.vss_id === '.en') && t.kind !== 'asr');
      if (!targetTrack) {
        targetTrack = tracklist.find((t) => t.languageCode === 'en' || t.vss_id?.includes('.en') || t.vssId?.includes('.en'));
      }
      if (!targetTrack && tracklist.length > 0) {
        targetTrack = tracklist[0];
      }

      console.log('[YT-FA-Translator] Activating player track:', targetTrack);

      if (targetTrack && typeof player.setOption === 'function') {
        player.setOption('captions', 'track', {});
        setTimeout(() => {
          player.setOption('captions', 'track', targetTrack);
          player.setOption('captions', 'reload', true);
        }, 150);
      }

      // Also ensure CC button is clicked if not active
      const ccBtn = document.querySelector('.ytp-subtitles-button');
      if (ccBtn && ccBtn.getAttribute('aria-pressed') !== 'true') {
        console.log('[YT-FA-Translator] Clicking YouTube CC button...');
        ccBtn.click();
      }

      // 4. Also attempt direct fetch from playerResponse
      tryDirectFetch();
    } catch (e) {
      console.warn('[YT-FA-Translator] forceReloadCaptions error:', e);
    }
  }

  function tryDirectFetch() {
    try {
      const player = document.getElementById('movie_player');
      const tracks = player?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks
                  || window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

      if (Array.isArray(tracks) && tracks.length > 0) {
        const enTrack = tracks.find((t) => t.languageCode === 'en' || t.vssId?.includes('.en'));
        if (enTrack && enTrack.baseUrl) {
          window.postMessage({ type: 'YT_FA_TIMEDTEXT_BASEURL', url: enTrack.baseUrl }, '*');
          fetch(enTrack.baseUrl, { credentials: 'include' })
            .then((r) => r.text())
            .then((text) => {
              if (text && text.trim().length > 0) {
                console.log('[YT-FA-Translator] 🎯 Got timedtext from direct baseUrl fetch! Length:', text.length);
                window.postMessage({ type: 'YT_FA_INTERCEPTED_TIMEDTEXT', rawText: text }, '*');
              }
            })
            .catch(() => {});
        }
      }
    } catch (e) {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'YT_FA_FORCE_ENABLE_CC' || event.data.type === 'YT_FA_TRANSLATE_GET_TRACKS') {
      forceReloadCaptions();
    }
  });

  window.postMessage({ type: 'YT_FA_PAGE_SCRIPT_READY' }, '*');
  setTimeout(forceReloadCaptions, 800);
})();
