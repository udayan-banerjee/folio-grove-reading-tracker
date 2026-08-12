(function () {
  'use strict';

  /* ------------------------------------------------------------ constants */

  var STORAGE_KEYS = {
    books: 'folioGrove.books',
    prefs: 'folioGrove.prefs'
  };

  var DEFAULT_PREFS = {
    view: 'card',
    filter: 'all',
    sort: 'added',
    period: 'any'    // 'any' | 'none' | 'year:2026' | 'month:2026-03'
  };

  var DAY_MS = 24 * 60 * 60 * 1000;

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

  var PERIOD_PATTERN = /^(any|none|year:\d{4}|month:\d{4}-\d{2})$/;

  var STATUS_LABELS = {
    reading: 'Reading',
    finished: 'Finished',
    dnf: 'DNF',
    toread: 'To Read'
  };

  var VIEWS = ['card', 'list'];
  var FILTERS = ['all', 'reading', 'finished', 'toread', 'dnf'];

  var SORTERS = {
    added: function (a, b) { return b.createdAt - a.createdAt; },
    title: function (a, b) {
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    },
    rating: function (a, b) {
      return compareMaybe(a.rating, b.rating, true) || SORTERS.title(a, b);
    },
    pages: function (a, b) {
      return compareMaybe(a.pages, b.pages, true) || SORTERS.title(a, b);
    },
    started: function (a, b) {
      var av = a.startDate ? parseISODate(a.startDate) : null;
      var bv = b.startDate ? parseISODate(b.startDate) : null;
      return compareMaybe(av, bv, true) || SORTERS.title(a, b);
    }
  };

  /* ---------------------------------------------------------------- state */

  var books = [];
  var prefs = Object.assign({}, DEFAULT_PREFS);
  var editingId = null;      // id of the book open in the form, null when adding
  var pendingDeleteId = null;
  var draftRating = null;    // rating held by the star widget while the form is open
  var lastFocused = null;    // element to restore focus to when a dialog closes

  /* ------------------------------------------------------------------ dom */

  var dom = {};

  function cacheDom() {
    dom.addBtn = document.getElementById('add-book-btn');
    dom.emptyAction = document.getElementById('empty-action');

    dom.statTotal = document.getElementById('stat-total');
    dom.statReading = document.getElementById('stat-reading');
    dom.statFinished = document.getElementById('stat-finished');
    dom.statDnf = document.getElementById('stat-dnf');
    dom.statPages = document.getElementById('stat-pages');
    dom.storageNotice = document.getElementById('storage-notice');

    dom.filters = document.querySelectorAll('[data-filter]');
    dom.counts = document.querySelectorAll('[data-count]');
    dom.sortSelect = document.getElementById('sort-select');
    dom.viewButtons = document.querySelectorAll('[data-view]');
    dom.periodSelect = document.getElementById('period-select');
    dom.periodClear = document.getElementById('period-clear');

    dom.collection = document.getElementById('collection');
    dom.grid = document.getElementById('book-grid');
    dom.tableWrap = document.getElementById('book-table-wrap');
    dom.tbody = document.getElementById('book-tbody');
    dom.emptyState = document.getElementById('empty-state');
    dom.emptyTitle = document.getElementById('empty-title');
    dom.emptyText = document.getElementById('empty-text');

    dom.bookDialog = document.getElementById('book-dialog');
    dom.bookForm = document.getElementById('book-form');
    dom.dialogTitle = document.getElementById('book-dialog-title');
    dom.dialogSub = document.getElementById('book-dialog-sub');
    dom.saveBtn = document.getElementById('book-save');
    dom.cancelBtn = document.getElementById('book-cancel');

    dom.fieldTitle = document.getElementById('field-title');
    dom.fieldStart = document.getElementById('field-start');
    dom.fieldFinish = document.getElementById('field-finish');
    dom.fieldPages = document.getElementById('field-pages');
    dom.fieldDnf = document.getElementById('field-dnf');

    dom.errorTitle = document.getElementById('error-title');
    dom.errorFinish = document.getElementById('error-finish');
    dom.errorPages = document.getElementById('error-pages');

    dom.starGroup = document.getElementById('star-group');
    dom.stars = dom.starGroup.querySelectorAll('.star');
    dom.clearRating = document.getElementById('clear-rating');

    dom.deleteDialog = document.getElementById('delete-dialog');
    dom.deleteText = document.getElementById('delete-text');
    dom.deleteCancel = document.getElementById('delete-cancel');
    dom.deleteConfirm = document.getElementById('delete-confirm');

    dom.liveRegion = document.getElementById('live-region');
  }

  /* -------------------------------------------------------------- helpers */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'bk_' + window.crypto.randomUUID();
    }
    return 'bk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /* Sorts null/undefined to the end regardless of direction. */
  function compareMaybe(a, b, descending) {
    var aMissing = (a === null || a === undefined);
    var bMissing = (b === null || b === undefined);
    if (aMissing && bMissing) { return 0; }
    if (aMissing) { return 1; }
    if (bMissing) { return -1; }
    return descending ? b - a : a - b;
  }

  function announce(message) {
    dom.liveRegion.textContent = '';
    // Re-setting on the next frame makes repeat messages announce again.
    window.requestAnimationFrame(function () {
      dom.liveRegion.textContent = message;
    });
  }

  function showStorageNotice(message) {
    dom.storageNotice.textContent = message;
    dom.storageNotice.hidden = false;
  }

  /* -------------------------------------------------- dates & derivations */

  function parseISODate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) { return null; }
    var parts = value.split('-');
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var day = Number(parts[2]);
    var stamp = Date.UTC(year, month - 1, day);
    var date = new Date(stamp);
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) {
      return null;
    }
    return stamp;
  }

  function formatDate(value) {
    var stamp = parseISODate(value);
    if (stamp === null) { return null; }
    var date = new Date(stamp);
    return MONTHS[date.getUTCMonth()] + ' ' + date.getUTCDate() + ', ' + date.getUTCFullYear();
  }

  /* ------------------------------------------------ start-date filtering */

  function matchesPeriod(book) {
    var period = prefs.period;
    if (!period || period === 'any') { return true; }
    if (period === 'none') { return !book.startDate; }
    if (!book.startDate) { return false; }
    if (period.indexOf('year:') === 0) { return book.startDate.slice(0, 4) === period.slice(5); }
    if (period.indexOf('month:') === 0) { return book.startDate.slice(0, 7) === period.slice(6); }
    return true;
  }

  function isPeriodActive() {
    return Boolean(prefs.period) && prefs.period !== 'any';
  }

  /* Reads back as a phrase: "started in March 2026". */
  function describePeriod() {
    if (prefs.period === 'none') { return 'without a start date'; }
    if (prefs.period.indexOf('year:') === 0) { return 'started in ' + prefs.period.slice(5); }
    if (prefs.period.indexOf('month:') === 0) {
      return 'started in ' + formatMonth(prefs.period.slice(6));
    }
    return '';
  }

  /* "2026-03" -> "March 2026" */
  function formatMonth(value) {
    var parts = value.split('-');
    return MONTHS_FULL[Number(parts[1]) - 1] + ' ' + parts[0];
  }

  function updatePeriodOptions() {
    var years = [];
    var months = [];

    books.forEach(function (book) {
      if (!book.startDate) { return; }
      var year = book.startDate.slice(0, 4);
      var month = book.startDate.slice(0, 7);
      if (years.indexOf(year) === -1) { years.push(year); }
      if (months.indexOf(month) === -1) { months.push(month); }
    });

    years.sort().reverse();
    months.sort().reverse();

    dom.periodSelect.querySelectorAll('optgroup').forEach(function (group) { group.remove(); });

    if (years.length) {
      var yearGroup = document.createElement('optgroup');
      yearGroup.label = 'Year';
      years.forEach(function (year) {
        var option = el('option', null, year);
        option.value = 'year:' + year;
        yearGroup.appendChild(option);
      });
      dom.periodSelect.appendChild(yearGroup);
    }

    if (months.length) {
      var monthGroup = document.createElement('optgroup');
      monthGroup.label = 'Month';
      months.forEach(function (month) {
        var option = el('option', null, formatMonth(month));
        option.value = 'month:' + month;
        monthGroup.appendChild(option);
      });
      dom.periodSelect.appendChild(monthGroup);
    }

    dom.periodSelect.value = prefs.period;
    if (dom.periodSelect.value !== prefs.period) {
      prefs.period = 'any';
      dom.periodSelect.value = 'any';
      savePrefs();
    }
    syncPeriodControls();
  }

  function syncPeriodControls() {
    dom.periodSelect.value = prefs.period;
    dom.periodSelect.classList.toggle('is-set', isPeriodActive());
    dom.periodClear.hidden = !isPeriodActive();
  }

  /* DNF wins over everything, so a set-aside book is never shown as finished. */
  function getStatus(book) {
    if (book.dnf) { return 'dnf'; }
    if (book.finishDate) { return 'finished'; }
    if (book.startDate) { return 'reading'; }
    return 'toread';
  }

  /* Inclusive day count: started and finished on the same day is 1 day. */
  function calculateDaysRead(book) {
    var start = parseISODate(book.startDate);
    var finish = parseISODate(book.finishDate);
    if (start === null || finish === null) { return null; }
    var days = Math.round((finish - start) / DAY_MS) + 1;
    return days > 0 ? days : null;
  }

  function calculatePagesPerDay(book) {
    var days = calculateDaysRead(book);
    if (days === null || !book.pages || book.pages <= 0) { return null; }
    return Math.round((book.pages / days) * 10) / 10;
  }

  /* One decimal place only when it carries information: 30, not 30.0. */
  function formatDecimal(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  function formatCount(value, singular, plural) {
    return value + ' ' + (value === 1 ? singular : plural);
  }

  /* ------------------------------------------------------------- coercion */

  function toPageCount(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1) { return null; }
    return number;
  }

  function toRating(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number)) { return null; }
    if (number < 1 || number > 5) { return null; }
    return number;
  }

  /* Rebuilds a trustworthy book from whatever was in storage. Returns null
     for entries that can't be salvaged (no usable title). */
  function normalizeBook(raw) {
    if (!raw || typeof raw !== 'object') { return null; }

    var title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) { return null; }

    var startDate = parseISODate(raw.startDate) !== null ? raw.startDate : '';
    var finishDate = parseISODate(raw.finishDate) !== null ? raw.finishDate : '';

    return {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : createId(),
      title: title.slice(0, 200),
      startDate: startDate,
      finishDate: finishDate,
      pages: toPageCount(raw.pages),
      rating: toRating(raw.rating),
      dnf: raw.dnf === true,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
    };
  }

  /* -------------------------------------------------------------- storage */

  function loadBooks() {
    var stored;
    try {
      stored = window.localStorage.getItem(STORAGE_KEYS.books);
    } catch (error) {
      showStorageNotice('This browser is blocking local storage, so your shelf can’t be saved between visits.');
      return [];
    }
    if (!stored) { return []; }

    var parsed;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      showStorageNotice('Saved book data couldn’t be read and was skipped.');
      return [];
    }
    if (!Array.isArray(parsed)) { return []; }

    var result = [];
    parsed.forEach(function (raw) {
      var book = normalizeBook(raw);
      if (book) { result.push(book); }
    });
    return result;
  }

  function saveBooks() {
    try {
      window.localStorage.setItem(STORAGE_KEYS.books, JSON.stringify(books));
    } catch (error) {
      showStorageNotice('Your changes are showing here but couldn’t be saved to this browser.');
    }
  }

  function loadPrefs() {
    var result = Object.assign({}, DEFAULT_PREFS);
    var stored;
    try {
      stored = window.localStorage.getItem(STORAGE_KEYS.prefs);
    } catch (error) {
      return result;
    }
    if (!stored) { return result; }

    var parsed;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      return result;
    }
    if (!parsed || typeof parsed !== 'object') { return result; }

    if (VIEWS.indexOf(parsed.view) !== -1) { result.view = parsed.view; }
    if (FILTERS.indexOf(parsed.filter) !== -1) { result.filter = parsed.filter; }
    if (Object.prototype.hasOwnProperty.call(SORTERS, parsed.sort)) { result.sort = parsed.sort; }
    if (typeof parsed.period === 'string' && PERIOD_PATTERN.test(parsed.period)) {
      result.period = parsed.period;
    }
    return result;
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(STORAGE_KEYS.prefs, JSON.stringify(prefs));
    } catch (error) {
    }
  }

  /* ----------------------------------------------------------------- crud */

  function findBook(id) {
    for (var i = 0; i < books.length; i += 1) {
      if (books[i].id === id) { return books[i]; }
    }
    return null;
  }

  function addBook(data) {
    var book = normalizeBook(Object.assign({ createdAt: Date.now() }, data));
    if (!book) { return null; }
    books.push(book);
    saveBooks();
    return book;
  }

  function updateBook(id, data) {
    var existing = findBook(id);
    if (!existing) { return null; }
    var updated = normalizeBook(Object.assign({}, existing, data, {
      id: existing.id,
      createdAt: existing.createdAt
    }));
    if (!updated) { return null; }
    books[books.indexOf(existing)] = updated;
    saveBooks();
    return updated;
  }

  function deleteBook(id) {
    var existing = findBook(id);
    if (!existing) { return false; }
    books.splice(books.indexOf(existing), 1);
    saveBooks();
    return true;
  }

  /* ------------------------------------------------------------ rendering */

  function renderStars(rating) {
    var wrap = el('span', 'stars');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', rating + ' out of 5 stars');
    for (var i = 1; i <= 5; i += 1) {
      var star = el('span', i <= rating ? 'star-on' : 'star-off', i <= rating ? '★' : '☆');
      star.setAttribute('aria-hidden', 'true');
      wrap.appendChild(star);
    }
    return wrap;
  }

  function renderBadge(status) {
    var badge = el('span', 'badge badge-' + status, STATUS_LABELS[status]);
    return badge;
  }

  function actionButton(action, book) {
    var label = action === 'edit' ? 'Edit' : 'Delete';
    var button = el('button', 'card-action', label);
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.id = book.id;
    button.setAttribute('aria-label', label + ' “' + book.title + '”');
    return button;
  }

  function metaRow(label, value, isDerived) {
    var row = el('div', 'meta-row' + (isDerived ? ' is-derived' : ''));
    row.appendChild(el('dt', 'meta-label', label));
    var dd = el('dd', 'meta-value');
    if (value instanceof Node) {
      dd.appendChild(value);
    } else {
      dd.textContent = value;
    }
    row.appendChild(dd);
    return row;
  }

  /* Cards show only the fields that actually hold a value — a book with just
     a title shows its title, its status, and the two controls. */
  function renderBookCard(book) {
    var status = getStatus(book);
    var card = el('article', 'book-card');
    card.dataset.status = status;

    var head = el('div', 'card-head');
    head.appendChild(el('h3', 'book-title', book.title));
    head.appendChild(renderBadge(status));
    card.appendChild(head);

    var meta = el('dl', 'card-meta');
    var startText = formatDate(book.startDate);
    var finishText = formatDate(book.finishDate);
    var days = calculateDaysRead(book);
    var perDay = calculatePagesPerDay(book);

    if (startText) { meta.appendChild(metaRow('Started', startText)); }
    if (finishText) { meta.appendChild(metaRow('Finished', finishText)); }
    if (book.pages) { meta.appendChild(metaRow('Pages', book.pages.toLocaleString())); }
    if (book.rating) { meta.appendChild(metaRow('Rating', renderStars(book.rating))); }
    if (days !== null) { meta.appendChild(metaRow('Days read', formatCount(days, 'day', 'days'), true)); }
    if (perDay !== null) { meta.appendChild(metaRow('Pages/day', formatDecimal(perDay), true)); }

    if (meta.childNodes.length) { card.appendChild(meta); }

    var foot = el('div', 'card-foot');
    foot.appendChild(actionButton('edit', book));
    foot.appendChild(actionButton('delete', book));
    card.appendChild(foot);

    return card;
  }

  /* The table has fixed columns, so missing values get an em dash here
     rather than disappearing the way they do on a card. */
  function listCell(label, value, extraClass) {
    var cell = el('td', extraClass || '');
    cell.dataset.label = label;
    if (value === null || value === undefined || value === '') {
      cell.classList.add('cell-empty');
      var dash = el('span', null, '—');
      dash.setAttribute('aria-hidden', 'true');
      cell.appendChild(dash);
      cell.appendChild(el('span', 'sr-only', 'Not recorded'));
    } else if (value instanceof Node) {
      cell.appendChild(value);
    } else {
      cell.textContent = value;
    }
    return cell;
  }

  function renderBookRow(book) {
    var status = getStatus(book);
    var days = calculateDaysRead(book);
    var perDay = calculatePagesPerDay(book);

    var row = el('tr');
    row.dataset.status = status;

    var titleCell = el('th', 'cell-title', book.title);
    titleCell.setAttribute('scope', 'row');
    titleCell.dataset.label = 'Title';
    row.appendChild(titleCell);

    row.appendChild(listCell('Status', renderBadge(status)));
    row.appendChild(listCell('Started', formatDate(book.startDate)));
    row.appendChild(listCell('Finished', formatDate(book.finishDate)));
    row.appendChild(listCell('Pages', book.pages ? book.pages.toLocaleString() : null, 'num'));
    row.appendChild(listCell('Rating', book.rating ? renderStars(book.rating) : null));
    row.appendChild(listCell('Days', days === null ? null : String(days), 'num'));
    row.appendChild(listCell('Pages/day', perDay === null ? null : formatDecimal(perDay), 'num'));

    var actions = el('td', 'cell-actions');
    actions.dataset.label = 'Actions';
    actions.appendChild(actionButton('edit', book));
    actions.appendChild(actionButton('delete', book));
    row.appendChild(actions);

    return row;
  }

  /* Status and start-date filters combine: "Reading books started in March". */
  function getVisibleBooks() {
    var filtered = books.filter(function (book) {
      var statusOk = prefs.filter === 'all' || getStatus(book) === prefs.filter;
      return statusOk && matchesPeriod(book);
    });
    var sorter = SORTERS[prefs.sort] || SORTERS.added;
    return filtered.sort(sorter);
  }

  /* Explains the current combination of filters in one sentence. */
  function describeNoMatches() {
    var status = prefs.filter === 'all' ? '' : '“' + STATUS_LABELS[prefs.filter] + '” ';
    var period = describePeriod();

    if (period) {
      return 'No ' + status + 'books ' + period + '.';
    }
    if (status) {
      return 'No books match the ' + status.trim() + ' filter.';
    }
    return 'No books match these filters.';
  }

  function showEmptyState(title, text, buttonRole) {
    dom.emptyTitle.textContent = title;
    dom.emptyText.textContent = text;

    if (buttonRole) {
      dom.emptyAction.dataset.role = buttonRole;
      dom.emptyAction.textContent =
        buttonRole === 'add' ? 'Add your first book' : 'Clear filters';
      dom.emptyAction.hidden = false;
    } else {
      dom.emptyAction.hidden = true;
    }

    dom.emptyState.hidden = false;
    dom.grid.hidden = true;
    dom.tableWrap.hidden = true;
  }

  function renderCollection() {
    var visible = getVisibleBooks();

    dom.grid.replaceChildren();
    dom.tbody.replaceChildren();

    if (!books.length) {
      showEmptyState(
        'Your reading shelf is empty.',
        'Add your first book and start your reading journey.',
        'add'
      );
      return;
    }

    if (!visible.length) {
      showEmptyState(
        'Nothing on this shelf yet.',
        describeNoMatches() + ' Try a different combination.',
        'clear'
      );
      return;
    }

    dom.emptyState.hidden = true;

    if (prefs.view === 'list') {
      visible.forEach(function (book) { dom.tbody.appendChild(renderBookRow(book)); });
      dom.tableWrap.hidden = false;
      dom.grid.hidden = true;
    } else {
      visible.forEach(function (book) { dom.grid.appendChild(renderBookCard(book)); });
      dom.grid.hidden = false;
      dom.tableWrap.hidden = true;
    }
  }

  /* The dashboard always describes the whole library, never the filtered view. */
  function updateDashboard() {
    var counts = { reading: 0, finished: 0, dnf: 0, toread: 0 };
    var pagesRead = 0;

    books.forEach(function (book) {
      var status = getStatus(book);
      counts[status] += 1;
      /* Only finished books contribute a known page count. */
      if (status === 'finished' && book.pages) { pagesRead += book.pages; }
    });

    dom.statTotal.textContent = books.length.toLocaleString();
    dom.statReading.textContent = counts.reading.toLocaleString();
    dom.statFinished.textContent = counts.finished.toLocaleString();
    dom.statDnf.textContent = counts.dnf.toLocaleString();
    dom.statPages.textContent = pagesRead.toLocaleString();
  }

  /* Chip counts are scoped to the active start-date filter, so each number is
     exactly what you would see after clicking that chip. */
  function updateFilterCounts() {
    var counts = { reading: 0, finished: 0, dnf: 0, toread: 0 };
    var total = 0;

    books.forEach(function (book) {
      if (!matchesPeriod(book)) { return; }
      counts[getStatus(book)] += 1;
      total += 1;
    });

    dom.counts.forEach(function (node) {
      var key = node.dataset.count;
      node.textContent = String(key === 'all' ? total : counts[key]);
    });
  }

  /* A filter or view changed: the data is the same, only the slice differs. */
  function applyFilters() {
    updateFilterCounts();
    renderCollection();
  }

  /* The books themselves changed. */
  function render() {
    updatePeriodOptions();
    updateDashboard();
    applyFilters();
  }

  /* --------------------------------------------------------- star widget */

  function setRating(value) {
    draftRating = toRating(value);
    dom.starGroup.dataset.rating = String(draftRating || 0);
    dom.clearRating.hidden = !draftRating;

    dom.stars.forEach(function (star) {
      var starValue = Number(star.dataset.value);
      var selected = starValue === draftRating;
      star.classList.toggle('is-on', draftRating !== null && starValue <= draftRating);
      star.setAttribute('aria-checked', selected ? 'true' : 'false');
      /* Roving tabindex: only one star is in the tab order at a time. */
      star.tabIndex = selected || (draftRating === null && starValue === 1) ? 0 : -1;
    });
  }

  function previewRating(value) {
    dom.starGroup.classList.add('is-previewing');
    dom.stars.forEach(function (star) {
      star.classList.toggle('is-preview', Number(star.dataset.value) <= value);
    });
  }

  function clearPreview() {
    dom.starGroup.classList.remove('is-previewing');
    dom.stars.forEach(function (star) { star.classList.remove('is-preview'); });
  }

  function focusStar(value) {
    dom.stars.forEach(function (star) {
      if (Number(star.dataset.value) === value) { star.focus(); }
    });
  }

  function initStarWidget() {
    dom.starGroup.addEventListener('click', function (event) {
      var star = event.target.closest('.star');
      if (!star) { return; }
      setRating(Number(star.dataset.value));
      clearPreview();
    });

    dom.starGroup.addEventListener('mouseover', function (event) {
      var star = event.target.closest('.star');
      if (star) { previewRating(Number(star.dataset.value)); }
    });

    dom.starGroup.addEventListener('mouseleave', clearPreview);
    dom.starGroup.addEventListener('focusout', clearPreview);

    dom.starGroup.addEventListener('keydown', function (event) {
      var current = draftRating || 0;
      var next = null;

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = Math.min(5, current + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          next = Math.max(1, current - 1);
          break;
        case 'Home':
          next = 1;
          break;
        case 'End':
          next = 5;
          break;
        case 'Backspace':
        case 'Delete':
          event.preventDefault();
          setRating(null);
          focusStar(1);
          return;
        default:
          return;
      }

      event.preventDefault();
      setRating(next);
      focusStar(next);
    });

    dom.clearRating.addEventListener('click', function () {
      setRating(null);
      focusStar(1);
    });
  }

  /* -------------------------------------------------------------- the form */

  function setFieldError(input, errorNode, message) {
    if (message) {
      errorNode.textContent = message;
      errorNode.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    } else {
      errorNode.textContent = '';
      errorNode.hidden = true;
      input.removeAttribute('aria-invalid');
    }
  }

  function clearErrors() {
    setFieldError(dom.fieldTitle, dom.errorTitle, '');
    setFieldError(dom.fieldFinish, dom.errorFinish, '');
    setFieldError(dom.fieldPages, dom.errorPages, '');
  }

  function readForm() {
    return {
      title: dom.fieldTitle.value.trim(),
      startDate: dom.fieldStart.value,
      finishDate: dom.fieldFinish.value,
      pagesRaw: dom.fieldPages.value.trim(),
      rating: draftRating,
      dnf: dom.fieldDnf.checked
    };
  }

  /* Only three things can block a save; everything else may be left blank. */
  function validateForm(data) {
    var errors = {};

    if (!data.title) {
      errors.title = 'Please give this book a title.';
    }

    if (data.pagesRaw !== '') {
      var pages = Number(data.pagesRaw);
      if (!Number.isFinite(pages) || !Number.isInteger(pages) || pages < 1) {
        errors.pages = 'Pages should be a whole number of 1 or more — or left blank.';
      }
    }

    if (data.startDate && data.finishDate) {
      var start = parseISODate(data.startDate);
      var finish = parseISODate(data.finishDate);
      if (start !== null && finish !== null && finish < start) {
        errors.finish = 'The finish date can’t be earlier than the start date.';
      }
    }

    return errors;
  }

  function applyErrors(errors) {
    setFieldError(dom.fieldTitle, dom.errorTitle, errors.title || '');
    setFieldError(dom.fieldPages, dom.errorPages, errors.pages || '');
    setFieldError(dom.fieldFinish, dom.errorFinish, errors.finish || '');

    if (errors.title) { dom.fieldTitle.focus(); }
    else if (errors.pages) { dom.fieldPages.focus(); }
    else if (errors.finish) { dom.fieldFinish.focus(); }
  }

  function fillForm(book) {
    dom.fieldTitle.value = book.title;
    dom.fieldStart.value = book.startDate;
    dom.fieldFinish.value = book.finishDate;
    dom.fieldPages.value = book.pages === null ? '' : String(book.pages);
    dom.fieldDnf.checked = book.dnf;
    setRating(book.rating);
  }

  function openBookDialog(id) {
    lastFocused = document.activeElement;
    editingId = id || null;

    dom.bookForm.reset();
    clearErrors();
    setRating(null);

    var book = editingId ? findBook(editingId) : null;
    if (editingId && !book) { editingId = null; }

    if (book) {
      fillForm(book);
      dom.dialogTitle.textContent = 'Edit book';
      dom.dialogSub.textContent = 'Add anything you have learned since — or clear what no longer fits.';
      dom.saveBtn.textContent = 'Save changes';
    } else {
      dom.dialogTitle.textContent = 'Add a book';
      dom.dialogSub.textContent = 'Only the title is required — the rest can wait.';
      dom.saveBtn.textContent = 'Add book';
    }

    dom.bookDialog.showModal();
    dom.fieldTitle.focus();
    dom.fieldTitle.select();
  }

  function handleSubmit(event) {
    event.preventDefault();

    var data = readForm();
    var errors = validateForm(data);

    if (Object.keys(errors).length) {
      applyErrors(errors);
      return;
    }

    var payload = {
      title: data.title,
      startDate: data.startDate,
      finishDate: data.finishDate,
      pages: data.pagesRaw === '' ? null : Number(data.pagesRaw),
      rating: data.rating,
      dnf: data.dnf
    };

    if (editingId) {
      updateBook(editingId, payload);
      announce('Updated “' + data.title + '”.');
    } else {
      addBook(payload);
      announce('Added “' + data.title + '” to your shelf.');
    }

    dom.bookDialog.close();
    render();
  }

  /* ------------------------------------------------------ delete dialog */

  function openDeleteDialog(id) {
    var book = findBook(id);
    if (!book) { return; }

    lastFocused = document.activeElement;
    pendingDeleteId = id;

    dom.deleteText.replaceChildren();
    dom.deleteText.appendChild(document.createTextNode('“'));
    dom.deleteText.appendChild(el('strong', null, book.title));
    dom.deleteText.appendChild(
      document.createTextNode('” will be removed from your shelf. This can’t be undone.')
    );

    dom.deleteDialog.showModal();
    dom.deleteCancel.focus();
  }

  function confirmDelete() {
    if (!pendingDeleteId) { return; }
    var book = findBook(pendingDeleteId);
    var title = book ? book.title : 'The book';

    deleteBook(pendingDeleteId);
    pendingDeleteId = null;
    dom.deleteDialog.close();
    render();
    announce('Removed “' + title + '” from your shelf.');
  }

  /* Focus can't return to a card button that no longer exists. */
  function restoreFocus() {
    if (lastFocused && document.contains(lastFocused)) {
      lastFocused.focus();
    } else {
      dom.addBtn.focus();
    }
    lastFocused = null;
  }

  /* --------------------------------------------------------- preferences */

  function setView(view) {
    if (VIEWS.indexOf(view) === -1) { return; }
    prefs.view = view;
    savePrefs();
    dom.viewButtons.forEach(function (button) {
      var active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    renderCollection();
  }

  function setFilter(filter) {
    if (FILTERS.indexOf(filter) === -1) { return; }
    prefs.filter = filter;
    savePrefs();
    dom.filters.forEach(function (button) {
      var active = button.dataset.filter === filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    applyFilters();
  }

  function setSort(sort) {
    if (!Object.prototype.hasOwnProperty.call(SORTERS, sort)) { return; }
    prefs.sort = sort;
    savePrefs();
    dom.sortSelect.value = sort;
    renderCollection();
  }

  function setPeriod(period) {
    if (!PERIOD_PATTERN.test(period)) { return; }
    prefs.period = period;
    savePrefs();
    syncPeriodControls();
    applyFilters();
  }

  function clearPeriod() {
    setPeriod('any');
  }

  function clearAllFilters() {
    prefs.period = 'any';
    savePrefs();
    syncPeriodControls();
    setFilter('all');
  }

  /* --------------------------------------------------------------- events */

  function handleCollectionClick(event) {
    var button = event.target.closest('[data-action]');
    if (!button || !dom.collection.contains(button)) { return; }

    if (button.dataset.action === 'edit') {
      openBookDialog(button.dataset.id);
    } else if (button.dataset.action === 'delete') {
      openDeleteDialog(button.dataset.id);
    }
  }

  function bindEvents() {
    dom.addBtn.addEventListener('click', function () { openBookDialog(null); });

    /* The empty-state button adds a book on a bare shelf, and clears the
       filters when they are what emptied it. */
    dom.emptyAction.addEventListener('click', function () {
      if (dom.emptyAction.dataset.role === 'clear') {
        clearAllFilters();
        announce('Filters cleared.');
      } else {
        openBookDialog(null);
      }
    });

    dom.collection.addEventListener('click', handleCollectionClick);

    dom.filters.forEach(function (button) {
      button.addEventListener('click', function () { setFilter(button.dataset.filter); });
    });

    dom.viewButtons.forEach(function (button) {
      button.addEventListener('click', function () { setView(button.dataset.view); });
    });

    dom.sortSelect.addEventListener('change', function () { setSort(dom.sortSelect.value); });

    dom.periodSelect.addEventListener('change', function () { setPeriod(dom.periodSelect.value); });
    dom.periodClear.addEventListener('click', function () {
      clearPeriod();
      dom.periodSelect.focus();
    });

    dom.bookForm.addEventListener('submit', handleSubmit);
    dom.cancelBtn.addEventListener('click', function () { dom.bookDialog.close(); });

    dom.bookDialog.addEventListener('close', function () {
      editingId = null;
      restoreFocus();
    });

    dom.deleteCancel.addEventListener('click', function () { dom.deleteDialog.close(); });
    dom.deleteConfirm.addEventListener('click', confirmDelete);
    dom.deleteDialog.addEventListener('close', function () {
      pendingDeleteId = null;
      restoreFocus();
    });

    /* Clear an error as soon as the reader starts fixing it. */
    dom.fieldTitle.addEventListener('input', function () {
      if (dom.fieldTitle.value.trim()) { setFieldError(dom.fieldTitle, dom.errorTitle, ''); }
    });
    dom.fieldPages.addEventListener('input', function () {
      setFieldError(dom.fieldPages, dom.errorPages, '');
    });
    [dom.fieldStart, dom.fieldFinish].forEach(function (input) {
      input.addEventListener('change', function () {
        setFieldError(dom.fieldFinish, dom.errorFinish, '');
      });
    });

    initStarWidget();
  }

  /* ----------------------------------------------------------------- init */

  function init() {
    cacheDom();
    books = loadBooks();
    prefs = loadPrefs();

    /* Reflect stored preferences in the controls before the first render. */
    dom.sortSelect.value = prefs.sort;
    dom.viewButtons.forEach(function (button) {
      var active = button.dataset.view === prefs.view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    dom.filters.forEach(function (button) {
      var active = button.dataset.filter === prefs.filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    bindEvents();
    setRating(null);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
