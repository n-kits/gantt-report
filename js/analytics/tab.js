/*
 * Вкладка «Аналитика» на главной: корешки «Лента / Аналитика», загрузка analytics.json из ветки data
 * (сборщик: publish_analytics в tools/collector/collect.py), расшифровка паролем живой ленты, проверка раз в 5 минут.
 *
 * Данные можно подменить: ?analytics-data=<url> (для локальной проверки).
 */
(function (root) {
  'use strict';

  const L = root.GanttLive;
  const A = root.GanttAnalytics;
  if (!L || !A) return;
  const POLL_MS = 5 * 60 * 1000;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* не критично */ } },
  };
  const params = new URLSearchParams(location.search);
  store.set('gantt-analytics.on', null);             // флаг времён проверки (?analytics=1) больше не нужен

  const url = params.get('analytics-data') || L.dataUrl.replace(/[^/]*$/, '') + 'analytics.json';
  const $ = id => document.getElementById(id);
  const tabs = $('tabs'), msg = $('an-msg');
  let visible = false, envelope = null, shownAt = null, busy = false;

  function say(text, kind) {
    msg.textContent = text || '';
    msg.className = 'an-msg' + (kind ? ' ' + kind : '');
    msg.hidden = !text;
  }

  // --- данные ---------------------------------------------------------------
  async function load(force) {
    if (!visible || busy) return;
    busy = true;
    try {
      try {
        const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
        if (r.status === 404) { say('Данные аналитики ещё не опубликованы — они появятся после следующего запуска сборщика.', 'warn'); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        envelope = await r.json();
      } catch (e) {
        if (!shownAt) say(`Не удалось загрузить данные аналитики: ${e.message}`, 'error');
        return;                                      // нет сети — оставляем то, что уже показано
      }
      if (!force && shownAt === envelope.generatedAt) return;
      const password = L.password();
      if (!password) { say('Введите пароль в строке живых данных выше — аналитика зашифрована тем же паролем.', 'warn'); return; }
      let payload;
      try {
        payload = await L.decrypt(envelope.enc, password);
      } catch (e) {
        say(e.name === 'OperationError' ? 'Пароль не подходит к данным аналитики — введите его заново в строке живых данных.'
          : `Не удалось открыть данные аналитики: ${e.message}`, 'error');
        return;
      }
      say('');
      shownAt = envelope.generatedAt;
      // сначала показать содержимое, потом рисовать: в скрытом блоке у графиков нулевая ширина
      $('panel-analytics').classList.remove('an-wait');
      A.setData(payload);
    } finally {
      busy = false;
    }
  }

  // --- вкладки --------------------------------------------------------------
  let current = null;
  function route() {
    const tab = location.hash === '#analytics' ? 'analytics' : 'timeline';
    // сменили вкладку (в том числе «← Лента» из глубины аналитики) — к началу страницы
    if (current && current !== tab) scrollTo(0, 0);
    current = tab;
    ['timeline', 'analytics'].forEach(k => {
      $('tab-' + k).setAttribute('aria-selected', String(k === tab));
      $('panel-' + k).hidden = k !== tab;
    });
    // календарик, загрузка файла и подпись под заголовком относятся к ленте
    document.querySelector('.banner .toolbar').hidden = tab !== 'timeline';
    $('subtitle').hidden = tab !== 'timeline';
    visible = tab === 'analytics';
    A.setVisible(visible);
    if (visible) load(false);
    else dispatchEvent(new Event('resize'));        // карта под лентой могла пропустить изменение размера, пока была скрыта
  }

  tabs.hidden = false;
  // «← Лента» парит, только когда корешки вкладок ушли за верх экрана — пока они видны, кнопка не нужна
  const back = document.querySelector('.an-back');
  const syncBack = () => { back.hidden = tabs.getBoundingClientRect().bottom > 0; };
  addEventListener('scroll', syncBack, { passive: true });
  syncBack();
  A.mount();
  addEventListener('hashchange', route);
  document.addEventListener('gantt-live-password', () => load(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(false); });
  setInterval(() => load(false), POLL_MS);
  route();
})(window);
