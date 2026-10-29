/* Platynite library frontend. Streaming remains the upstream Moonlight implementation. */
(function () {
  'use strict';
  var settingsKey = 'platynite.connection.v1', cacheKey = 'platynite.catalog.v1';
  var settings = read(settingsKey, { address: '', token: '', sunshine: '' });
  var catalog = read(cacheKey, { games: [] }), selected = null, visible = [], online = false, gameById = {}, viewMode = 'library', detailTimer;
  var root, pending = null, busy = false, stopped = false, refreshTimer, imageObserver, connectionTimer;
  var imageDb, imageRequests = {}, imageQueue = [], activeImages = 0;
  var preferences = read('platynite.view.v1', { installed: false, favorite: false, hidden: false, sort: 'name', list: false });
  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (_) { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  function el(id) { return document.getElementById(id); }
  function status(text) { el('pn-status').textContent = text; }
  function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random()*16|0; return (c === 'x' ? r : (r&3|8)).toString(16); }); }
  function request(path, body, binary) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest(); xhr.open(body ? 'POST' : 'GET', settings.address + path, true);
      xhr.timeout = 10000; xhr.setRequestHeader('Authorization', 'Bearer ' + settings.token);
      if (body) xhr.setRequestHeader('Content-Type', 'application/json');
      if (binary) xhr.responseType = 'blob';
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(binary ? xhr.response : JSON.parse(xhr.responseText)); } catch (_) { reject(new Error('Invalid companion response')); }
        } else {
          var message = xhr.status === 401 ? 'Access token rejected. Open Connect Playnite to update it.' : 'Companion request failed (' + xhr.status + ').';
          if (!binary) { try { message = JSON.parse(xhr.responseText).error || message; } catch (_) {} }
          reject(new Error(message));
        }
      };
      xhr.onerror = xhr.ontimeout = function() { reject(new Error('PC unavailable. Keep Playnite running and allow companion port 19822 on your private network.')); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }
  function openImageDb() {
    return new Promise(function(resolve) {
      try {
        var req = window.indexedDB.open('PlatyniteArtwork', 1);
        req.onupgradeneeded = function() { req.result.createObjectStore('images'); };
        req.onsuccess = function() { imageDb = req.result; resolve(); };
        req.onerror = function() { resolve(); };
      } catch (_) { resolve(); }
    });
  }
  function cachedImage(key) {
    return new Promise(function(resolve) {
      if (!imageDb) { resolve(null); return; }
      try { var req = imageDb.transaction('images').objectStore('images').get(key); req.onsuccess = function() { resolve(req.result || null); }; req.onerror = function() { resolve(null); }; }
      catch (_) { resolve(null); }
    });
  }
  function putImage(key, data) {
    if (!imageDb) return;
    try {
      var tx = imageDb.transaction('images','readwrite'), store = tx.objectStore('images'); store.put(data, key);
      // Bound persistent artwork to roughly 400 thumbnails/backgrounds.
      var count = store.count(); count.onsuccess = function() { if (count.result > 400) { var cursor = store.openCursor(); cursor.onsuccess = function() { if (cursor.result) store.delete(cursor.result.key); }; } };
    } catch (_) {}
  }
  function imageKey(game, kind) { return settings.address + ':' + game.id + ':' + kind + ':' + game.artworkVersion; }
  function image(game, kind) {
    if (!game[kind]) return Promise.resolve(null);
    var key = imageKey(game, kind);
    if (imageRequests[key]) return imageRequests[key];
    imageRequests[key] = cachedImage(key).then(function(data) {
      if (data || !online) return data;
      return new Promise(function(resolve) { var job={ path: game[kind], key: key, resolve: resolve }; if(kind==='background') imageQueue.unshift(job); else imageQueue.push(job); pumpImages(); });
    });
    return imageRequests[key];
  }
  function pumpImages() {
    while (activeImages < 4 && imageQueue.length) {
      (function(job) {
        activeImages++;
        request(job.path, null, true).then(function(blob) {
          var reader = new FileReader(); reader.onload = function() { putImage(job.key, reader.result); job.resolve(reader.result); activeImages--; pumpImages(); };
          reader.onerror = function() { job.resolve(null); activeImages--; pumpImages(); }; reader.readAsDataURL(blob);
        }).catch(function() { delete imageRequests[job.key]; job.resolve(null); activeImages--; pumpImages(); });
      })(imageQueue.shift());
    }
  }
  function attachImage(node, game, kind) {
    image(game, kind).then(function(data) { if (data && node.isConnected) { node.src = data; node.hidden = false; } });
  }
  function refresh(quiet) {
    if (!settings.address || !settings.token) { online = false; if (!quiet) setup(); render(); return Promise.resolve(); }
    if (!quiet) status('Reading your Playnite library…');
    return request('/api/catalog').then(function(result) {
      if (result.version !== 1 || !Array.isArray(result.games)) throw new Error('Unsupported companion catalog');
      var changed = !online || !result.revision || result.revision !== catalog.revision;
      catalog = result; online = true;
      if (changed) { save(cacheKey, catalog); if (!root.hidden) render(); }
      status('Connected to ' + result.host + ' · ' + result.games.length + ' games · Library refreshes automatically');
    }).catch(function(error) {
      var wasOnline=online; online = false; if (!root.hidden && wasOnline) select(selected);
      status(error.message + (catalog.games.length ? ' Showing your saved library.' : ''));
    });
  }
  var PAGE = 60, gridShown = PAGE;
  function filtered() {
    var query = el('pn-search').value.toLowerCase(), platform = el('pn-platform').value;
    var result = catalog.games.filter(function(g) {
      return (!query || g.name.toLowerCase().indexOf(query) >= 0) && (!preferences.installed || g.installed) &&
        (!preferences.favorite || g.favorite) && (!preferences.cloud || g.cloudProvider) && (preferences.hidden || !g.hidden) && (!platform || (g.platforms || []).indexOf(platform) >= 0);
    }).sort(function(a,b) {
      if (viewMode === 'activity') return b.playtime-a.playtime || a.name.localeCompare(b.name);
      if (viewMode === 'home') return (b.lastActivity || '').localeCompare(a.lastActivity || '') || Number(!!b.favorite)-Number(!!a.favorite) || a.name.localeCompare(b.name);
      if (preferences.sort === 'recent') return (b.lastActivity || '').localeCompare(a.lastActivity || '') || a.name.localeCompare(b.name);
      if (preferences.sort === 'playtime') return b.playtime-a.playtime || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
    return viewMode === 'home' ? result.slice(0,24) : result;
  }
  function renderFilters() { gridShown = PAGE; render(); }
  function render() {
    var focusedGame = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.game : null;
    var platform = el('pn-platform'), previous = platform.value, names = {}; gameById = {};
    catalog.games.forEach(function(g) { gameById[g.id]=g; });
    catalog.games.forEach(function(g) { (g.platforms || []).forEach(function(p) { names[p] = true; }); });
    platform.textContent = ''; var all = document.createElement('option'); all.value = ''; all.textContent = 'All platforms'; platform.appendChild(all);
    Object.keys(names).sort().forEach(function(name) { var option = document.createElement('option'); option.textContent = name; option.value = name; platform.appendChild(option); }); platform.value = previous;
    visible = filtered(); el('pn-count').textContent = visible.length + ' / ' + catalog.games.length + ' games';
    el('pn-heading').textContent = viewMode === 'home' ? 'StartPage' : viewMode === 'activity' ? 'GameActivity' : 'Games';
    var addonList=el('pn-addons'); addonList.textContent='';
    (catalog.addons || []).forEach(function(addon) { var button=document.createElement('button');button.className='pn-addon';button.textContent=addon.name;button.dataset.view=addon.view;button.onclick=function(){viewMode=addon.view;renderFilters();var first=el('pn-grid').querySelector('button');if(first)first.focus();};addonList.appendChild(button); });
    el('pn-addon-label').hidden = !(catalog.addons || []).length;
    var hours=catalog.games.reduce(function(total,g){return total+(Number(g.playtime)||0);},0)/3600;
    el('pn-summary').hidden = viewMode === 'library';
    el('pn-summary').textContent = viewMode === 'activity' ? Math.round(hours)+' hours played · '+catalog.games.filter(function(g){return g.lastActivity;}).length+' games played · Most played first' : 'Recently played · Your favorites · Ready for the next session';
    var grid = el('pn-grid'); grid.textContent = ''; grid.classList.toggle('pn-list', preferences.list);
    if (imageObserver) imageObserver.disconnect();
    if ('IntersectionObserver' in window) imageObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) { if (entry.isIntersecting) { loadCard(entry.target); imageObserver.unobserve(entry.target); } });
    }, { root: grid, rootMargin:'200px' });
    var fragment = document.createDocumentFragment();
    var shown = Math.min(gridShown, visible.length);
    visible.slice(0, shown).forEach(function(game, index) {
      var card = document.createElement('button'); card.className = 'pn-card'; card.dataset.game = game.id;
      card.setAttribute('aria-label', game.name + (game.installed ? ', installed' : game.cloudProvider ? ', '+game.cloudProvider : ', not installed'));
      card.setAttribute('aria-selected', selected && selected.id === game.id ? 'true':'false');
      var cover = document.createElement('span'); cover.className = 'pn-cover';
      var initial = document.createElement('span'); initial.className = 'pn-initial'; initial.textContent = game.name.slice(0,2).toUpperCase(); cover.appendChild(initial);
      var art = document.createElement('img'); art.alt = ''; art.hidden = true; cover.appendChild(art);
      if (!game.installed || game.running || game.favorite) { var badge = document.createElement('span'); badge.className = 'pn-badge'; badge.textContent = game.running ? 'Running' : !game.installed ? game.cloudProvider || 'Not installed' : '★ Favorite'; cover.appendChild(badge); }
      var name = document.createElement('span'); name.className = 'pn-card-title'; name.textContent = game.name;
      card.appendChild(cover); card.appendChild(name);
      card.addEventListener('focus', function() { select(game); });
      card.addEventListener('click', function() { select(game); el('pn-play').focus(); });
      fragment.appendChild(card);
      if (imageObserver) imageObserver.observe(card); else if (index < 30) loadCard(card);
    });
    grid.appendChild(fragment);
    el('pn-more').hidden = shown >= visible.length;
    el('pn-more').textContent = 'Showing ' + shown + ' of ' + visible.length;
    el('pn-empty').hidden = visible.length > 0;
    el('pn-empty-title').textContent = catalog.games.length ? 'No matching games' : 'Your Playnite library, on your TV';
    el('pn-empty-text').textContent = catalog.games.length ? 'Change your search or filters to see more games.' : 'Connect to Playnite on your PC to see your games, covers, and favorites.';
    if (selected) selected = visible.filter(function(g) { return g.id === selected.id; })[0];
    select(selected || visible[0] || null);
    if (focusedGame && !root.hidden) { var focused = grid.querySelector('[data-game="' + focusedGame + '"]'); if (focused) focused.focus(); }
  }
  function loadCard(card) { var game = gameById[card.dataset.game]; if (game) attachImage(card.querySelector('img'), game, 'cover'); }
  function playable(game) { return game && (game.canPlay === undefined ? game.installed : game.canPlay); }
  function select(game) {
    selected = game;
    var oldCard=el('pn-grid').querySelector('[aria-selected=true]');if(oldCard)oldCard.setAttribute('aria-selected','false');
    var newCard=game&&el('pn-grid').querySelector('[data-game="'+game.id+'"]');if(newCard)newCard.setAttribute('aria-selected','true');
    el('pn-title').textContent = game ? game.name : 'Choose a game';
    el('pn-meta').textContent = game ? (game.platforms || []).concat(game.source || [], game.installed ? 'Installed' : game.cloudProvider || 'Not installed').filter(Boolean).join(' · ') : 'Powered by your PC’s Playnite library';
    el('pn-description').textContent = game ? game.description || 'No description available in Playnite.' : '';
    el('pn-play').disabled = !playable(game) || !online || busy;
    el('pn-play').textContent = game && game.running ? '▶ Resume game' : !playable(game) ? 'Not available to play' : game.cloudProvider && !game.installed ? '▶ '+game.cloudProvider : '▶ Play';
    clearTimeout(detailTimer);
    if (game) detailTimer=setTimeout(function() {
      image(game, game.background ? 'background':'cover').then(function(data) {
        if (selected && selected.id === game.id && data) { el('pn-detail-art').src = data; el('pn-detail-art').hidden = false; el('pn-backdrop').style.backgroundImage = 'url("' + data + '")'; }
      });
    },140);
  }
  function setup() {
    el('pn-address').value = settings.address; el('pn-token').value = settings.token; el('pn-sunshine').value = settings.sunshine;
    el('pn-error').textContent = ''; el('pn-setup').hidden = false; el('pn-address').focus();
  }
  function validateAddress(value) {
    var url; try { url = new URL(value); } catch (_) { throw new Error('Enter an address such as http://192.168.1.10:19822'); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use an HTTP address without a path, password, or query.');
    return url.origin;
  }
  function show() {
    clearTimeout(connectionTimer);
    root.hidden = false; busy = false; pending = null; stopped = false;
    if (typeof Navigation !== 'undefined') Navigation.stop();
    if (typeof stopPollingHosts !== 'undefined') stopPollingHosts();
    select(selected); var card = el('pn-grid').querySelector('[aria-selected=true]'); if (card) card.focus(); else el('pn-connect').focus();
  }
  function hide() { root.hidden = true; setPadDirection(null); if (typeof Navigation !== 'undefined') Navigation.start(); }
  function hostForAddress(address) {
    var found;
    Object.keys(hosts).some(function(key) { if (hosts[key].address === address || hosts[key].userEnteredAddress === address) { found = hosts[key]; return true; } return false; });
    if(found)return found;
    var host=new NvHTTP(address,myUniqueid,address);host.httpPort=47989;host.httpsPort=47984;return host;
  }
  function connect(resumeOnly) {
    if (busy) return;
    if (!settings.address || !settings.token) { setup(); return; }
    if (!resumeOnly && (!playable(selected) || !online)) return;
    if (typeof Module === 'undefined' || typeof Module.startStream !== 'function' || !pairingCert) { status('Streaming engine is still starting. Try again in a moment.'); return; }
    busy = true; select(selected);
    pending = resumeOnly ? null : { id:selected.id, requestId:uuid() };
    var address = settings.sunshine || new URL(settings.address).hostname;
    var host = hostForAddress(address);
    status('Connecting to Sunshine…');
    host.refreshServerInfoAtAddress(address).then(function() {
      api = host; stopPollingHosts();
      function paired() {
        hosts[host.serverUid] = host; saveHosts();
        host.getAppList().then(function(apps) {
          var desktop = apps.filter(function(app) { return app.title.toLowerCase() === 'desktop'; })[0];
          if (!desktop) throw new Error('Sunshine needs an application named Desktop.');
          return host.refreshServerInfo().then(function() {
            if (host.currentGame && String(host.currentGame) !== String(desktop.id)) throw new Error('Sunshine is streaming another application. End that session before connecting Platynite.');
            hide(); startGame(host, desktop.id);
            connectionTimer = setTimeout(function() {
              if (busy) { pending = null; Module.stopStream(); failed(new Error('Stream connection timed out. Your game was not launched.')); }
            }, 60000);
          });
        }).catch(failed);
      }
      if (host.paired) paired();
      else { hide(); pairingDialog(host, paired, function() { failed(new Error('Pairing was canceled or failed.')); }); }
    }).catch(failed);
    // The stream timeout starts only after pairing, so PIN entry has no racing UI timeout.
  }
  function failed(error) { show(); status(error.message || 'Could not connect.'); }
  function streamConnected() {
    clearTimeout(connectionTimer);
    busy = false; var launch = pending; pending = null;
    if (!launch) return;
    request('/api/launch', launch).then(function(result) {
      status(result.status === 'already-running' ? 'Resumed your running game.' : 'Game launch requested.');
    }).catch(function(error) {
      // Keep desktop streaming; retrying uses the same request ID and never silently relaunches.
      status(error.message); if (typeof snackbarLogLong === 'function') snackbarLogLong(error.message);
    });
  }
  function init() {
    root = document.createElement('section'); root.id = 'platynite'; root.setAttribute('aria-label','Platynite game library');
    root.innerHTML = '<div id="pn-backdrop"></div><header id="pn-toolbar"><div class="pn-brand"><img src="icon.png" alt="">Platynite</div>' +
      '<input id="pn-search" type="search" aria-label="Search games" placeholder="Search your library…"><select id="pn-sort" aria-label="Sort games"><option value="name">Name A–Z</option><option value="recent">Recently played</option><option value="playtime">Most played</option></select>' +
      '<button id="pn-view" aria-label="Toggle grid or list">☷ View</button><button id="pn-streaming">Streaming</button><button id="pn-connect">Connect Playnite</button></header>' +
      '<div id="pn-layout"><aside id="pn-sidebar"><div class="pn-caption">Library</div><button id="pn-all" class="pn-current">All games</button>' +
      '<label class="pn-filter"><input type="checkbox" id="pn-installed">Installed</label><label class="pn-filter"><input type="checkbox" id="pn-cloud">Cloud games</label><label class="pn-filter"><input type="checkbox" id="pn-favorite">Favorites</label><label class="pn-filter"><input type="checkbox" id="pn-hidden">Show hidden</label>' +
      '<div class="pn-caption" style="margin-top:26px">Platforms</div><select id="pn-platform" aria-label="Filter platform"></select><div id="pn-addon-label" class="pn-caption">Add-ons</div><div id="pn-addons"></div><button id="pn-refresh">↻ Refresh</button><button id="pn-resume">Resume desktop</button></aside>' +
      '<main id="pn-library"><div id="pn-library-header"><span id="pn-heading">Games</span><span id="pn-count"></span></div><div id="pn-summary" hidden></div><div id="pn-grid" aria-label="Games"></div><div id="pn-more" class="pn-caption" hidden></div><div id="pn-empty"><strong id="pn-empty-title"></strong><span id="pn-empty-text"></span></div></main>' +
      '<aside id="pn-details"><img id="pn-detail-art" alt="" hidden><h1 id="pn-title">Choose a game</h1><div id="pn-meta"></div><button id="pn-play" class="pn-play" disabled>▶ Play</button><p id="pn-description"></p></aside></div>' +
      '<footer id="pn-status" role="status">Connect Playnite to load your library.</footer>' +
      '<div id="pn-setup" hidden><form id="pn-form"><h2>Connect your Playnite</h2><p>On the PC, open Playnite → Extensions → Platynite → Show TV connection details. Enter the address and token below.</p>' +
      '<label for="pn-address">Companion address</label><input id="pn-address" placeholder="http://192.168.1.10:19822" required>' +
      '<label for="pn-token">Access token</label><input id="pn-token" type="password" autocomplete="off" required>' +
      '<label for="pn-sunshine">Sunshine PC address (optional)</label><input id="pn-sunshine" placeholder="Uses the same PC as Playnite">' +
      '<div class="pn-actions"><button type="submit" id="pn-save">Connect</button><button type="button" id="pn-cancel">Cancel</button></div><div id="pn-error" role="alert"></div></form></div>';
    document.body.appendChild(root);
    ['installed','favorite','hidden','cloud'].forEach(function(key) { el('pn-' + key).checked = !!preferences[key]; el('pn-' + key).onchange = function() { preferences[key] = this.checked; save('platynite.view.v1', preferences); renderFilters(); }; });
    el('pn-all').onclick=function(){viewMode='library';render();};
    el('pn-sort').value = preferences.sort; el('pn-sort').onchange = function() { preferences.sort = this.value; save('platynite.view.v1', preferences); renderFilters(); };
    el('pn-view').onclick = function() { preferences.list = !preferences.list; save('platynite.view.v1', preferences); render(); };
    var searchTimer = null;
    el('pn-search').oninput = function() { clearTimeout(searchTimer); searchTimer = setTimeout(renderFilters, 250); };
    el('pn-platform').onchange = renderFilters;
    el('pn-grid').addEventListener('scroll', function() {
      if (gridShown >= visible.length) return;
      if (this.scrollTop + this.clientHeight >= this.scrollHeight - 400) { gridShown += PAGE; render(); }
    });
    el('pn-connect').onclick = setup; el('pn-cancel').onclick = function() { el('pn-setup').hidden = true; el('pn-connect').focus(); };
    el('pn-refresh').onclick = function() { refresh(false); }; el('pn-play').onclick = function() { connect(false); }; el('pn-resume').onclick = function() { connect(true); };
    el('pn-streaming').onclick = function() { hide(); showHosts(); };
    el('pn-form').onsubmit = function(event) {
      event.preventDefault();
      try {
        var next = { address:validateAddress(el('pn-address').value.trim()), token:el('pn-token').value.trim(), sunshine:el('pn-sunshine').value.trim() };
        if (!next.token) throw new Error('Enter the companion access token.');
        if (next.sunshine && !/^[a-zA-Z0-9.\-]+$/.test(next.sunshine)) throw new Error('Sunshine address must be a hostname or IPv4 address.');
        if (next.address !== settings.address) { catalog = { games:[] }; selected = null; save(cacheKey, catalog); }
        settings = next; save(settingsKey, settings); imageRequests = {};
        el('pn-setup').hidden = true; refresh(false); el('pn-connect').focus();
      } catch (error) { el('pn-error').textContent = error.message; }
    };
    document.addEventListener('keydown', key, true);
    window.addEventListener('gamepadinputchanged', gamepad, true);
    // A dedicated library button keeps upstream pairing and settings accessible.
    var back = document.createElement('button'); back.id = 'pn-library-button'; back.className = 'mdl-button mdl-js-button'; back.textContent = 'Platynite Library'; back.onclick = show;
    var nav = document.querySelector('#main-header nav'); if (nav) nav.insertBefore(back,nav.firstChild);
    openImageDb().then(function() { render(); refresh(false); });
    refreshTimer = setInterval(function() { if (!root.hidden && el('pn-setup').hidden && !document.hidden) refresh(true); }, 30000);
    document.addEventListener('visibilitychange', function() { if (!document.hidden && !root.hidden) refresh(true); });
    el('pn-connect').focus();
  }
  function move(direction) {
    var controls = Array.prototype.filter.call(root.querySelectorAll('button,input,select'), function(node) { return !node.disabled && node.getClientRects().length; });
    var current = document.activeElement, rect = current.getBoundingClientRect(), cx = rect.left+rect.width/2, cy = rect.top+rect.height/2, best, score = Infinity;
    controls.forEach(function(node) {
      if (node === current) return; var r = node.getBoundingClientRect(), x = r.left+r.width/2-cx, y = r.top+r.height/2-cy;
      var major = direction === 'left' ? -x : direction === 'right' ? x : direction === 'up' ? -y : y;
      var minor = direction === 'left' || direction === 'right' ? Math.abs(y) : Math.abs(x);
      if (major > 5 && major + minor*3 < score) { score = major + minor*3; best = node; }
    });
    if (best) { best.focus(); best.scrollIntoView({block:'nearest', inline:'nearest'}); }
  }
  function key(event) {
    if (!root || root.hidden) return;
    var code = event.keyCode, editing = /INPUT|SELECT/.test(document.activeElement.tagName);
    if (code === 10009 || code === 27) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!el('pn-setup').hidden) el('pn-cancel').click(); else if (el('pn-search').value) { el('pn-search').value=''; renderFilters(); } else el('pn-connect').focus();
      return;
    }
    if (editing && ![38,40].includes(code)) { event.stopImmediatePropagation(); return; }
    if ([37,38,39,40,13].indexOf(code) >= 0) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (code === 13) document.activeElement.click(); else move({37:'left',38:'up',39:'right',40:'down'}[code]);
    }
  }
  var padAxes = [0,0], padButtons = {}, padDirection = null, padDelay, padRepeat;
  function setPadDirection(direction) {
    if (direction === padDirection) return;
    clearTimeout(padDelay); clearInterval(padRepeat); padDirection = direction;
    if (!direction) return;
    move(direction);
    padDelay = setTimeout(function() {
      padRepeat = setInterval(function() { if (root.hidden) setPadDirection(null); else move(direction); }, 140);
    }, 360);
  }
  function gamepad(event) {
    if (!root || root.hidden) return;
    event.stopImmediatePropagation();
    (event.detail.changes || []).forEach(function(change) {
      if (change.type === 'axis' && change.index < 2) padAxes[change.index] = change.value;
      if (change.type !== 'button') return;
      padButtons[change.index] = change.pressed;
      if (change.pressed && change.index === 0) document.activeElement.click();
      else if (change.pressed && change.index === 1) { if (!el('pn-setup').hidden) el('pn-cancel').click(); else el('pn-search').focus(); }
    });
    var direction = padButtons[12] ? 'up' : padButtons[13] ? 'down' : padButtons[14] ? 'left' : padButtons[15] ? 'right' : null;
    if (!direction && Math.max(Math.abs(padAxes[0]), Math.abs(padAxes[1])) > .55) {
      direction = Math.abs(padAxes[0]) > Math.abs(padAxes[1]) ? (padAxes[0] < 0 ? 'left':'right') : (padAxes[1] < 0 ? 'up':'down');
    }
    setPadDirection(direction);
  }
  window.Platynite = { show:show, hide:hide, connected:streamConnected, ended:function() { clearTimeout(connectionTimer); pending=null; busy=false; stopped=true; setTimeout(function() { if (stopped) { show(); refresh(true); } },700); },
    isVisible:function() { return root && !root.hidden; }, configure:function(value) { settings=value; save(settingsKey,value); el('pn-setup').hidden=true; return refresh(false); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
