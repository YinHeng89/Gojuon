/* ============================================================
   かなの庭 — interactions
   Vanilla JS, no dependencies, no build step.
   ============================================================ */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  const DATA = window.KANA_DATA;
  if (!DATA) return;

  const STORAGE_KEY = 'kanaGarden.v1';
  const THEME_KEY = 'kanaGarden.theme';
  const TOTAL_CHARS = DATA.items.length * 2;
  const ALL_GROUPS = ['seion', 'dakuon', 'handakuon', 'yoon'];
  const GROUP_LABELS = { seion: '清音', dakuon: '浊音', handakuon: '半浊音', yoon: '拗音' };
  const RING_CIRCUMFERENCE = 2 * Math.PI * 52;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const pad = (value) => String(value).padStart(2, '0');

  const itemMap = new Map(DATA.items.map((item) => [item.id, item]));
  const seionItems = DATA.items.filter((item) => item.group === 'seion');
  const isHiragana = (script) => script !== 'katakana';
  const scriptPrefix = (script) => (isHiragana(script) ? 'h' : 'k');
  const charOf = (item, script) => (isHiragana(script) ? item.h : item.k);
  const rowOf = (group, rowKey) => (DATA.rows[group] || []).find((row) => row.key === rowKey);
  const rowLabelOf = (item, script) => {
    const row = rowOf(item.group, item.row);
    return row ? (isHiragana(script) ? row.h : row.k) : '';
  };

  const todayKey = (date = new Date()) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  const shiftDate = (date, days) => {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  };

  const escapeHTML = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));

  /* ── Persistent state ──────────────────────────────── */
  const defaultStats = { answered: 0, correct: 0, bestStreak: 0, bestScore: 0 };

  function freshDaily() {
    return { date: todayKey(), listen: false, write: false, quiz: false };
  }

  function defaultStore() {
    return {
      script: 'hiragana',
      group: 'seion',
      showRomaji: true,
      writingId: 'a',
      quizMode: 'read',
      quizRange: 'seion',
      mastered: [],
      stats: { ...defaultStats },
      mistakes: {},
      activity: {},
      daily: freshDaily()
    };
  }

  function loadStore() {
    const base = defaultStore();
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (error) {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') return base;

    const merged = { ...base, ...raw };
    merged.script = raw.script === 'katakana' ? 'katakana' : 'hiragana';
    merged.group = ALL_GROUPS.includes(raw.group) ? raw.group : 'seion';
    merged.showRomaji = typeof raw.showRomaji === 'boolean' ? raw.showRomaji : true;
    merged.quizMode = raw.quizMode === 'listen' ? 'listen' : 'read';
    merged.quizRange = ['seion', 'voiced', 'yoon', 'all'].includes(raw.quizRange) ? raw.quizRange : 'seion';
    merged.writingId = itemMap.has(raw.writingId) ? raw.writingId : 'a';
    merged.stats = { ...defaultStats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) };

    Object.keys(merged.stats).forEach((key) => {
      const number = Number(merged.stats[key]);
      merged.stats[key] = Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
    });

    merged.mastered = Array.isArray(raw.mastered)
      ? Array.from(new Set(raw.mastered.filter((key) => {
        if (typeof key !== 'string') return false;
        const [prefix, id] = key.split(':');
        return (prefix === 'h' || prefix === 'k') && itemMap.has(id);
      })))
      : [];

    merged.mistakes = {};
    if (raw.mistakes && typeof raw.mistakes === 'object') {
      Object.entries(raw.mistakes).forEach(([key, value]) => {
        const [prefix, id] = key.split(':');
        if ((prefix === 'h' || prefix === 'k') && itemMap.has(id) && Number(value) > 0) {
          merged.mistakes[key] = Math.floor(Number(value));
        }
      });
    }

    merged.activity = {};
    if (raw.activity && typeof raw.activity === 'object') {
      Object.entries(raw.activity).forEach(([key, value]) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(key) && Number(value) > 0) {
          merged.activity[key] = Math.floor(Number(value));
        }
      });
    }

    const today = todayKey();
    if (!raw.daily || raw.daily.date !== today) {
      merged.daily = freshDaily();
    } else {
      merged.daily = {
        date: today,
        listen: Boolean(raw.daily.listen),
        write: Boolean(raw.daily.write),
        quiz: Boolean(raw.daily.quiz)
      };
    }

    // Keep local storage lean.
    const cutoff = shiftDate(new Date(), -180);
    Object.keys(merged.activity).forEach((key) => {
      if (key < todayKey(cutoff)) delete merged.activity[key];
    });

    return merged;
  }

  let store = loadStore();
  let masteredSet = new Set(store.mastered);
  let storageAvailable = true;

  function saveStore() {
    store.mastered = Array.from(masteredSet);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
      if (storageAvailable) {
        storageAvailable = false;
        showToast('浏览器无法保存进度，本次记录仅在当前页面有效。');
      }
    }
  }

  const masteryKey = (script, id) => `${scriptPrefix(script)}:${id}`;
  const isMastered = (script, id) => masteredSet.has(masteryKey(script, id));

  function countMastered(script, groups) {
    const list = Array.isArray(groups) ? groups : [groups];
    let count = 0;
    list.forEach((group) => {
      DATA.items.forEach((item) => {
        if (item.group === group && isMastered(script, item.id)) count += 1;
      });
    });
    return count;
  }

  function totalMastered() {
    return masteredSet.size;
  }

  function setMastered(script, id, value) {
    const key = masteryKey(script, id);
    const before = masteredSet.has(key);
    if (value) masteredSet.add(key);
    else masteredSet.delete(key);
    if (before !== value) {
      saveStore();
      syncChartMastery();
      refreshProgressUI();
      updateDialogMasterButton();
    }
    return before !== value;
  }

  /* ── DOM references ────────────────────────────────── */
  const el = {
    header: $('#siteHeader'),
    themeToggle: $('#themeToggle'),
    themeColor: $('#themeColor'),
    navCount: $('#navCount'),
    ribbon: $('#ribbonTrack'),

    heroKana: $('#heroKana'),
    heroRomaji: $('#heroRomaji'),
    heroRowLabel: $('#heroRowLabel'),
    heroVowels: $('#heroVowels'),
    heroKanaButton: $('#heroKanaButton'),
    heroPlay: $('#heroPlay'),

    scriptButtons: $$('.script-btn'),
    groupTabs: $('#groupTabs'),
    groupButtons: $$('.group-btn'),
    romajiToggle: $('#romajiToggle'),
    randomKana: $('#randomKana'),
    kanaChart: $('#kanaChart'),
    chartHint: $('#chartHint'),
    chartMastered: $('#chartMastered'),
    chartTotal: $('#chartTotal'),

    quizIntro: $('#quizIntro'),
    quizGame: $('#quizGame'),
    quizResult: $('#quizResult'),
    bestScore: $('#bestScore'),
    quizModes: $('#quizModes'),
    quizIntroTitle: $('#quizIntroTitle'),
    quizRanges: $('#quizRanges'),
    startQuiz: $('#startQuiz'),
    quizCounter: $('#quizCounter'),
    quizExit: $('#quizExit'),
    quizScore: $('#quizScore'),
    quizStreak: $('#quizStreak'),
    quizProgressBar: $('#quizProgressBar'),
    quizModeLabel: $('#quizModeLabel'),
    quizRangeLabel: $('#quizRangeLabel'),
    quizPrompt: $('#quizPrompt'),
    quizDisplay: $('#quizDisplay'),
    quizOptions: $('#quizOptions'),
    quizFeedback: $('#quizFeedback'),
    quizNext: $('#quizNext'),
    resultRing: $('#resultRing'),
    resultScore: $('#resultScore'),
    resultTitle: $('#resultTitle'),
    resultMessage: $('#resultMessage'),
    resultMissedList: $('#resultMissedList'),
    quizAgain: $('#quizAgain'),
    quizReset: $('#quizReset'),

    dailyDate: $('#dailyDate'),
    dailyKanaButton: $('#dailyKanaButton'),
    dailyKana: $('#dailyKana'),
    dailyWordKana: $('#dailyWordKana'),
    dailyWordMeaning: $('#dailyWordMeaning'),
    dailyTaskCount: $('#dailyTaskCount'),
    dailyTasks: $$('.daily-task'),
    tipText: $('#tipText'),
    nextTip: $('#nextTip'),

    writingKana: $('#writingKana'),
    writingRomaji: $('#writingRomaji'),
    writingIndex: $('#writingIndex'),
    writingGuide: $('#writingGuide'),
    writingPaper: $('#writingPaper'),
    writingCanvas: $('#writingCanvas'),
    writingPrev: $('#writingPrev'),
    writingNext: $('#writingNext'),
    writingRandom: $('#writingRandom'),
    undoStroke: $('#undoStroke'),
    clearCanvas: $('#clearCanvas'),
    toggleGuide: $('#toggleGuide'),
    playWriting: $('#playWriting'),
    saveWriting: $('#saveWriting'),

    ringHiragana: $('#ringHiragana'),
    ringKatakana: $('#ringKatakana'),
    hiraganaMastered: $('#hiraganaMastered'),
    katakanaMastered: $('#katakanaMastered'),
    hiraganaCore: $('#hiraganaCore'),
    katakanaCore: $('#katakanaCore'),
    hiraganaVoiced: $('#hiraganaVoiced'),
    katakanaVoiced: $('#katakanaVoiced'),
    hiraganaYoon: $('#hiraganaYoon'),
    katakanaYoon: $('#katakanaYoon'),
    overallMastery: $('#overallMastery'),
    barSeion: $('#barSeion'),
    barVoiced: $('#barVoiced'),
    barYoon: $('#barYoon'),
    barSeionText: $('#barSeionText'),
    barVoicedText: $('#barVoicedText'),
    barYoonText: $('#barYoonText'),
    statStreak: $('#statStreak'),
    statBestStreak: $('#statBestStreak'),
    statAnswered: $('#statAnswered'),
    statMastered: $('#statMastered'),
    heatmap: $('#heatmap'),
    reviewCount: $('#reviewCount'),
    reviewList: $('#reviewList'),
    resetProgress: $('#resetProgress'),

    kanaDialog: $('#kanaDialog'),
    dialogClose: $('#dialogClose'),
    dialogGroup: $('#dialogGroup'),
    dialogKana: $('#dialogKana'),
    dialogRomaji: $('#dialogRomaji'),
    dialogPlay: $('#dialogPlay'),
    dialogCounterpart: $('#dialogCounterpart'),
    dialogKicker: $('#dialogKicker'),
    dialogTitle: $('#dialogTitle'),
    dialogNote: $('#dialogNote'),
    dialogWord: $('#dialogWord'),
    dialogMaster: $('#dialogMaster'),
    dialogWrite: $('#dialogWrite'),

    toast: $('#toast'),
    confettiCanvas: $('#confettiCanvas')
  };

  /* ── UI state (not persisted) ──────────────────────── */
  let heroId = 'a';
  let dailyItem = seionItems[0];
  let tipIndex = 0;
  let activeDialogItem = null;
  let activeDialogScript = 'hiragana';
  let activeWord = null;
  let toastTimer = 0;
  let resetTimer = 0;
  let resetConfirming = false;
  let currentAudio = null;
  let speechVoices = [];

  /* ── Small helpers ─────────────────────────────────── */
  function showToast(message, duration = 2300) {
    if (!el.toast) return;
    window.clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => {
      el.toast.classList.remove('is-visible');
    }, duration);
  }

  function shuffle(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function currentScriptName() {
    return isHiragana(store.script) ? '平假名' : '片假名';
  }

  function updateThemeButton() {
    const dark = document.documentElement.dataset.theme === 'dark';
    if (!el.themeToggle) return;
    el.themeToggle.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
    el.themeToggle.title = dark ? '切换到浅色模式' : '切换到深色模式';
    if (el.themeColor) el.themeColor.setAttribute('content', dark ? '#141a16' : '#f4efe4');
  }

  function setTheme(theme, persist = true) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = normalized;
    updateThemeButton();
    if (persist) {
      try { localStorage.setItem(THEME_KEY, normalized); } catch (error) { /* ignore */ }
    }
  }

  function getStreak() {
    const today = new Date();
    const todayK = todayKey(today);
    let cursor = new Date(today);
    if (!store.activity[todayK]) {
      cursor = shiftDate(today, -1);
      if (!store.activity[todayKey(cursor)]) return 0;
    }
    let streak = 0;
    while (store.activity[todayKey(cursor)] && streak < 3650) {
      streak += 1;
      cursor = shiftDate(cursor, -1);
    }
    return streak;
  }

  /* ── Audio ─────────────────────────────────────────── */
  function pickJapaneseVoice() {
    if (!('speechSynthesis' in window)) return null;
    if (!speechVoices.length) speechVoices = window.speechSynthesis.getVoices();
    return speechVoices.find((voice) => /^ja(-|_)?/i.test(voice.lang)) || null;
  }

  if ('speechSynthesis' in window) {
    speechVoices = window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', () => {
      speechVoices = window.speechSynthesis.getVoices();
    });
  }

  function speakText(text, rate = 0.82) {
    if (!('speechSynthesis' in window)) {
      showToast('这个浏览器暂时不支持语音朗读。');
      return false;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickJapaneseVoice();
      if (voice) utterance.voice = voice;
      utterance.lang = 'ja-JP';
      utterance.rate = rate;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      showToast('语音播放失败，请稍后再试。');
      return false;
    }
  }

  function playKana(item, options = {}) {
    if (!item) return;
    const script = options.script || store.script;
    const char = charOf(item, script);
    let fellBack = false;

    function fallback() {
      if (fellBack) return;
      fellBack = true;
      speakText(char);
    }

    /* 复用同一个 Audio 元素。iOS Safari 对同时存在的媒体元素数量有硬性上限，
       每次 new Audio() 却不释放，会在用户连续点击上百次之后静默失效。
       onerror 用赋值而非 addEventListener，避免重复播放时监听器累积。 */
    const audio = currentAudio || (currentAudio = new Audio());
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.preload = 'auto';
      audio.volume = 0.92;
      audio.onerror = fallback;
      audio.src = `audio/${item.id}.m4a`;
      const result = audio.play();
      if (result && typeof result.catch === 'function') {
        result.catch(fallback);
      }
    } catch (error) {
      fallback();
    }

    if (!options.skipActivity) {
      // markDaily 内部已经写入，这里不再重复 saveStore()。
      markDaily('listen');
      recordActivity('listen');
    }

    if (options.onPlay) options.onPlay();
  }

  function playWord(word) {
    if (!word || !word.kana) return;
    speakText(word.kana, 0.76);
  }

  /* ── Activity / daily ──────────────────────────────── */
  function ensureDaily() {
    const today = todayKey();
    if (!store.daily || store.daily.date !== today) {
      store.daily = freshDaily();
      saveStore();
      renderDailyItem();
      renderDailyTasks();
    }
  }

  function markDaily(task) {
    ensureDaily();
    if (store.daily[task]) return false;
    store.daily[task] = true;
    saveStore();
    renderDailyTasks();
    return true;
  }

  function recordActivity(kind) {
    ensureDaily();
    const key = todayKey();
    store.activity[key] = (store.activity[key] || 0) + 1;
    saveStore();
    renderHeatmap();
    renderStats();
    if (kind === 'quiz') markDaily('quiz');
  }

  function renderDailyTasks() {
    ensureDaily();
    let done = 0;
    el.dailyTasks.forEach((task) => {
      const name = task.dataset.task;
      const isDone = Boolean(store.daily[name]);
      task.classList.toggle('is-done', isDone);
      if (isDone) done += 1;
    });
    el.dailyTaskCount.textContent = `${done} / 3`;
  }

  /* ── Ribbon ────────────────────────────────────────── */
  function renderRibbon() {
    if (!el.ribbon) return;
    const chars = seionItems.map((item) => charOf(item, store.script));
    const content = chars.map((char) => `<span>${char}</span><i>·</i>`).join('');
    el.ribbon.innerHTML = content + content;
  }

  /* ── Hero ──────────────────────────────────────────── */
  function renderHero() {
    const item = itemMap.get(heroId) || itemMap.get('a');
    const char = charOf(item, store.script);
    const row = rowLabelOf(item, store.script);
    el.heroKana.textContent = char;
    el.heroRomaji.textContent = item.r;
    el.heroRowLabel.textContent = `01 / ${row} · A ROW`;
    const heroScriptLabel = $('#heroScriptLabel');
    if (heroScriptLabel) {
      heroScriptLabel.textContent = isHiragana(store.script) ? 'HIRAGANA · ひらがな' : 'KATAKANA · カタカナ';
    }
    el.heroKanaButton.setAttribute('aria-label', `播放 ${char} 的发音`);
    el.heroPlay.setAttribute('aria-label', `播放 ${char} 的发音`);

    const vowels = ['a', 'i', 'u', 'e', 'o'];
    el.heroVowels.innerHTML = vowels.map((id) => {
      const vowel = itemMap.get(id);
      return `<button class="hero-vowel${vowel.id === heroId ? ' is-active' : ''}" type="button" data-id="${vowel.id}" aria-pressed="${vowel.id === heroId}" aria-label="选择 ${charOf(vowel, store.script)}">${charOf(vowel, store.script)}</button>`;
    }).join('');
  }

  function animateHeroKana() {
    el.heroKana.classList.remove('is-pop');
    void el.heroKana.offsetWidth;
    el.heroKana.classList.add('is-pop');
  }

  function selectHero(id, withAudio = false) {
    if (!itemMap.has(id)) return;
    heroId = id;
    const item = itemMap.get(id);
    el.heroKana.textContent = charOf(item, store.script);
    el.heroRomaji.textContent = item.r;
    el.heroKanaButton.setAttribute('aria-label', `播放 ${charOf(item, store.script)} 的发音`);
    el.heroPlay.setAttribute('aria-label', `播放 ${charOf(item, store.script)} 的发音`);
    $$('.hero-vowel', el.heroVowels).forEach((button) => {
      const active = button.dataset.id === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    animateHeroKana();
    if (withAudio) playKana(item);
  }

  /* ── Chart ─────────────────────────────────────────── */
  function renderChart() {
    const group = store.group;
    const items = DATA.items.filter((item) => item.group === group);
    const rows = DATA.rows[group] || [];
    const isYoon = group === 'yoon';
    const cols = isYoon ? 3 : 5;
    const colLabels = isYoon ? DATA.columns.yoon : DATA.columns.five;
    const smallMarks = isHiragana(store.script) ? ['ゃ', 'ゅ', 'ょ'] : ['ャ', 'ュ', 'ョ'];
    let html = '<span class="col-spacer" aria-hidden="true"></span>';

    colLabels.forEach((label, index) => {
      if (isYoon) {
        html += `<span class="col-head col-head-yoon" aria-hidden="true"><span>${smallMarks[index]}</span><small>${label}</small></span>`;
      } else {
        html += `<span class="col-head" aria-hidden="true">${label}</span>`;
      }
    });

    rows.forEach((row) => {
      const rowItems = items.filter((item) => item.row === row.key).sort((a, b) => a.col - b.col);
      html += `<span class="row-label" aria-hidden="true">${isHiragana(store.script) ? row.h : row.k}</span>`;

      if (group === 'seion' && row.key === 'n') {
        const nItem = rowItems[0];
        html += kanaCellHTML(nItem);
        html += `<div class="chart-note"><strong>${isHiragana(store.script) ? 'ん' : 'ン'}</strong><span>拨音 · 单独成拍，不发元音<br>读音会随前后音变化</span></div>`;
        return;
      }

      for (let col = 0; col < cols; col += 1) {
        const item = rowItems.find((candidate) => candidate.col === col);
        html += item ? kanaCellHTML(item) : '<div class="chart-gap" aria-hidden="true"></div>';
      }
    });

    el.kanaChart.innerHTML = html;
    el.kanaChart.classList.toggle('is-yoon', isYoon);
    el.kanaChart.classList.toggle('hide-romaji', !store.showRomaji);
    el.kanaChart.setAttribute('role', 'group');
    el.kanaChart.setAttribute('aria-label', `${currentScriptName()}${GROUP_LABELS[group]}表`);

    const groupMeta = DATA.groups.find((entry) => entry.id === group);
    if (group === 'yoon' && !isHiragana(store.script)) {
      el.chartHint.textContent = 'イ段假名 + 小写的 ャ / ュ / ョ，两个假名合成一拍。';
    } else {
      el.chartHint.textContent = groupMeta ? groupMeta.hint : '';
    }
    el.chartTotal.textContent = String(items.length);
    el.chartMastered.textContent = String(countMastered(store.script, group));

    el.groupButtons.forEach((button) => {
      const active = button.dataset.group === group;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    el.scriptButtons.forEach((button) => {
      const active = button.dataset.script === store.script;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    el.romajiToggle.checked = store.showRomaji;
  }

  function kanaCellHTML(item) {
    const char = charOf(item, store.script);
    const long = Array.from(char).length > 1;
    const mastered = isMastered(store.script, item.id);
    const row = rowLabelOf(item, store.script);
    return `<button class="kana-cell${mastered ? ' is-mastered' : ''}${long ? ' is-long' : ''}" type="button" data-id="${item.id}" aria-label="${char}，读音 ${item.r}，${GROUP_LABELS[item.group]}${row}${mastered ? '，已掌握' : ''}">
      <span class="kana-char">${char}</span>
      <span class="kana-romaji">${item.r}</span>
      ${mastered ? '<span class="cell-check" aria-hidden="true">✓</span>' : ''}
    </button>`;
  }

  function syncChartMastery() {
    $$('.kana-cell', el.kanaChart).forEach((button) => {
      const item = itemMap.get(button.dataset.id);
      if (!item) return;
      const mastered = isMastered(store.script, item.id);
      button.classList.toggle('is-mastered', mastered);
      const label = `${charOf(item, store.script)}，读音 ${item.r}，${GROUP_LABELS[item.group]}${rowLabelOf(item, store.script)}${mastered ? '，已掌握' : ''}`;
      button.setAttribute('aria-label', label);
      let check = $('.cell-check', button);
      if (mastered && !check) {
        check = document.createElement('span');
        check.className = 'cell-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = '✓';
        button.appendChild(check);
      } else if (!mastered && check) {
        check.remove();
      }
    });
    if (el.kanaChart) {
      el.chartMastered.textContent = String(countMastered(store.script, store.group));
    }
  }

  function highlightCell(id) {
    const cell = $(`.kana-cell[data-id="${id}"]`, el.kanaChart);
    if (!cell) return;
    cell.classList.remove('is-listening');
    void cell.offsetWidth;
    cell.classList.add('is-listening');
    window.setTimeout(() => cell.classList.remove('is-listening'), 1100);
  }

  /* ── Script switching ──────────────────────────────── */
  function setScript(script) {
    if (script !== 'hiragana' && script !== 'katakana') return;
    const changed = store.script !== script;
    store.script = script;
    saveStore();
    el.scriptButtons.forEach((button) => {
      const active = button.dataset.script === script;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    renderRibbon();
    renderChart();
    renderHero();
    renderDailyItem();
    renderWriting(false);
    renderReview();
    if (changed) {
      clearStrokes();
    }
  }

  function setGroup(group) {
    if (!ALL_GROUPS.includes(group)) return;
    store.group = group;
    saveStore();
    renderChart();
  }

  /* ── Daily card ────────────────────────────────────── */
  function renderDailyItem() {
    const now = new Date();
    el.dailyDate.textContent = `${pad(now.getMonth() + 1)} / ${pad(now.getDate())}`;
    const seed = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 86400000);
    const offset = isHiragana(store.script) ? 0 : 7;
    dailyItem = seionItems[(seed + offset) % seionItems.length];
    const char = charOf(dailyItem, store.script);
    const word = isHiragana(store.script) ? dailyItem.exH : dailyItem.exK;
    el.dailyKana.textContent = char;
    el.dailyKanaButton.setAttribute('aria-label', `播放今日一音 ${char}`);
    el.dailyWordKana.textContent = word ? word.kana : char;
    el.dailyWordMeaning.textContent = word ? word.meaning : '';
  }

  /* ── Detail dialog ─────────────────────────────────── */
  function dialogNoteFor(item, script) {
    if (item.note) return item.note;
    const group = item.group;
    const char = charOf(item, script);
    if (group === 'yoon') {
      return `这是一个拗音：${char[0]} 加上小写的 ${char[1]}，两个假名合成一拍来读。`;
    }
    if (group === 'dakuon') {
      return `浊音：在清音假名的右上角加上浊点「゛」，声带振动，读作 ${item.r}。`;
    }
    if (group === 'handakuon') {
      return `半浊音：在は行假名的右上角加上半浊点「゜」，读作 ${item.r}。`;
    }
    return `${char} 属于${rowLabelOf(item, script)}。点击听一听，再跟着读两遍。`;
  }

  function openDetail(id) {
    const item = itemMap.get(id);
    if (!item) return;
    activeDialogItem = item;
    activeDialogScript = store.script;
    const script = activeDialogScript;
    const char = charOf(item, script);
    const counterpart = charOf(item, isHiragana(script) ? 'katakana' : 'hiragana');
    const word = isHiragana(script) ? item.exH : item.exK;
    const row = rowLabelOf(item, script);

    activeWord = word || null;
    el.dialogGroup.textContent = `${script === 'hiragana' ? '平假名' : '片假名'} · ${row}`;
    el.dialogKana.textContent = char;
    el.dialogKana.classList.toggle('is-long', Array.from(char).length > 1);
    el.dialogRomaji.textContent = item.r + (item.altR ? ` / ${item.altR}` : '');
    el.dialogCounterpart.textContent = counterpart;
    el.dialogKicker.textContent = `${script === 'hiragana' ? 'HIRAGANA' : 'KATAKANA'} · ${GROUP_LABELS[item.group]}`;
    el.dialogTitle.innerHTML = `${escapeHTML(char)} <span>${escapeHTML(item.r)}</span>`;
    el.dialogNote.textContent = dialogNoteFor(item, script);
    el.dialogPlay.setAttribute('aria-label', `播放 ${char} 的发音`);

    if (word) {
      el.dialogWord.classList.remove('dialog-word-empty');
      el.dialogWord.innerHTML = `
        <div class="dialog-word-head">
          <span>例词</span>
          <button class="icon-button mini-icon-button" id="dialogWordPlay" type="button" aria-label="播放例词">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
          </button>
        </div>
        <div class="dialog-word-main">
          <strong>${escapeHTML(word.kana)}</strong>
          ${word.kanji ? `<span>${escapeHTML(word.kanji)}</span>` : ''}
        </div>
        <p>${escapeHTML(word.meaning)}</p>`;
      const wordPlay = $('#dialogWordPlay');
      if (wordPlay) wordPlay.addEventListener('click', () => playWord(activeWord));
    } else {
      el.dialogWord.classList.add('dialog-word-empty');
      el.dialogWord.innerHTML = '<div class="dialog-word-empty-inner"><span>例词</span><p>这个组合在常用词里不太常见，先记住它的拼读方式吧。</p></div>';
    }

    updateDialogMasterButton();
    if (typeof el.kanaDialog.showModal === 'function') {
      el.kanaDialog.showModal();
    } else {
      el.kanaDialog.setAttribute('open', '');
    }
    window.setTimeout(() => el.dialogClose.focus(), 80);
  }

  function updateDialogMasterButton() {
    if (!el.dialogMaster) return;
    if (!activeDialogItem) {
      el.dialogMaster.textContent = '标记为已掌握';
      return;
    }
    const mastered = isMastered(activeDialogScript, activeDialogItem.id);
    el.dialogMaster.textContent = mastered ? '已掌握 · 点击取消' : '标记为已掌握';
    el.dialogMaster.classList.toggle('is-mastered', mastered);
    el.dialogMaster.setAttribute('aria-pressed', String(mastered));
  }

  function closeDialog() {
    if (typeof el.kanaDialog.close === 'function') {
      el.kanaDialog.close();
    } else {
      el.kanaDialog.removeAttribute('open');
    }
  }

  /* ── Writing canvas ────────────────────────────────── */
  const canvas = el.writingCanvas;
  const ctx = canvas ? canvas.getContext('2d') : null;
  let strokes = [];
  let activeStroke = null;
  let drawing = false;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let guideVisible = true;

  function currentWritingIndex() {
    return Math.max(0, DATA.items.findIndex((item) => item.id === store.writingId));
  }

  function currentWritingItem() {
    return itemMap.get(store.writingId) || DATA.items[0];
  }

  function renderWriting(resetCanvas = true) {
    const item = currentWritingItem();
    const script = store.script;
    const char = charOf(item, script);
    const index = currentWritingIndex();
    el.writingKana.textContent = char;
    el.writingKana.classList.toggle('is-long', Array.from(char).length > 1);
    el.writingRomaji.textContent = item.r;
    el.writingIndex.textContent = String(index + 1).padStart(2, '0');
    el.writingGuide.textContent = char;
    el.writingGuide.classList.toggle('is-long', Array.from(char).length > 1);
    el.playWriting.setAttribute('aria-label', `播放 ${char} 的发音`);
    if (resetCanvas) {
      strokes = [];
      activeStroke = null;
      requestAnimationFrame(redrawCanvas);
    }
  }

  function setWritingItem(id, options = {}) {
    if (!itemMap.has(id)) return;
    store.writingId = id;
    saveStore();
    renderWriting(true);
    if (options.scroll) {
      setTimeout(() => {
        $('#write').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      }, 80);
    }
  }

  function stepWriting(direction) {
    const items = DATA.items;
    let index = currentWritingIndex();
    index = (index + direction + items.length) % items.length;
    setWritingItem(items[index].id);
  }

  function getCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    return { rect, dpr };
  }

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    const { rect, dpr } = getCanvasSize();
    if (!rect.width || !rect.height) return;
    canvasWidth = rect.width;
    canvasHeight = rect.height;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawCanvas();
  }

  function strokeBaseWidth() {
    return Math.max(6, canvasWidth * 0.025);
  }

  function drawPoint(point) {
    if (!ctx) return;
    const width = strokeBaseWidth() * point.w;
    ctx.beginPath();
    ctx.arc(point.x * canvasWidth, point.y * canvasHeight, Math.max(1, width / 2), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(28, 35, 28, 0.92)';
    ctx.fill();
  }

  function drawSegment(from, to) {
    if (!ctx) return;
    const x1 = from.x * canvasWidth;
    const y1 = from.y * canvasHeight;
    const x2 = to.x * canvasWidth;
    const y2 = to.y * canvasHeight;
    const width = strokeBaseWidth() * ((from.w + to.w) / 2);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = 'rgba(28, 35, 28, 0.92)';
    ctx.lineWidth = Math.max(1.5, width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawStrokeOn(context, stroke, width, height) {
    const points = stroke.points;
    if (!points.length) return;
    const base = Math.max(3, width * 0.025);
    context.strokeStyle = 'rgba(28, 35, 28, 0.92)';
    context.fillStyle = 'rgba(28, 35, 28, 0.92)';
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (points.length === 1) {
      context.beginPath();
      context.arc(points[0].x * width, points[0].y * height, base * points[0].w / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    for (let i = 1; i < points.length; i += 1) {
      const from = points[i - 1];
      const to = points[i];
      context.beginPath();
      context.moveTo(from.x * width, from.y * height);
      context.lineTo(to.x * width, to.y * height);
      context.lineWidth = Math.max(1.5, base * ((from.w + to.w) / 2));
      context.stroke();
    }
  }

  function redrawCanvas() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    strokes.forEach((stroke) => drawStrokeOn(ctx, stroke, canvasWidth, canvasHeight));
    if (activeStroke && activeStroke.points.length > 1) {
      drawStrokeOn(ctx, activeStroke, canvasWidth, canvasHeight);
    } else if (activeStroke && activeStroke.points.length === 1) {
      drawPoint(activeStroke.points[0]);
    }
  }

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    let pressure = event.pressure;
    if (!pressure || event.pointerType === 'mouse') pressure = 0.52;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: 0.58 + pressure * 0.72
    };
  }

  function beginStroke(event) {
    if (!ctx || event.button > 0) return;
    event.preventDefault();
    drawing = true;
    canvas.setPointerCapture?.(event.pointerId);
    const point = pointFromEvent(event);
    activeStroke = { points: [point] };
    drawPoint(point);
  }

  function moveStroke(event) {
    if (!drawing || !activeStroke) return;
    event.preventDefault();
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    events.forEach((rawEvent) => {
      const point = pointFromEvent(rawEvent);
      const previous = activeStroke.points[activeStroke.points.length - 1];
      if (!previous) {
        activeStroke.points.push(point);
        drawPoint(point);
        return;
      }
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      if (distance < 0.0018) return;
      // Faster strokes become slightly thinner, like a brush.
      point.w *= Math.max(0.72, 1 - Math.min(distance * 7, 0.3));
      activeStroke.points.push(point);
      drawSegment(previous, point);
    });
  }

  function commitActiveStroke() {
    if (!activeStroke || !activeStroke.points.length) {
      activeStroke = null;
      return;
    }
    strokes.push(activeStroke);
    activeStroke = null;
    redrawCanvas();
    // 「今天的三件小事」只在首次书写时点亮，但每一笔都要计入热力图与连续天数，
    // 所以 recordActivity 不能放在 markDaily 的返回值判断里。
    markDaily('write');
    recordActivity('write');
  }

  function endStroke(event) {
    if (!drawing) return;
    drawing = false;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    commitActiveStroke();
  }

  function clearStrokes() {
    strokes = [];
    activeStroke = null;
    drawing = false;
    redrawCanvas();
  }

  function toggleGuide() {
    guideVisible = !guideVisible;
    el.writingPaper.classList.toggle('guide-off', !guideVisible);
    el.toggleGuide.setAttribute('aria-pressed', String(guideVisible));
  }

  function saveWritingImage() {
    if (!canvas) return;
    const item = currentWritingItem();
    const char = charOf(item, store.script);
    const size = 1200;
    const output = document.createElement('canvas');
    output.width = size;
    output.height = size;
    const outCtx = output.getContext('2d');

    outCtx.fillStyle = '#fbf7ec';
    outCtx.fillRect(0, 0, size, size);

    // Outer frame
    outCtx.strokeStyle = 'rgba(62, 66, 54, 0.13)';
    outCtx.lineWidth = 1;
    outCtx.strokeRect(size * 0.055, size * 0.055, size * 0.89, size * 0.89);

    // Grid
    outCtx.save();
    outCtx.strokeStyle = 'rgba(177, 102, 81, 0.22)';
    outCtx.setLineDash([6, 6]);
    outCtx.beginPath();
    outCtx.moveTo(size / 2, 0);
    outCtx.lineTo(size / 2, size);
    outCtx.moveTo(0, size / 2);
    outCtx.lineTo(size, size / 2);
    outCtx.stroke();
    outCtx.setLineDash([]);
    outCtx.strokeStyle = 'rgba(62, 66, 54, 0.08)';
    outCtx.strokeRect(size * 0.12, size * 0.12, size * 0.76, size * 0.76);
    outCtx.beginPath();
    outCtx.moveTo(size * 0.12, size * 0.12);
    outCtx.lineTo(size * 0.88, size * 0.88);
    outCtx.moveTo(size * 0.88, size * 0.12);
    outCtx.lineTo(size * 0.12, size * 0.88);
    outCtx.stroke();
    outCtx.restore();

    // Guide glyph
    outCtx.save();
    outCtx.fillStyle = 'rgba(47, 51, 41, 0.11)';
    outCtx.textAlign = 'center';
    outCtx.textBaseline = 'middle';
    outCtx.font = `${Array.from(char).length > 1 ? 570 : 790}px "Yu Mincho", "Hiragino Mincho ProN", "Songti SC", serif`;
    outCtx.fillText(char, size / 2, size * 0.53);
    outCtx.restore();

    // Strokes
    strokes.forEach((stroke) => drawStrokeOn(outCtx, stroke, size, size));

    // Signature
    outCtx.fillStyle = 'rgba(177, 69, 52, 0.68)';
    outCtx.font = '22px "Hiragino Mincho ProN", "Songti SC", serif';
    outCtx.textAlign = 'right';
    outCtx.fillText('かなの庭', size - 62, size - 54);
    outCtx.font = '15px "Avenir Next", "PingFang SC", sans-serif';
    outCtx.fillStyle = 'rgba(62, 66, 54, 0.42)';
    outCtx.textAlign = 'left';
    outCtx.fillText(`KANA GARDEN · ${item.r}`, 62, size - 54);

    const link = document.createElement('a');
    link.download = `kana-garden-${store.script}-${item.id}.png`;
    link.href = output.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('字帖已保存到下载文件夹。');
  }

  /* ── Progress ──────────────────────────────────────── */
  function setRing(element, value, total) {
    if (!element) return;
    const ratio = Math.max(0, Math.min(1, value / total));
    element.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
    element.style.opacity = ratio > 0 ? '1' : '0';
  }

  function renderStats() {
    el.statStreak.textContent = String(getStreak());
    el.statBestStreak.textContent = String(store.stats.bestStreak || 0);
    el.statAnswered.textContent = String(store.stats.answered || 0);
    el.statMastered.textContent = String(totalMastered());
    el.bestScore.textContent = String(store.stats.bestScore || 0);
  }

  function renderHeatmap() {
    if (!el.heatmap) return;
    const today = new Date();
    const cells = [];
    let activeDays = 0;
    for (let i = 27; i >= 0; i -= 1) {
      const date = shiftDate(today, -i);
      const key = todayKey(date);
      const count = store.activity[key] || 0;
      if (count) activeDays += 1;
      const level = count === 0 ? 0 : count < 3 ? 1 : count < 8 ? 2 : 3;
      cells.push(`<i class="heat-cell level-${level}${i === 0 ? ' is-today' : ''}" title="${date.getMonth() + 1}月${date.getDate()}日 · ${count} 次练习"></i>`);
    }
    el.heatmap.innerHTML = cells.join('');
    el.heatmap.setAttribute('aria-label', `最近 28 天，共 ${activeDays} 天有练习`);
  }

  function renderReview() {
    if (!el.reviewList) return;
    const reviewCard = el.reviewList.closest('.review-card');
    const prefix = scriptPrefix(store.script);
    const entries = Object.entries(store.mistakes)
      .filter(([key]) => key.startsWith(`${prefix}:`))
      .map(([key, count]) => ({ item: itemMap.get(key.split(':')[1]), count }))
      .filter((entry) => entry.item)
      .sort((a, b) => b.count - a.count);

    el.reviewCount.textContent = `${entries.length} 个`;
    if (reviewCard) reviewCard.classList.toggle('is-empty', entries.length === 0);
    if (!entries.length) {
      el.reviewList.innerHTML = '<div class="review-empty"><i>✓</i><span>还没有需要复习的假名。<br>去小测里认一认它们吧。</span></div>';
      return;
    }
    el.reviewList.innerHTML = entries.map(({ item, count }) => {
      const char = charOf(item, store.script);
      return `<button class="review-chip" type="button" data-id="${item.id}" title="答错 ${count} 次" aria-label="${char}，${item.r}，答错 ${count} 次，点击查看">${char}<small>${item.r}</small></button>`;
    }).join('');
  }

  function refreshProgressUI() {
    const hiraCore = countMastered('hiragana', 'seion');
    const kataCore = countMastered('katakana', 'seion');
    const hiraVoiced = countMastered('hiragana', ['dakuon', 'handakuon']);
    const kataVoiced = countMastered('katakana', ['dakuon', 'handakuon']);
    const hiraYoon = countMastered('hiragana', 'yoon');
    const kataYoon = countMastered('katakana', 'yoon');
    const total = totalMastered();

    setRing(el.ringHiragana, hiraCore, 46);
    setRing(el.ringKatakana, kataCore, 46);
    el.hiraganaMastered.textContent = String(hiraCore);
    el.katakanaMastered.textContent = String(kataCore);
    el.hiraganaCore.textContent = String(hiraCore);
    el.katakanaCore.textContent = String(kataCore);
    el.hiraganaVoiced.textContent = String(hiraVoiced);
    el.katakanaVoiced.textContent = String(kataVoiced);
    el.hiraganaYoon.textContent = String(hiraYoon);
    el.katakanaYoon.textContent = String(kataYoon);
    el.overallMastery.textContent = `${total} / ${TOTAL_CHARS}`;
    el.navCount.textContent = String(total);

    const seionTotal = countMastered('hiragana', 'seion') + countMastered('katakana', 'seion');
    const voicedTotal = hiraVoiced + kataVoiced;
    const yoonTotal = hiraYoon + kataYoon;
    el.barSeion.style.width = `${(seionTotal / 92) * 100}%`;
    el.barVoiced.style.width = `${(voicedTotal / 50) * 100}%`;
    el.barYoon.style.width = `${(yoonTotal / 66) * 100}%`;
    el.barSeionText.textContent = `${seionTotal} / 92`;
    el.barVoicedText.textContent = `${voicedTotal} / 50`;
    el.barYoonText.textContent = `${yoonTotal} / 66`;

    renderStats();
    renderHeatmap();
    renderReview();
    syncChartMastery();
  }

  function resetProgress() {
    store.mastered = [];
    masteredSet = new Set();
    store.mistakes = {};
    store.stats = { ...defaultStats };
    store.activity = {};
    store.daily = freshDaily();
    saveStore();
    refreshProgressUI();
    renderChart();
    renderDailyTasks();
    renderStats();
    closeDialog();
    resetQuizIntro();
    showToast('学习进度已清空，重新开始吧。');
  }

  /* ── Quiz ──────────────────────────────────────────── */
  const quiz = {
    active: false,
    mode: 'read',
    range: 'seion',
    script: 'hiragana',
    questions: [],
    index: 0,
    score: 0,
    streak: 0,
    selected: null,
    missed: []
  };

  const RANGE_LABELS = { seion: '清音', voiced: '浊音 · 半浊', yoon: '拗音', all: '全部' };

  function revealQuizPanel(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const tooHigh = rect.top < 90;
    const tooLow = rect.top > window.innerHeight * 0.56;
    if (tooHigh || tooLow) {
      panel.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'start'
      });
    }
  }

  function bottomSafeSpace() {
    const dock = document.querySelector('.mobile-dock');
    if (!dock || getComputedStyle(dock).display === 'none') return 24;
    const rect = dock.getBoundingClientRect();
    if (!rect.height) return 24;
    return Math.max(24, window.innerHeight - rect.top + 12);
  }

  function quizPool(range) {
    const groups = range === 'seion'
      ? ['seion']
      : range === 'voiced'
        ? ['dakuon', 'handakuon']
        : range === 'yoon'
          ? ['yoon']
          : ALL_GROUPS;
    return DATA.items.filter((item) => groups.includes(item.group));
  }

  function setQuizChoice(kind, value) {
    if (kind === 'mode') {
      store.quizMode = value === 'listen' ? 'listen' : 'read';
    } else {
      store.quizRange = value;
    }
    saveStore();
    syncQuizChoices();
  }

  function syncQuizChoices() {
    $$('.choice', el.quizModes).forEach((button) => {
      const active = button.dataset.mode === store.quizMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $$('.choice', el.quizRanges).forEach((button) => {
      const active = button.dataset.range === store.quizRange;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    el.bestScore.textContent = String(store.stats.bestScore || 0);
    if (el.quizIntroTitle) {
      el.quizIntroTitle.innerHTML = store.quizMode === 'listen'
        ? '听一听，<br>认出它的名字。'
        : '看字，<br>认出它的读音。';
    }
  }

  /* 一个假名的全部可能读音。「ぢ」与「じ」同为 ji、「づ」与「ず」同为 zu、
     「を」与「お」同为 o，数据里用 r / altR 两个字段表达这种同音关系。 */
  const soundsOf = (entry) => new Set([entry.r, entry.altR].filter(Boolean));

  /* 挑 3 个干扰项。两种玩法的「重复」判据不同：
     看字选音比的是罗马音文本，听音选字比的是发音，所以分开处理。 */
  function pickDistractors(pool, item, mode) {
    const candidates = shuffle(pool.filter((candidate) => candidate.id !== item.id));

    if (mode === 'read') {
      // 选项是罗马音文本，只要 r 不重复，就不会出现两个一模一样的选项。
      const used = new Set([item.r]);
      return candidates.filter((candidate) => {
        if (used.has(candidate.r)) return false;
        used.add(candidate.r);
        return true;
      }).slice(0, 3);
    }

    // 选项是假名，字形一定各不相同，但「じ/ぢ」「ず/づ」「お/を」发音完全一致。
    // 干扰项既不能和答案同音（否则一道题有两个正确答案），彼此之间也不该同音。
    const used = [soundsOf(item)];
    return candidates.filter((candidate) => {
      const sounds = soundsOf(candidate);
      const clash = used.some((taken) => [...sounds].some((sound) => taken.has(sound)));
      if (clash) return false;
      used.push(sounds);
      return true;
    }).slice(0, 3);
  }

  function buildQuestions(pool, mode) {
    const source = shuffle(pool);
    return source.slice(0, Math.min(10, source.length)).map((item) => {
      const distractors = pickDistractors(pool, item, mode);
      const options = shuffle([
        { id: item.id, item, label: mode === 'read' ? item.r : charOf(item, quiz.script), correct: true },
        ...distractors.map((candidate) => ({
          id: candidate.id,
          item: candidate,
          label: mode === 'read' ? candidate.r : charOf(candidate, quiz.script),
          correct: false
        }))
      ]);
      return { item, options };
    });
  }

  function startQuiz() {
    const mode = store.quizMode;
    const range = store.quizRange;
    const pool = quizPool(range);
    if (pool.length < 4) {
      showToast('这个范围里的假名太少啦，换一个试试。');
      return;
    }
    quiz.active = true;
    quiz.mode = mode;
    quiz.range = range;
    quiz.script = store.script;
    quiz.questions = buildQuestions(pool, mode);
    quiz.index = 0;
    quiz.score = 0;
    quiz.streak = 0;
    quiz.selected = null;
    quiz.missed = [];

    el.quizIntro.hidden = true;
    el.quizResult.hidden = true;
    el.quizGame.hidden = false;
    el.quizFeedback.textContent = '';
    el.quizNext.hidden = true;
    renderQuestion(true);
  }

  function currentQuestion() {
    return quiz.questions[quiz.index];
  }

  function renderQuestion(autoPlay = false) {
    const question = currentQuestion();
    if (!question) return;
    const item = question.item;
    const char = charOf(item, quiz.script);
    quiz.selected = null;
    el.quizCounter.textContent = `第 ${quiz.index + 1} / ${quiz.questions.length} 题`;
    el.quizScore.textContent = String(quiz.score);
    el.quizStreak.textContent = String(quiz.streak);
    el.quizProgressBar.style.width = `${((quiz.index + 1) / quiz.questions.length) * 100}%`;
    el.quizModeLabel.textContent = quiz.mode === 'read' ? '看字选音' : '听音选字';
    el.quizRangeLabel.textContent = RANGE_LABELS[quiz.range] || '清音';
    el.quizFeedback.textContent = '';
    el.quizNext.hidden = true;
    el.quizNext.innerHTML = quiz.index === quiz.questions.length - 1
      ? '查看结果 <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
      : '下一题 <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

    if (quiz.mode === 'read') {
      el.quizPrompt.textContent = '这个假名怎么读？';
      el.quizDisplay.innerHTML = `
        <span class="quiz-kana-large${Array.from(char).length > 1 ? ' is-long' : ''}">${char}</span>
        <span class="quiz-kana-sub">${quiz.script === 'hiragana' ? 'HIRAGANA' : 'KATAKANA'} · ${GROUP_LABELS[item.group]}</span>`;
    } else {
      el.quizPrompt.textContent = '听发音，选出对应的假名。';
      el.quizDisplay.innerHTML = `
        <button class="quiz-speaker" id="quizSpeak" type="button" aria-label="重新播放发音">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg>
        </button>
        <span class="quiz-kana-sub">点击重听 · 按 R 重播</span>`;
    }

    el.quizOptions.innerHTML = question.options.map((option, index) => (
      `<button class="quiz-option${quiz.mode === 'listen' ? ' is-kana' : ''}" type="button" data-index="${index}">
        <span class="option-key">${index + 1}</span>${escapeHTML(option.label)}
      </button>`
    )).join('');

    if (quiz.mode === 'listen' && autoPlay) {
      playQuizSound();
    }

    if (autoPlay) {
      requestAnimationFrame(() => {
        if (!quiz.active) return;
        revealQuizPanel(el.quizGame);
        el.quizPrompt.focus({ preventScroll: true });
      });
    }
  }

  function playQuizSound() {
    if (!quiz.active) return;
    const question = currentQuestion();
    if (!question) return;
    playKana(question.item, { script: quiz.script });
    const speaker = $('#quizSpeak');
    if (speaker) {
      speaker.classList.remove('is-playing');
      void speaker.offsetWidth;
      speaker.classList.add('is-playing');
    }
  }

  function answerQuestion(index) {
    if (!quiz.active || quiz.selected !== null) return;
    const question = currentQuestion();
    if (!question || !question.options[index]) return;
    quiz.selected = index;
    const chosen = question.options[index];
    const correct = Boolean(chosen.correct);
    const item = question.item;
    const char = charOf(item, quiz.script);
    const key = masteryKey(quiz.script, item.id);

    const buttons = $$('.quiz-option', el.quizOptions);
    buttons.forEach((button, buttonIndex) => {
      button.disabled = true;
      if (question.options[buttonIndex].correct) button.classList.add('is-correct');
      else if (buttonIndex === index) button.classList.add('is-wrong');
      else button.classList.add('is-dimmed');
    });

    store.stats.answered += 1;
    if (correct) {
      store.stats.correct += 1;
      quiz.score += 1;
      quiz.streak += 1;
      store.stats.bestStreak = Math.max(store.stats.bestStreak, quiz.streak);
      const newlyMastered = !masteredSet.has(key);
      if (newlyMastered) {
        masteredSet.add(key);
      }
      if (store.mistakes[key]) delete store.mistakes[key];
      el.quizFeedback.innerHTML = `<strong>正解</strong> · ${char} 读作 ${item.r}${newlyMastered ? ' · 已收入掌握' : ''}`;
    } else {
      quiz.streak = 0;
      store.mistakes[key] = (store.mistakes[key] || 0) + 1;
      if (!quiz.missed.some((missed) => missed.id === item.id)) quiz.missed.push(item);
      el.quizFeedback.innerHTML = `<strong>再记一次</strong> · ${char} 读作 ${item.r}`;
    }

    el.quizScore.textContent = String(quiz.score);
    el.quizStreak.textContent = String(quiz.streak);
    el.quizNext.hidden = false;
    saveStore();
    syncChartMastery();
    refreshProgressUI();
    el.quizNext.focus({ preventScroll: true });
    const nextRect = el.quizNext.getBoundingClientRect();
    const safeBottom = bottomSafeSpace();
    if (nextRect.bottom > window.innerHeight - safeBottom || nextRect.top < 90) {
      const delta = nextRect.bottom - (window.innerHeight - safeBottom);
      window.scrollBy({
        top: Math.max(delta + 8, -40),
        behavior: reducedMotion ? 'auto' : 'smooth'
      });
    }
  }

  function nextQuestion() {
    if (!quiz.active || quiz.selected === null) return;
    if (quiz.index >= quiz.questions.length - 1) {
      finishQuiz();
      return;
    }
    quiz.index += 1;
    renderQuestion(true);
  }

  function finishQuiz() {
    quiz.active = false;
    quiz.selected = null;
    store.stats.bestScore = Math.max(store.stats.bestScore, quiz.score);
    saveStore();

    el.quizGame.hidden = true;
    el.quizResult.hidden = false;
    el.resultScore.textContent = String(quiz.score);
    el.resultRing.style.setProperty('--score', String(quiz.score * 10));

    let title = '慢慢来，也很好。';
    let message = '每一道题，都在把假名变熟悉。';
    if (quiz.score === 10) {
      title = '满分。全部认出来了。';
      message = '十个音，一个不差。记得明天回来再听一遍。';
    } else if (quiz.score >= 8) {
      title = '很稳，只差一点点。';
      message = '你已经听出节奏了。把错过的音再读两遍，就更牢了。';
    } else if (quiz.score >= 6) {
      title = '已经找到感觉了。';
      message = '大部分音都认得出来。错题会留在下方，随时回来看。';
    } else if (quiz.score >= 4) {
      title = '再读一遍，就会更熟。';
      message = '不用着急。先挑两三个错题，慢慢读出声。';
    }
    el.resultTitle.textContent = title;
    el.resultMessage.textContent = message;

    if (quiz.missed.length) {
      el.resultMissedList.innerHTML = quiz.missed.map((item) => (
        `<button class="result-kana-chip" type="button" data-id="${item.id}">${charOf(item, quiz.script)}<small>${item.r}</small></button>`
      )).join('');
    } else {
      el.resultMissedList.innerHTML = '<span class="result-perfect">全对 · 没有错题</span>';
    }

    // 同一天的第 2 轮及以后也要计入热力图，因此无条件记录
    //（recordActivity 内部会自行 markDaily('quiz') 点亮每日任务）。
    recordActivity('quiz');
    refreshProgressUI();
    renderChart();
    requestAnimationFrame(() => {
      revealQuizPanel(el.quizResult);
      el.resultTitle.focus({ preventScroll: true });
    });
    if (quiz.score >= 8) window.setTimeout(launchConfetti, 260);
  }

  function resetQuizIntro(focusStart = false) {
    quiz.active = false;
    quiz.selected = null;
    el.quizIntro.hidden = false;
    el.quizGame.hidden = true;
    el.quizResult.hidden = true;
    syncQuizChoices();
    if (focusStart) {
      requestAnimationFrame(() => el.startQuiz.focus({ preventScroll: true }));
    }
  }

  /* ── Confetti ──────────────────────────────────────── */
  let confettiFrame = 0;

  function launchConfetti() {
    if (reducedMotion) return;
    const canvas = el.confettiCanvas;
    if (!canvas) return;
    window.cancelAnimationFrame(confettiFrame);
    const ctx2 = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = ['#b94230', '#e39a84', '#3b5a49', '#b78b52', '#f4efe4', '#9cb9a6'];
    const particles = Array.from({ length: 90 }, () => ({
      x: width / 2 + (Math.random() - 0.5) * 180,
      y: height * 0.44 + (Math.random() - 0.5) * 80,
      vx: (Math.random() - 0.5) * 10,
      vy: -Math.random() * 9 - 2,
      size: Math.random() * 7 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      life: 1
    }));

    const started = performance.now();
    function frame(now) {
      const elapsed = now - started;
      ctx2.clearRect(0, 0, width, height);
      particles.forEach((particle) => {
        particle.vy += 0.16;
        particle.vx *= 0.995;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.rotation += particle.spin;
        particle.life = Math.max(0, 1 - Math.max(0, elapsed - 900) / 1700);
        ctx2.save();
        ctx2.translate(particle.x, particle.y);
        ctx2.rotate(particle.rotation);
        ctx2.globalAlpha = particle.life;
        ctx2.fillStyle = particle.color;
        ctx2.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.6);
        ctx2.restore();
      });
      if (elapsed < 2800) {
        confettiFrame = requestAnimationFrame(frame);
      } else {
        ctx2.clearRect(0, 0, width, height);
      }
    }
    confettiFrame = requestAnimationFrame(frame);
  }

  /* ── Tips ──────────────────────────────────────────── */
  function setTip(index, animate = false) {
    tipIndex = ((index % DATA.tips.length) + DATA.tips.length) % DATA.tips.length;
    if (!animate) {
      el.tipText.textContent = DATA.tips[tipIndex];
      return;
    }
    el.tipText.style.opacity = '0';
    el.tipText.style.transform = 'translateY(5px)';
    window.setTimeout(() => {
      el.tipText.textContent = DATA.tips[tipIndex];
      el.tipText.style.opacity = '1';
      el.tipText.style.transform = 'translateY(0)';
    }, 160);
  }

  /* ── Scroll reveal & nav ───────────────────────────── */
  function setupReveals() {
    const reveals = $$('.reveal');
    if (!('IntersectionObserver' in window) || reducedMotion) {
      reveals.forEach((element) => element.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    reveals.forEach((element) => observer.observe(element));
  }

  let navLinks = [];
  let currentNavId = undefined;

  function setActiveNav(id) {
    // 滚动时会被反复调用，状态没变就直接跳过，省掉整轮 DOM 查询与写入。
    if (id === currentNavId) return;
    currentNavId = id;
    navLinks.forEach((link) => {
      const active = link.dataset.nav === id;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }

  function setupNavObserver() {
    if (!('IntersectionObserver' in window)) return;
    const sections = ['chart', 'practice', 'write', 'progress']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) setActiveNav(entry.target.id);
      });
    }, { rootMargin: '-24% 0px -62% 0px', threshold: 0 });
    sections.forEach((section) => observer.observe(section));
  }

  /* #chart 的位置是静态的，不需要每个 scroll 事件都重新测量：
     读 offsetTop 会强制同步布局，而它紧跟在写 class 之后，属于典型的读写交替抖动。 */
  let chartSection = null;
  let chartOffsetTop = 0;

  function measureChart() {
    chartSection = document.getElementById('chart');
    chartOffsetTop = chartSection ? chartSection.offsetTop : 0;
  }

  function updateHeader() {
    // 先把所有布局读数取完，再统一写 DOM。
    const scrolled = window.scrollY > 18;
    const beforeChart = !chartSection || window.scrollY < chartOffsetTop - 280;
    el.header.classList.toggle('scrolled', scrolled);
    if (beforeChart) setActiveNav(null);
  }

  /* ── Event wiring ──────────────────────────────────── */
  function wireEvents() {
    navLinks = $$('[data-nav]');
    window.addEventListener('resize', measureChart);
    window.addEventListener('scroll', updateHeader, { passive: true });
    // 先测量再首次更新：刷新时浏览器可能恢复滚动位置，
    // 若此时 chartSection 还是 null，会把导航高亮误清空。
    measureChart();
    updateHeader();

    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });

    // Hero
    el.heroKanaButton.addEventListener('click', () => {
      playKana(itemMap.get(heroId), { onPlay: animateHeroKana });
    });
    el.heroPlay.addEventListener('click', () => {
      playKana(itemMap.get(heroId), { onPlay: animateHeroKana });
    });
    el.heroVowels.addEventListener('click', (event) => {
      const button = event.target.closest('.hero-vowel');
      if (!button) return;
      selectHero(button.dataset.id, true);
    });

    // Script + group
    el.scriptButtons.forEach((button) => {
      button.addEventListener('click', () => setScript(button.dataset.script));
    });
    el.groupTabs.addEventListener('click', (event) => {
      const button = event.target.closest('.group-btn');
      if (!button) return;
      setGroup(button.dataset.group);
    });

    el.romajiToggle.addEventListener('change', () => {
      store.showRomaji = el.romajiToggle.checked;
      saveStore();
      el.kanaChart.classList.toggle('hide-romaji', !store.showRomaji);
    });

    el.randomKana.addEventListener('click', () => {
      const pool = DATA.items.filter((item) => item.group === store.group);
      if (!pool.length) return;
      const item = pool[Math.floor(Math.random() * pool.length)];
      playKana(item);
      highlightCell(item.id);
      showToast(`${charOf(item, store.script)} · ${item.r}`);
    });

    el.kanaChart.addEventListener('click', (event) => {
      const button = event.target.closest('.kana-cell');
      if (!button) return;
      openDetail(button.dataset.id);
    });

    // Daily card
    el.dailyKanaButton.addEventListener('click', () => {
      playKana(dailyItem);
    });

    el.nextTip.addEventListener('click', () => setTip(tipIndex + 1, true));

    // Writing
    $('#writingPrev').addEventListener('click', () => stepWriting(-1));
    $('#writingNext').addEventListener('click', () => stepWriting(1));
    $('#writingRandom').addEventListener('click', () => {
      let next = store.writingId;
      while (next === store.writingId && DATA.items.length > 1) {
        next = DATA.items[Math.floor(Math.random() * DATA.items.length)].id;
      }
      setWritingItem(next);
    });
    el.playWriting.addEventListener('click', () => playKana(currentWritingItem()));
    el.undoStroke.addEventListener('click', () => {
      if (!strokes.length) return;
      strokes.pop();
      redrawCanvas();
    });
    el.clearCanvas.addEventListener('click', () => clearStrokes());
    el.toggleGuide.addEventListener('click', toggleGuide);
    el.saveWriting.addEventListener('click', saveWritingImage);

    if (canvas && ctx) {
      canvas.addEventListener('pointerdown', beginStroke);
      canvas.addEventListener('pointermove', moveStroke);
      canvas.addEventListener('pointerup', endStroke);
      canvas.addEventListener('pointercancel', endStroke);
      canvas.addEventListener('lostpointercapture', () => {
        if (drawing) {
          drawing = false;
          commitActiveStroke();
        }
      });
      canvas.addEventListener('pointerleave', (event) => {
        if (drawing && event.buttons === 0) endStroke(event);
      });
      if ('ResizeObserver' in window) {
        const observer = new ResizeObserver(() => resizeCanvas());
        observer.observe(el.writingPaper);
      } else {
        window.addEventListener('resize', resizeCanvas);
      }
    }

    // Review
    el.reviewList.addEventListener('click', (event) => {
      const chip = event.target.closest('.review-chip');
      if (chip) openDetail(chip.dataset.id);
    });

    // Reset progress: two taps to avoid accidents
    el.resetProgress.addEventListener('click', () => {
      if (!resetConfirming) {
        resetConfirming = true;
        el.resetProgress.classList.add('is-confirming');
        el.resetProgress.textContent = '再点一次，确认清空';
        window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          resetConfirming = false;
          el.resetProgress.classList.remove('is-confirming');
          el.resetProgress.textContent = '重置全部学习进度';
        }, 4000);
        return;
      }
      window.clearTimeout(resetTimer);
      resetConfirming = false;
      el.resetProgress.classList.remove('is-confirming');
      el.resetProgress.textContent = '重置全部学习进度';
      resetProgress();
    });

    // Quiz
    el.quizModes.addEventListener('click', (event) => {
      const button = event.target.closest('.choice');
      if (!button) return;
      setQuizChoice('mode', button.dataset.mode);
    });
    el.quizRanges.addEventListener('click', (event) => {
      const button = event.target.closest('.choice');
      if (!button) return;
      setQuizChoice('range', button.dataset.range);
    });
    el.startQuiz.addEventListener('click', startQuiz);
    el.quizOptions.addEventListener('click', (event) => {
      const button = event.target.closest('.quiz-option');
      if (!button) return;
      answerQuestion(Number(button.dataset.index));
    });
    el.quizDisplay.addEventListener('click', (event) => {
      if (event.target.closest('#quizSpeak')) playQuizSound();
    });
    el.quizNext.addEventListener('click', nextQuestion);
    el.quizExit.addEventListener('click', () => {
      if (!quiz.active) return;
      resetQuizIntro(true);
      showToast('已结束本轮，答过的题已经记录。');
    });
    el.quizAgain.addEventListener('click', startQuiz);
    el.quizReset.addEventListener('click', () => resetQuizIntro(true));
    el.resultMissedList.addEventListener('click', (event) => {
      const chip = event.target.closest('.result-kana-chip');
      if (chip) openDetail(chip.dataset.id);
    });

    // Dialog
    el.dialogClose.addEventListener('click', closeDialog);
    el.dialogPlay.addEventListener('click', () => {
      if (activeDialogItem) playKana(activeDialogItem, { script: activeDialogScript });
    });
    el.dialogMaster.addEventListener('click', () => {
      if (!activeDialogItem) return;
      const nowMastered = !isMastered(activeDialogScript, activeDialogItem.id);
      setMastered(activeDialogScript, activeDialogItem.id, nowMastered);
      updateDialogMasterButton();
      showToast(nowMastered ? `已掌握 ${charOf(activeDialogItem, activeDialogScript)}` : `已取消掌握 ${charOf(activeDialogItem, activeDialogScript)}`);
    });
    el.dialogWrite.addEventListener('click', () => {
      if (!activeDialogItem) return;
      setWritingItem(activeDialogItem.id, { scroll: true });
      closeDialog();
    });
    el.kanaDialog.addEventListener('click', (event) => {
      if (event.target === el.kanaDialog) closeDialog();
    });
    el.kanaDialog.addEventListener('close', () => {
      activeDialogItem = null;
      activeWord = null;
    });

    // Keyboard quiz controls
    document.addEventListener('keydown', (event) => {
      if (!quiz.active) return;
      if (el.kanaDialog.open) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest('input, textarea, select')) return;
      if (/^[1-4]$/.test(event.key) && quiz.selected === null) {
        event.preventDefault();
        const button = $(`.quiz-option[data-index="${Number(event.key) - 1}"]`, el.quizOptions);
        if (button) button.click();
      } else if ((event.key === 'r' || event.key === 'R') && quiz.mode === 'listen') {
        event.preventDefault();
        playQuizSound();
      } else if (event.key === 'Enter' && quiz.selected !== null) {
        if (!event.target.closest('button, a')) {
          event.preventDefault();
          nextQuestion();
        }
      }
    });

    // Tabbing into the writing area shouldn't be blocked.
    window.addEventListener('blur', () => {
      if (!drawing) return;
      drawing = false;
      commitActiveStroke();
    });
  }

  /* ── Boot ──────────────────────────────────────────── */
  function init() {
    setTheme(document.documentElement.dataset.theme || 'light', false);
    ensureDaily();
    renderRibbon();
    renderChart();
    renderHero();
    renderDailyItem();
    renderDailyTasks();
    renderWriting(true);
    refreshProgressUI();
    syncQuizChoices();
    setTip(Math.floor(Date.now() / 86400000) % DATA.tips.length);
    wireEvents();
    setupReveals();
    setupNavObserver();
    updateHeader();
    saveStore();

    requestAnimationFrame(() => {
      resizeCanvas();
      // 首帧布局确定后再测一次，避免 reveal 动画与画布尺寸影响位置。
      measureChart();
    });

    // Persist a first open so the header count and rings settle consistently.
    updateThemeButton();

    // If the system theme changes while the user hasn't chosen one, follow it.
    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const handleThemeChange = (event) => {
        let saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (error) { /* ignore */ }
        if (saved !== 'dark' && saved !== 'light') {
          setTheme(event.matches ? 'dark' : 'light', false);
        }
      };
      if (typeof media.addEventListener === 'function') media.addEventListener('change', handleThemeChange);
    }
  }

  init();
})();
