/*
 * «Живой» режим: зашифрованные данные, которые сборщик (tools/collector/collect.py)
 * публикует в ветку data. Страница забирает файл, расшифровывает общим паролем
 * (WebCrypto: PBKDF2-SHA256 → AES-GCM) и перестраивает ленту; проверка — раз в 5 минут.
 *
 * Адрес данных можно переопределить: ?data=<url> (для локальной проверки).
 */
(function (root) {
  'use strict';

  const M = root.GanttModel;
  const App = root.GanttApp;
  const DEFAULT_URL = 'https://raw.githubusercontent.com/n-kits/gantt-report/data/live.json';
  const POLL_MS = 5 * 60 * 1000;
  const PASS_KEY = 'gantt-live.pass';
  const OFF_KEY = 'gantt-live.off';   // '1' — загружен файл; иначе подпись показанного периода архива

  const dataUrl = new URLSearchParams(location.search).get('data') || DEFAULT_URL;

  const el = {
    bar: document.getElementById('live'),
    text: document.getElementById('live-text'),
    back: document.getElementById('live-back'),
    form: document.getElementById('live-pass'),
    pass: document.getElementById('live-pass-input'),
    passMsg: document.getElementById('live-pass-msg'),
  };

  let envelope = null;     // последний полученный файл
  let shownKey = null;     // какие данные сейчас на экране (dataAt)

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* не критично */ } },
  };

  // --- расшифровка ----------------------------------------------------------
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function decrypt(enc, password) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(enc.salt), iterations: enc.iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(enc.iv) }, key, unb64(enc.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // --- время ----------------------------------------------------------------
  const pad2 = n => String(n).padStart(2, '0');
  const fmtTime = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  // --- статус ---------------------------------------------------------------
  function statusMessage(env) {
    const at = fmtTime(env.dataAt);
    if (env.status === 'login_required') {
      return [`Сборщик не может войти в Bitrix — показаны данные на ${at}.`, 'warn'];
    }
    if (env.status === 'error') {
      return [`Ошибка сборщика (${env.message || 'неизвестно'}) — показаны данные на ${at}.`, 'warn'];
    }
    const age = Date.now() - new Date(env.generatedAt).getTime();
    const limit = (2 * (env.intervalMin || 60) + 10) * 60 * 1000;
    if (age > limit) {
      return [`Данные не обновлялись с ${fmtTime(env.generatedAt)} — вероятно, выключен компьютер со сборщиком.`, 'warn'];
    }
    return ['', ''];
  }

  function renderBar() {
    if (!envelope) { el.bar.hidden = true; return; }
    el.bar.hidden = false;
    const offVal = store.get(OFF_KEY);
    const off = !!offVal;
    const needPass = !off && !store.get(PASS_KEY);
    el.form.hidden = !needPass;
    el.back.hidden = !off;
    el.bar.classList.toggle('ok', !off && envelope.status === 'ok');
    el.text.textContent = off
      ? (offVal === '1' ? 'Показан загруженный файл.' : offVal)
      : `Живые данные Bitrix · на ${fmtTime(envelope.dataAt)} · обновление раз в ${envelope.intervalMin || 60} мин`;
  }

  // --- загрузка -------------------------------------------------------------
  async function fetchEnvelope() {
    const sep = dataUrl.includes('?') ? '&' : '?';
    const r = await fetch(`${dataUrl}${sep}t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function show(force) {
    if (!envelope || !envelope.enc || store.get(OFF_KEY)) return;
    const password = store.get(PASS_KEY);
    if (!password) { renderBar(); return; }
    if (!force && shownKey === envelope.dataAt && App.kind === 'live') {
      App.showMsg(...statusMessage(envelope));
      return;
    }
    let payload;
    try {
      payload = await decrypt(envelope.enc, password);
    } catch (e) {
      store.set(PASS_KEY, null);
      renderBar();
      el.passMsg.textContent = 'Неверный пароль — введите ещё раз.';
      return;
    }
    shownKey = envelope.dataAt;
    const now = M.parseDt(payload.now) || new Date(envelope.dataAt);
    App.loadRows(payload.rows, payload.sourceName || envelope.source, now, 'live');
    // анализ через LLM выключен в сборщике — карту и таблицу не показываем, пока его не включат
    const geo = payload.geo && payload.geo.llm !== false ? payload.geo : null;
    if (root.GanttMap) root.GanttMap.show(geo, now);
    if (root.GanttGeoTable && geo) {
      root.GanttGeoTable.mount(document.getElementById('geo-table'), root.GanttGeoTable.fromLive(geo, payload.rows));
    }
    App.showMsg(...statusMessage(envelope));
  }

  async function poll(force) {
    try {
      envelope = await fetchEnvelope();
    } catch (e) {
      // данных нет (ветка data ещё не создана) или нет сети — работаем как раньше, с файлами
      if (!envelope) { renderBar(); return; }
    }
    renderBar();
    await show(force);
  }

  // --- события --------------------------------------------------------------
  el.form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = el.pass.value;
    if (!v) return;
    el.passMsg.textContent = '';
    store.set(PASS_KEY, v);
    el.pass.value = '';
    renderBar();
    await show(true);
  });
  el.back.addEventListener('click', () => {
    store.set(OFF_KEY, null);
    renderBar();
    show(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll(false);
  });
  setInterval(() => poll(false), POLL_MS);

  root.GanttLive = {
    // пользователь загрузил свой файл — не перебиваем его живыми данными
    onFileLoaded() {
      if (!envelope) return;
      store.set(OFF_KEY, '1');
      if (root.GanttMap) root.GanttMap.hide();
      App.showMsg('');
      renderBar();
    },
    // показан период из архива (js/archive.js) — живые данные не перебивают его, пока не вернутся к ним
    onArchiveShown(label) {
      store.set(OFF_KEY, label);
      if (root.GanttMap) root.GanttMap.hide();
      renderBar();
    },
    password: () => store.get(PASS_KEY),
    dataUrl,
    decrypt,
  };

  poll(true);
})(window);
