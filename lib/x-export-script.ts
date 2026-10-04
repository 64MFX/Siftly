/**
 * The "Export X Bookmarks" bookmarklet and console script.
 *
 * It runs in the user's own logged-in x.com tab and reads the bookmark list
 * from the top — newest bookmark first — by asking X's API the way x.com's
 * Bookmarks page does, 100 at a time, without scrolling. (The previous
 * version only listened to what the page loaded after it was started, so the
 * page of newest bookmarks, already loaded by then, was always missed.)
 *
 * If X refuses that request, the script opens Bookmarks inside x.com, copies
 * the request x.com itself makes and reads the list with it. As a last resort
 * it scrolls the page and keeps what x.com loads, and says so if the newest
 * bookmarks may be missing.
 *
 * The result downloads as x-bookmarks-<date>.json: X's own data for each post
 * with user objects cut down to the author (lib/parser.ts reads it through
 * lib/x-tweet-import.ts). The same rules for reading X's answers live in
 * lib/x-bookmarks-api.ts — keep them in step.
 *
 * Client-safe: imported by the Import page.
 */
import {
  BOOKMARKS_FALLBACK_QUERY_ID,
  BOOKMARKS_FEATURES,
  BOOKMARKS_FIELD_TOGGLES,
  BOOKMARKS_PAGE_SIZE,
  X_WEB_BEARER,
} from '@/lib/x-web-client'

/** `format` of the downloaded file */
export const X_EXPORT_FORMAT = 'siftly-x-bookmarks'

const CONFIG = {
  queryId: BOOKMARKS_FALLBACK_QUERY_ID,
  features: BOOKMARKS_FEATURES,
  fieldToggles: BOOKMARKS_FIELD_TOGGLES,
  pageSize: BOOKMARKS_PAGE_SIZE,
  bearer: X_WEB_BEARER,
  format: X_EXPORT_FORMAT,
}

// Plain ES2018 without template literals: it is pasted into x.com as is.
export const X_EXPORT_SCRIPT = `(async function () {
  'use strict';
  var CONFIG = ${JSON.stringify(CONFIG)};
  var BOOKMARKS_URL = /\\/graphql\\/([\\w-]+)\\/Bookmarks(?:[?#]|$)/;

  if (!/(^|\\.)(x|twitter)\\.com$/.test(location.hostname)) {
    alert('Open x.com in this tab (logged in), then run "Export X Bookmarks" again.');
    return;
  }
  if (window.__siftlyExport) {
    window.__siftlyExport.style.display = 'block';
    return;
  }

  // Panel
  function el(tag, css, text) {
    var e = document.createElement(tag);
    e.style.cssText = css;
    e.textContent = text || '';
    return e;
  }
  var panel = el('div', 'position:fixed;top:16px;right:16px;z-index:2147483647;width:330px;padding:14px 16px;border-radius:12px;background:#18181b;color:#e4e4e7;border:1px solid #3f3f46;box-shadow:0 8px 30px rgba(0,0,0,.55);font:13px/1.45 system-ui,-apple-system,sans-serif;text-align:left');
  var heading = el('div', 'font-weight:700;font-size:14px;margin-bottom:6px;color:#fff', 'Export X bookmarks for Siftly');
  var status = el('div', 'margin-bottom:4px');
  var detail = el('div', 'color:#a1a1aa;font-size:12px;margin-bottom:10px');
  var buttons = el('div', 'display:flex;gap:8px');
  var stopButton = el('button', 'flex:1;padding:7px 10px;border:0;border-radius:8px;color:#fff;font:600 12px system-ui,sans-serif;cursor:pointer;background:#4f46e5', 'Stop & download');
  var closeButton = el('button', 'flex:1;padding:7px 10px;border:0;border-radius:8px;color:#e4e4e7;font:600 12px system-ui,sans-serif;cursor:pointer;background:#27272a', 'Close');
  buttons.appendChild(stopButton);
  buttons.appendChild(closeButton);
  panel.appendChild(heading);
  panel.appendChild(status);
  panel.appendChild(detail);
  panel.appendChild(buttons);
  document.body.appendChild(panel);
  window.__siftlyExport = panel;

  var COLORS = { error: '#f87171', done: '#4ade80', warn: '#fbbf24' };
  function say(text, tone) {
    status.textContent = text;
    status.style.color = COLORS[tone] || '#e4e4e7';
  }
  function note(text) {
    detail.textContent = text || '';
  }

  // Bookmarks read so far, in X's order (newest first)
  var tweets = new Map();
  var stopped = false;
  var closed = false;
  // complete = read from the newest to the oldest without a gap: in one direct pass, or as x.com's own page loaded it
  var readTop = false;
  var directComplete = false;
  var pageTop = false;
  var pageEnd = false;
  function progress() {
    say('Reading your bookmarks… ' + tweets.size.toLocaleString() + ' so far');
  }
  stopButton.onclick = function () {
    stopped = true;
    stopButton.disabled = true;
    say('Stopping…');
  };
  closeButton.onclick = function () {
    stopped = true;
    closed = true;
    unhook();
    panel.remove();
    delete window.__siftlyExport;
  };

  // Reading X's answers (the same rules as Siftly's server)
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function unwrap(t) {
    t = obj(t);
    if (t && (t.__typename === 'TweetWithVisibilityResults' || t.__typename === 'TweetWithVisibilityResult')) return obj(t.tweet);
    return t;
  }
  var DROPPED = { views: 1, edit_control: 1, edit_perspective: 1, unmention_data: 1, quick_promote_eligibility: 1, superFollowsReplyUserResult: 1, previous_counts: 1 };
  function pick(source, keys) {
    var out = {};
    keys.forEach(function (k) { if (source[k] !== undefined) out[k] = source[k]; });
    return out;
  }
  function slimUser(u) {
    u = obj(u);
    if (!u) return u;
    var out = pick(u, ['__typename', 'id', 'rest_id', 'core', 'avatar', 'is_blue_verified', 'verification']);
    if (obj(u.legacy)) out.legacy = pick(u.legacy, ['name', 'screen_name', 'profile_image_url_https', 'verified']);
    return out;
  }
  function slim(t, depth) {
    t = unwrap(t);
    if (!t) return null;
    var out = {};
    Object.keys(t).forEach(function (k) {
      var v = t[k];
      if (DROPPED[k]) return;
      if (k === 'core' && obj(v) && obj(v.user_results)) {
        out.core = Object.assign({}, v, { user_results: { result: slimUser(v.user_results.result) } });
      } else if ((k === 'quoted_status_result' || k === 'retweeted_status_result') && obj(v)) {
        var inner = depth < 2 ? slim(v.result, depth + 1) : null;
        out[k] = inner ? { result: inner } : v;
      } else {
        out[k] = v;
      }
    });
    return out;
  }
  function findTimeline(data) {
    var keys = ['bookmark_timeline_v2', 'bookmark_timeline', 'bookmark_collection_timeline'].concat(Object.keys(data));
    for (var i = 0; i < keys.length; i++) {
      var timeline = obj(obj(data[keys[i]]) && data[keys[i]].timeline);
      if (timeline && Array.isArray(timeline.instructions)) return timeline;
    }
    return null;
  }
  function parsePage(body) {
    var data = obj(obj(body) && body.data);
    var timeline = data && findTimeline(data);
    if (!timeline) return null;
    var page = { entries: [], next: null, end: false };
    function addItem(itemContent, entryId) {
      var result = obj(itemContent) && obj(itemContent.tweet_results) && itemContent.tweet_results.result;
      var idFromEntry = (/^tweet-(\\d+)$/.exec(entryId || '') || [])[1];
      if (!result && !idFromEntry) return;
      var tweet = unwrap(result);
      var id = (tweet && typeof tweet.rest_id === 'string' && tweet.rest_id) || idFromEntry;
      if (!id) return;
      var readable = tweet && tweet.__typename !== 'TweetTombstone' && tweet.__typename !== 'TweetUnavailable' && obj(tweet.legacy);
      page.entries.push({ id: id, tweet: readable ? tweet : null });
    }
    function addModuleItem(item) {
      item = obj(item);
      addItem(item && obj(item.item) && item.item.itemContent, item && item.entryId);
    }
    function addEntry(entry) {
      var content = obj(entry) && obj(entry.content);
      if (!content) return;
      var type = content.entryType || content.__typename;
      if (type === 'TimelineTimelineCursor') {
        if (content.cursorType === 'Bottom' && content.value) page.next = content.value;
      } else if (type === 'TimelineTimelineItem') {
        addItem(content.itemContent, entry.entryId);
      } else if (type === 'TimelineTimelineModule') {
        arr(content.items).forEach(addModuleItem);
      }
    }
    arr(timeline.instructions).forEach(function (instruction) {
      instruction = obj(instruction);
      if (!instruction) return;
      var type = instruction.type || instruction.__typename;
      if (type === 'TimelineAddEntries') arr(instruction.entries).forEach(addEntry);
      else if (type === 'TimelineReplaceEntry') addEntry(instruction.entry);
      else if (type === 'TimelineAddToModule') arr(instruction.moduleItems).forEach(addModuleItem);
      else if (type === 'TimelineTerminateTimeline' && instruction.direction !== 'Top') page.end = true;
    });
    return page;
  }
  function keep(page) {
    page.entries.forEach(function (e) {
      if (e.tweet && !tweets.has(e.id)) tweets.set(e.id, slim(e.tweet, 0));
    });
  }
  function parseJson(text) {
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  }
  function requestVariables(req) {
    var source = req.body ? parseJson(req.body) : { variables: parseJson(new URL(req.url, location.origin).searchParams.get('variables')) };
    return obj(source && source.variables) || {};
  }

  // Listen to x.com's own bookmark requests: to copy how it asks, and to keep what it loads
  var original = {
    fetch: window.fetch,
    open: XMLHttpRequest.prototype.open,
    setRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
    send: XMLHttpRequest.prototype.send
  };
  var requestListeners = [];
  function seenRequest(req) {
    requestListeners.slice().forEach(function (fn) { fn(req); });
  }
  function seenResponse(req, body) {
    var page = parsePage(body);
    if (!page) return;
    if (!requestVariables(req).cursor) {
      pageTop = true;
      readTop = true;
    }
    if (page.entries.length === 0 || page.end) pageEnd = true;
    keep(page);
  }
  function headerObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { out[k] = v; });
    else if (Array.isArray(h)) h.forEach(function (p) { out[p[0]] = p[1]; });
    else Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    return out;
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var req = null;
    if (BOOKMARKS_URL.test(url)) {
      req = {
        url: url,
        method: String((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
        headers: headerObject((init && init.headers) || (input && input.headers)),
        body: init && typeof init.body === 'string' ? init.body : null
      };
      seenRequest(req);
    }
    var result = original.fetch.apply(window, arguments);
    if (req) {
      result.then(function (res) {
        res.clone().json().then(function (body) { seenResponse(req, body); }, function () {});
      }, function () {});
    }
    return result;
  };
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__siftly = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {}, body: null };
    return original.open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__siftly) this.__siftly.headers[name] = value;
    return original.setRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var req = xhr.__siftly;
    if (req && BOOKMARKS_URL.test(req.url)) {
      req.body = typeof body === 'string' ? body : null;
      seenRequest(req);
      xhr.addEventListener('load', function () {
        try {
          seenResponse(req, xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText));
        } catch (e) {}
      });
    }
    return original.send.apply(this, arguments);
  };
  var hooked = true;
  function unhook() {
    if (!hooked) return;
    hooked = false;
    window.fetch = original.fetch;
    XMLHttpRequest.prototype.open = original.open;
    XMLHttpRequest.prototype.setRequestHeader = original.setRequestHeader;
    XMLHttpRequest.prototype.send = original.send;
  }

  // Asking X directly
  var csrf = (/(?:^|;\\s*)ct0=([^;]+)/.exec(document.cookie) || [])[1];
  var language = document.documentElement.lang || 'en';
  var NOT_COPIED = /^(cookie|content-length|host|origin|referer|connection|accept-encoding)$/i;
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function failure(kind, message) {
    var e = new Error(message);
    e.kind = kind;
    return e;
  }
  function encode(value) {
    return encodeURIComponent(JSON.stringify(value));
  }
  function template(url, method, headers, body) {
    var u = new URL(url, location.origin);
    var queryId = (/\\/graphql\\/([\\w-]+)\\/Bookmarks/.exec(u.pathname) || [])[1];
    if (!queryId) return null;
    var source = body ? parseJson(body) : {
      variables: parseJson(u.searchParams.get('variables')),
      features: parseJson(u.searchParams.get('features')),
      fieldToggles: parseJson(u.searchParams.get('fieldToggles'))
    };
    source = obj(source) || {};
    return {
      queryId: queryId,
      method: method || 'GET',
      features: obj(source.features) || CONFIG.features,
      fieldToggles: obj(source.fieldToggles),
      variables: obj(source.variables) || {},
      headers: headers || null
    };
  }
  function requestPage(t, cursor) {
    var variables = Object.assign({}, t.variables, { includePromotedContent: false });
    // A copied request keeps x.com's own page size
    if (!t.headers || typeof variables.count !== 'number') variables.count = CONFIG.pageSize;
    if (cursor) variables.cursor = cursor;
    else delete variables.cursor;
    var headers = {
      authorization: 'Bearer ' + CONFIG.bearer,
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': language,
      'content-type': 'application/json'
    };
    Object.keys(t.headers || {}).forEach(function (k) {
      if (!NOT_COPIED.test(k)) headers[k.toLowerCase()] = t.headers[k];
    });
    var path = '/i/api/graphql/' + t.queryId + '/Bookmarks';
    if (t.method === 'POST') {
      var body = { variables: variables, features: t.features, queryId: t.queryId };
      if (t.fieldToggles) body.fieldToggles = t.fieldToggles;
      return original.fetch.call(window, path, { method: 'POST', credentials: 'include', headers: headers, body: JSON.stringify(body) });
    }
    var query = '?variables=' + encode(variables) + '&features=' + encode(t.features) + (t.fieldToggles ? '&fieldToggles=' + encode(t.fieldToggles) : '');
    return original.fetch.call(window, path + query, { credentials: 'include', headers: headers });
  }
  function missingFeatures(body) {
    var errors = arr(obj(body) && body.errors);
    for (var i = 0; i < errors.length; i++) {
      var m = /features cannot be null:\\s*([\\w,\\s]+)/i.exec((errors[i] && errors[i].message) || '');
      if (m) return m[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return [];
  }
  async function waitUntil(until) {
    while (Date.now() < until && !stopped) {
      say("X's limit for reading bookmarks is used up — carrying on at " + new Date(until).toLocaleTimeString() + ' (' + tweets.size.toLocaleString() + ' so far)', 'warn');
      await sleep(1000);
    }
  }
  async function fetchPage(t, cursor) {
    var waits = 0, retries = 0, fixes = 0;
    while (true) {
      var res;
      try {
        res = await requestPage(t, cursor);
      } catch (e) {
        if (retries++ < 2) { await sleep(2000 * retries); continue; }
        throw failure('network', "Couldn't reach X");
      }
      if (res.status === 429) {
        var reset = Number(res.headers.get('x-rate-limit-reset'));
        var until = reset > 0 ? reset * 1000 + 1000 : Date.now() + 15 * 60 * 1000;
        if (waits++ < 4 && until - Date.now() < 16 * 60 * 1000) {
          await waitUntil(until);
          if (stopped) throw failure('stopped', 'Stopped');
          continue;
        }
        throw failure('rate-limit', "X's limit for reading bookmarks is used up until " + new Date(until).toLocaleTimeString());
      }
      var body = null;
      try { body = await res.json(); } catch (e) {}
      if (res.status === 401 || (res.status === 403 && body && Array.isArray(body.errors))) {
        throw failure('auth', "X didn't accept the login in this tab");
      }
      var missing = missingFeatures(body);
      if (missing.length && fixes++ < 3) {
        t.features = Object.assign({}, t.features);
        missing.forEach(function (f) { t.features[f] = false; });
        continue;
      }
      // X answers an empty 404 when a read has to be a POST now
      if ((res.status === 404 || res.status === 405) && t.method !== 'POST' && !t.headers) {
        t.method = 'POST';
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500 && retries++ < 2) { await sleep(2000 * retries); continue; }
        throw failure(res.status >= 500 ? 'http' : 'rejected', 'X answered HTTP ' + res.status);
      }
      var page = parsePage(body);
      if (!page) throw failure('rejected', "X's answer wasn't a list of bookmarks");
      return page;
    }
  }
  async function readAll(t) {
    var cursor = null, used = {};
    while (!stopped) {
      var page = await fetchPage(t, cursor);
      if (!cursor) readTop = true;
      keep(page);
      progress();
      if (page.entries.length === 0 || page.end || !page.next) {
        directComplete = true;
        return;
      }
      if (used[page.next]) return;
      used[page.next] = true;
      cursor = page.next;
      await sleep(400);
    }
  }

  // x.com's own Bookmarks page
  function onBookmarksPage() {
    return /^\\/i\\/bookmarks\\/?$/.test(location.pathname);
  }
  function openBookmarks() {
    var link = document.querySelector('a[href="/i/bookmarks"]');
    if (link) {
      link.click();
      return;
    }
    history.pushState({}, '', '/i/bookmarks');
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }
  function scrollDown() {
    window.scrollTo(0, document.documentElement.scrollHeight);
    var column = document.querySelector('[data-testid="primaryColumn"]');
    if (column && column.scrollTo) column.scrollTo(0, column.scrollHeight);
  }
  function fromEarlierRequest() {
    try {
      var urls = performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(function (u) { return BOOKMARKS_URL.test(u); });
      return urls.length ? template(urls[urls.length - 1], 'GET', null, null) : null;
    } catch (e) {
      return null;
    }
  }
  function copyXsRequest(timeoutMs) {
    return new Promise(function (resolve) {
      var timer = null, nudge = null;
      function done(t) {
        clearTimeout(timer);
        clearInterval(nudge);
        var i = requestListeners.indexOf(listener);
        if (i >= 0) requestListeners.splice(i, 1);
        resolve(t);
      }
      function listener(req) {
        var t = template(req.url, req.method, req.headers, req.body);
        if (t) done(t);
      }
      requestListeners.push(listener);
      if (!onBookmarksPage()) openBookmarks();
      nudge = setInterval(scrollDown, 1500);
      timer = setTimeout(function () { done(null); }, timeoutMs);
    });
  }
  async function scrollAndKeep() {
    if (!onBookmarksPage()) openBookmarks();
    var last = -1, still = 0;
    while (!stopped && !pageEnd && still < 12) {
      scrollDown();
      await sleep(1200);
      if (tweets.size !== last) {
        last = tweets.size;
        still = 0;
      } else {
        still++;
      }
      say('Scrolling through your bookmarks… ' + tweets.size.toLocaleString() + ' so far');
    }
  }

  function download(complete) {
    var list = Array.from(tweets.values());
    var data = {
      format: CONFIG.format,
      version: 2,
      source: 'bookmark',
      exportedAt: new Date().toISOString(),
      complete: complete,
      count: list.length,
      tweets: list
    };
    var name = 'x-bookmarks-' + new Date().toISOString().slice(0, 10) + '.json';
    var url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    return name;
  }

  var problem = null;
  try {
    if (!csrf) throw failure('auth', "You're not logged in to X in this tab");
    progress();
    try {
      await readAll(fromEarlierRequest() || { queryId: CONFIG.queryId, method: 'GET', features: CONFIG.features, fieldToggles: CONFIG.fieldToggles, variables: {}, headers: null });
    } catch (err) {
      if (err.kind === 'auth' || err.kind === 'rate-limit' || stopped) throw err;
      note("Copying how x.com's own Bookmarks page asks…");
      var copied = await copyXsRequest(25000);
      if (!copied) throw err;
      await readAll(copied);
    }
  } catch (err) {
    problem = err;
    if (err.kind !== 'auth' && err.kind !== 'rate-limit' && !stopped) {
      note("X wouldn't answer directly, so this scrolls through your bookmarks instead. Keep this tab open.");
      try { await scrollAndKeep(); } catch (e) {}
    }
  }
  unhook();
  if (closed) return;

  stopButton.style.display = 'none';
  var complete = directComplete || (pageTop && pageEnd);
  if (tweets.size === 0) {
    delete window.__siftlyExport;
    if (problem && problem.kind === 'auth') say(problem.message + '. Log in to x.com in this tab, then try again.', 'error');
    else say('No bookmarks were found' + (problem ? ' (' + problem.message + ')' : '') + '.', 'error');
    return;
  }
  var file = download(complete);
  delete window.__siftlyExport;
  var n = tweets.size.toLocaleString();
  if (complete) {
    say('Done — saved all ' + n + ' bookmarks.', 'done');
    note('Upload ' + file + " on Siftly's Import page.");
  } else if (stopped) {
    say('Stopped — saved the ' + n + ' newest bookmarks read so far.', 'warn');
    note('Upload ' + file + " on Siftly's Import page, and run this again later for the rest.");
  } else if (!readTop) {
    say('Saved ' + n + " bookmarks, but X didn't let this start from your newest one — the newest may be missing.", 'warn');
    note('Upload ' + file + ". To include the newest, open x.com/home in a new tab and run this there — or use Sync from X on Siftly's Import page.");
  } else {
    say('Saved ' + n + ' bookmarks, but X stopped part-way, so some may be missing' + (problem ? ' (' + problem.message + ')' : '') + '.', 'warn');
    note('Upload ' + file + " on Siftly's Import page, and run this again later — or use Sync from X there.");
  }
})();`

/** Shorter for the bookmarklet URL: no indentation, comment lines or blank lines */
function compact(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join('\n')
}

export const X_EXPORT_BOOKMARKLET = `javascript:${encodeURIComponent(compact(X_EXPORT_SCRIPT))}`
