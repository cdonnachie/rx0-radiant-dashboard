/* The bridge dashboard, served by rxd_bridge.py from /var/order/web.

   Split out of index.html along with app.css when the single file passed
   54 KB. No build step, no framework, no CDN - this page is served off a
   miner that may have no route to the internet, so anything it cannot fetch
   from the bridge itself is a permanently broken feature.

   The display rules come from measurements made on this board, and each is
   here because reading the number the other way produced a wrong conclusion
   at some point:

     * Absolute GH/s is the headline; `percent` is secondary and labelled as a
       rejection instrument. Its denominator scales with the clock, so on a
       plateaued board LOWERING the clock raises the percentage while the
       machine does less work - a second RX0 read 101.1% at 650 MHz and 95.7%
       at 675 for the same ~282 GH/s.
     * The averaging window is named wherever a hashrate appears. rtpow is a
       five-minute trailing average, so two readings a minute apart share four
       fifths of their window and are not independent.
     * A window that cannot yet be full is marked, because an average refilling
       from zero is indistinguishable from slow silicon if you just print it.
     * Chip temperatures are whole degrees and do not dither at steady state,
       so they are shown as integers and the spread is shown next to them
       rather than implied.
*/
'use strict';

var REFRESH_MS = 10000;
// rtpow's window. Below this much uptime the average cannot be full, so the
// figure is marked rather than printed bare - it refills from zero and would
// otherwise be indistinguishable from slow silicon.
var WINDOW_SECONDS = 300;

/* --- warm-up banner --------------------------------------------------------

   A restart does not just blank the figures, it makes them WRONG in a way
   that looks right, and this board has produced two false conclusions from
   it.

   THE RAMP IS NOT REPRODUCIBLE AND NOT MONOTONIC, so this banner deliberately
   quotes no curve. Two boots at the SAME clock (770 MHz) on 2026-10-18, hours
   apart, same cooling:

       uptime     7 min   9 min   12 min
       boot 1     316 G   316 G   318 G
       boot 2     305 G   305 G   304 G

   Eleven to fourteen GH apart at matched uptime. Worse, boot 1 went
   318 -> 334 at 22 min -> 319 at 42 -> settled 324, and that 334 is ABOVE
   the theoretical maximum for 770 (332.6), so rtpow overshoots during the
   ramp as well as undershooting. An earlier version of this comment quoted
   "291 GH at 7 min, 312 at 22, 321 settled at 50" from one 775 cold start as
   though it were the shape of the thing; it was one draw from a wide
   distribution, and it was still being shown after the board moved to 770.

   What IS established: the ramp is a function of UPTIME, not temperature -
   the board read 320 GH at 8 h uptime and 295 GH at 17 min with
   byte-identical chip temperatures, and it later passed back through that
   temperature while still climbing. So no amount of pre-warming shortens it,
   and no reading inside the window is usable in either direction.

   Phases, in order: the miner is not reporting at all (~90 s of calibration
   and the first pool connect); rtpow's five-minute window is still filling
   from zero, so the figure is arithmetic rather than silicon; and the long
   tail to equilibrium at roughly 48 minutes.
*/
var MINER_START_SECONDS = 120;
// An hour, not the 48 minutes one cold start happened to take. That figure
// was a single observation and reads as a precision we do not have: today's
// recovery was still climbing at 42 min and settled by 50, so the honest
// range is 45-55. The error is asymmetric - calling it settled early invites
// exactly the wrong comparison this banner exists to prevent, while running
// ten minutes long merely nags - and an hour is already the warm-up this
// project drops from every measurement before comparing anything.
var SOAK_SECONDS = 60 * 60;

// Pure so it can be tested without a DOM; returns null when there is nothing
// worth saying, which includes "we do not know the uptime".
function soakState(seconds) {
	if (seconds === null || seconds === undefined || !isFinite(seconds)) return null;
	if (seconds >= SOAK_SECONDS) return null;
	var mins = Math.floor(seconds / 60);
	var progress = Math.max(0, Math.min(1, seconds / SOAK_SECONDS));

	if (seconds < MINER_START_SECONDS) {
		return { key: 'starting', progress: progress,
			head: 'Miner starting',
			detail: 'Calibration and the first pool connect take about 90 seconds.'
				+ ' No hashrate is reported until they finish.' };
	}
	if (seconds < WINDOW_SECONDS) {
		return { key: 'window', progress: progress,
			head: 'Averaging window still filling — ' + mins + ' of 5 min',
			detail: 'The hashrate is a five-minute trailing average refilling from'
				+ ' zero, so it reads low and will climb on arithmetic alone,'
				+ ' with the silicon doing nothing different.' };
	}
	return { key: 'ramp', progress: progress,
		head: 'Warming up — ' + mins + ' min of about an hour',
		detail: 'Hashrate inside this window is unreliable in BOTH directions'
			+ ' and the path is not repeatable: two boots at the same clock read'
			+ ' 305 and 316 GH at 7 minutes, and one peaked at 334 before'
			+ ' settling at 324. Do not compare clocks yet — rejecting a clock'
			+ ' early is safe, accepting one needs the full soak.' };
}

// ?demo=<seconds> forces a warm-up phase so the banner can be checked without
// rebooting a working miner. It is labelled on screen, because an unlabelled
// preview of a warning is indistinguishable from the warning.
function demoSeconds() {
	var m = /[?&]demo=(\d+)/.exec(location.search);
	return m ? Number(m[1]) : null;
}

function renderSoak(seconds) {
	var demo = demoSeconds();
	var state = soakState(demo === null ? seconds : demo);
	var box = $('soak');
	if (!state) { box.className = 'banner hide'; box.innerHTML = ''; return; }
	box.className = 'banner';
	box.innerHTML = '<div class="head">' + state.head
		+ (demo === null ? '' : ' <span style="opacity:.7">(preview)</span>') + '</div>'
		+ '<div class="detail">' + state.detail + '</div>'
		+ '<div class="bar"><span style="width:'
		+ (state.progress * 100).toFixed(1) + '%"></span></div>';
}

function $(id) { return document.getElementById(id); }

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

function fmtUptime(s) {
	if (s === null) return '—';
	var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
	    m = Math.floor(s % 3600 / 60);
	if (d) return d + 'd ' + h + 'h';
	if (h) return h + 'h ' + m + 'm';
	return m + 'm';
}

function getJSON(path) {
	return fetch(path, { cache: 'no-store' }).then(function(r) {
		if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status);
		return r.json();
	});
}

// Each endpoint is fetched independently and a failure resolves to null
// rather than rejecting. Promise.all would abandon the whole render because
// one of four requests failed, which is how a single wrong path blanked
// every panel on this page - the chips and the hashrate were fine and still
// vanished. Partial data is worth drawing; the failures are named instead.
function soft(path, failures) {
	return getJSON(path).catch(function(ex) {
		failures.push(ex.message || String(ex));
		return null;
	});
}

function setErr(message) {
	var box = $('err');
	if (!message) { box.className = 'err hide'; return; }
	box.className = 'err';
	box.textContent = message;
}

/* --- pages ----------------------------------------------------------------

   One array drives the nav, the routing and the lazy loading, so adding the
   fan, overclock and swarm pages is one entry each rather than four edits in
   four places.

   `onShow` is called every time a page is revealed, with `first` true on the
   first reveal only. Two different jobs ride on that:

     * fetch on first open rather than at startup. The 30-day history costs
       about 12 s of log parsing on a 500 MHz ARM core, and loading it for
       someone who only wanted the chip temperatures is pure waste.
     * redraw on EVERY open, because an SVG inside a display:none page has no
       width. drawChart's fallback then lays the chart out for a 640px box and
       it stays wrong until something else redraws it. This was the whole
       reason the charts had to move with the nav rather than after it.
*/
var PAGES = [
	{ id: 'overview', label: 'Overview' },
	{ id: 'history', label: 'History', onShow: showHistory },
	{ id: 'efficiency', label: 'Efficiency', onShow: showEfficiency },
	{ id: 'chips', label: 'Chips', onShow: showChips },
	{ id: 'fan', label: 'Fan', onShow: showFan },
	{ id: 'logs', label: 'Logs', onShow: showLogs },
	{ id: 'swarm', label: 'Swarm', onShow: showSwarm },
	{ id: 'about', label: 'About' }
];

/* The Clock page is added only on a miner whose install enabled overclocking,
   which is what rxd_oc.enable records. A dashboard that offers a control the
   bridge will answer 503 to is worse than one that does not mention it, and
   this is a control that reboots the machine. Inserted before About once
   /about says so, rather than being in the array from the start. */
var clockPageAdded = false;

function maybeAddClockPage(about) {
	if (clockPageAdded || !about || !about.overclockEnabled) return;
	clockPageAdded = true;
	PAGES.splice(PAGES.length - 1, 0,
		{ id: 'clock', label: 'Clock', onShow: showClock });
	buildNav();
	// The nav was rebuilt, so the current tab lost its highlight.
	showPage(currentPage.id);
}
var currentPage = PAGES[0];
var pageLoaded = {};

function buildNav() {
	$('nav').innerHTML = PAGES.map(function(p) {
		return '<a href="#' + p.id + '" id="tab-' + p.id + '">' + p.label + '</a>';
	}).join('');
}

function showPage(id) {
	var page = null;
	PAGES.forEach(function(p) { if (p.id === id) page = p; });
	// An unknown or empty fragment lands on the first page rather than showing
	// nothing. A stale bookmark should degrade to the overview, not to a blank.
	if (!page) page = PAGES[0];

	PAGES.forEach(function(p) {
		var panel = $('page-' + p.id);
		if (panel) panel.className = (p === page) ? 'page' : 'page hide';
		var tab = $('tab-' + p.id);
		if (!tab) return;
		tab.className = (p === page) ? 'on' : '';
		// Marked for a screen reader as well as in accent colour, which is
		// also the hashrate colour and so cannot be the only cue.
		if (p === page) tab.setAttribute('aria-current', 'page');
		else tab.removeAttribute('aria-current');
	});

	currentPage = page;
	if (page.onShow) page.onShow(!pageLoaded[page.id]);
	pageLoaded[page.id] = true;
}

function showHistory(first) {
	if (first) {
		buildRanges();
		loadHistory();
		return;
	}
	// Already fetched: the geometry is what changed, not the readings.
	drawHistory();
}

function showEfficiency(first) {
	if (first) loadPower();
}

function showFan(first) {
	if (first) loadFanConfig();
}

function showLogs(first) {
	if (first) loadLogs();
}

function showSwarm(first) {
	if (first) {
		if (!$('scanPrefix').value) $('scanPrefix').value = defaultPrefix();
		loadPeers();
		loadSwarm();
	}
}

function showClock(first) {
	if (first) loadClock();
}

function showChips(first) {
	if (first) {
		buildChipRanges();
		loadChipHistory();
		return;
	}
	// Same reason as showHistory: an SVG inside a hidden page has no width, so
	// the charts must be redrawn on every reveal, not only when data changes.
	drawChipHistory();
}

function routeFromHash() {
	showPage(String(location.hash || '').replace(/^#/, ''));
}

function renderPerf(perf, uptimeSeconds) {
	var gh = num(perf.actual);
	$('gh').textContent = gh === null ? '—' : gh.toFixed(0);

	var bits = [];
	if (perf.mhz) bits.push('at ' + perf.mhz + ' MHz');
	if (perf.windowSeconds) bits.push('· ' + (perf.windowSeconds / 60) + ' min avg');
	$('at').textContent = bits.join(' ');

	var pct = num(perf.percent);
	$('pct').textContent = pct === null ? '—' : pct.toFixed(1) + '%';

	var exp = num(perf.expected);
	$('expected').textContent = exp === null ? '—' : exp.toFixed(1) + ' GH/s';
	$('gap').textContent = (exp === null || gh === null)
		? '—' : (exp - gh).toFixed(1) + ' GH/s';

	// The window cannot be full if the machine has not been up that long.
	var filling = uptimeSeconds !== null && uptimeSeconds < WINDOW_SECONDS;
	$('ghMark').className = filling ? 'mark' : 'mark hide';
	$('fillNote').textContent = filling
		? 'still filling: ' + Math.floor(uptimeSeconds / 60) + ' of '
		  + (WINDOW_SECONDS / 60) + ' minutes since boot, so this reads low'
		: '';
}

function renderChips(info) {
	var chips = (info.chips || []).filter(function(c) { return c.temp !== null; });
	$('chipCount').textContent = chips.length ? '(' + chips.length + ')' : '';
	if (!chips.length) { $('chips').innerHTML = ''; return; }

	var temps = chips.map(function(c) { return Number(c.temp); });
	var volts = chips.map(function(c) { return Number(c.voltage || 0); })
	                 .filter(function(v) { return v > 0; });
	var lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
	var mean = temps.reduce(function(a, b) { return a + b; }, 0) / temps.length;

	$('tMean').textContent = mean.toFixed(1) + '°';
	$('tRange').textContent = lo + '–' + hi + ' °C';
	$('spread').textContent = (hi - lo).toFixed(0) + '°';

	if (volts.length) {
		var vlo = Math.min.apply(null, volts), vhi = Math.max.apply(null, volts);
		var vmean = volts.reduce(function(a, b) { return a + b; }, 0) / volts.length;
		$('rail').textContent = vmean.toFixed(0) + ' mV';
		$('railRange').textContent = vlo + '–' + vhi + ' mV';
	}
	$('soc').textContent = info.soc === undefined || info.soc === null
		? '—' : Number(info.soc).toFixed(1) + '°';

	var html = chips.map(function(c) {
		var t = Number(c.temp);
		// Only the extremes are flagged. With 1 C quantisation, colouring a
		// gradient would invent precision the sensors do not have.
		var cls = t === hi && hi > lo ? ' hot' : (t === lo && hi > lo ? ' cold' : '');
		var d = [];
		if (c.voltage) d.push(c.voltage + ' mV');
		if (c.pll) d.push(Number(c.pll).toFixed(0) + ' MHz');
		return '<div class="chip' + cls + '">'
			+ '<div class="no">chip ' + c.no + '</div>'
			+ '<div class="t">' + t.toFixed(0) + '°C</div>'
			+ '<div class="d">' + d.join(' · ') + '</div>'
			+ '</div>';
	}).join('');
	$('chips').innerHTML = html;
}

/* 'dd:hh:mm:ss' -> seconds, or null if it is not that shape. Null, never 0:
   an unparsed runtime means "unknown", and zero would be read as "just
   started" and raise a warm-up banner that is not true. */
function runtimeSeconds(text) {
	var parts = String(text || '').split(':');
	if (parts.length !== 4) return null;
	var n = parts.map(function(p) { return parseInt(p, 10); });
	if (n.some(function(v) { return isNaN(v); })) return null;
	return ((n[0] * 24 + n[1]) * 60 + n[2]) * 60 + n[3];
}

function renderPool(pool) {
	var live = pool.live;
	var state = $('poolState');
	if (!live) {
		// Every slot disconnected. Worth shouting about: the board can be
		// hashing perfectly and earning nothing.
		state.className = 'v bad';
		state.textContent = 'Offline';
		$('poolWho').textContent = (pool.pools || []).length
			? 'no pool connected' : 'none configured';
		$('shares').textContent = '—';
		$('rejects').textContent = '—';
		return;
	}
	state.className = 'v ok';
	state.textContent = 'Connected';
	var host = live.addr.replace(/^.*:\/\//, '');
	$('poolWho').textContent = (live.worker ? live.worker + ' · ' : '') + host;

	$('shares').textContent = live.accepted;
	// A reject RATE is the number that matters; a raw count means nothing
	// without knowing how many were submitted alongside it.
	$('rejects').textContent = live.rejected === 0
		? 'none rejected'
		: live.rejected + ' rejected · ' +
		  (live.rejectRate === null ? '—' : live.rejectRate + '%');
}

function renderAbout(about) {
	$('model').textContent = about.model || '';
	$('uptime').textContent = fmtUptime(num(about.uptimeSeconds));
	renderVersion(about);
	renderAboutPage(about);
	maybeAddClockPage(about);
}

/* --- About -----------------------------------------------------------------

   Rendered on every tick rather than once on first open, because /about is
   already being fetched every tick for the model and uptime and the rails
   move. A page that was built once would show rail voltages frozen at
   whenever it happened to be opened, which is worse than not showing them.

   Everything here is already in the payload - before this page existed the
   browser was fetching nine fields every ten seconds and using one. */

function esc(s) {
	return String(s === null || s === undefined ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Label and value, nothing else. An earlier version carried a third column of
// notes - "since boot", "from the package filename" - next to rows that say
// what they are perfectly well on their own. Where a value genuinely needs
// explaining, the note under the page is the place for it; a gloss on every
// row just makes the ones that matter harder to spot.
function rows(pairs) {
	return pairs.filter(function(p) { return p[1] !== null && p[1] !== undefined && p[1] !== ''; })
		.map(function(p) {
			return '<tr><th>' + esc(p[0]) + '</th><td>' + p[1] + '</td></tr>';
		}).join('');
}

function fmtMB(mb) {
	var v = num(mb);
	if (v === null) return null;
	return v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v.toFixed(0) + ' MB';
}

function renderAboutPage(about) {
	var table = $('aboutIdentity');
	if (!table) return;

	var installed = num(about.bridgeInstalledMs);
	table.innerHTML = rows([
		['Model', esc(about.model)],
		['Dashboard', about.version ? 'v' + esc(about.version) : null],
		['Bridge installed', installed === null ? null
			: esc(new Date(installed).toLocaleString())],
		['Firmware', esc(about.firmware)],
		['Kernel', esc(about.kernel)],
		['Uptime', esc(fmtUptime(num(about.uptimeSeconds)))],
		// Named in the label rather than in a note beside it: this is the
		// control board's sensor, and reading it as a chip temperature is the
		// one mistake this row can cause.
		['SoC temperature (control board)', num(about.socTemp) === null ? null
			: num(about.socTemp).toFixed(1) + ' °C'],
		['SSH port', esc(about.sshPort)],
		['Overclocking', about.overclockEnabled ? 'enabled' : 'not enabled']
	]);

	$('aboutBoards').innerHTML =
		'<tr><th>Board</th><th>Chips</th><th>Clock</th><th>Board volts</th></tr>' +
		(about.boards || []).map(function(b) {
			return '<tr><td>' + esc(b.board) + '</td><td>' + esc(b.chipcount) +
				'</td><td>' + esc(b.pll) + ' MHz</td><td>' +
				(num(b.volts) === null ? '—' : num(b.volts).toFixed(2) + ' V') +
				'</td></tr>';
		}).join('');

	$('aboutRails').innerHTML =
		'<tr><th>Rail</th><th>Measured</th><th>Nominal</th><th>State</th></tr>' +
		(about.rails || []).map(function(r) {
			var v = num(r.volts), nom = num(r.nominal), band = num(r.band);
			// The tolerance is named in the row rather than only encoded in the
			// pass/fail, so "in band" can be checked rather than trusted.
			var limits = (nom === null || band === null) ? '' :
				' ±' + Math.round(band * 100) + '%';
			return '<tr><td>' + esc(r.label) + '</td><td>' +
				(v === null ? '—' : v.toFixed(3) + ' V') + '</td><td>' +
				(nom === null ? '—' : nom.toFixed(2) + ' V' + limits) +
				'</td><td class="' + (r.ok ? 'ok' : 'bad') + '">' +
				(r.ok ? 'in band' : 'OUT OF BAND') + '</td></tr>';
		}).join('');

	$('aboutHardware').innerHTML =
		'<tr><th>Part</th><th>Value</th><th>How it is known</th></tr>' +
		(about.hardware || []).map(function(h) {
			return '<tr><td>' + esc(h.label) + '</td><td>' + esc(h.value) +
				'</td><td>' + esc(h.source) + '</td></tr>';
		}).join('');

	var st = about.storage || {}, sd = about.sd || {};
	var store = [
		['NAND (/)', st.root, 'firmware and the bridge'],
		['tmpfs (/var/volatile)', st.volatile, 'RAM; lost on reboot']
	].filter(function(p) { return p[1]; }).map(function(p) {
		return '<tr><td>' + esc(p[0]) + '</td><td>' + esc(fmtMB(p[1].free)) +
			' free</td><td>' + esc(fmtMB(p[1].total)) + '</td><td>' +
			esc(p[2]) + '</td></tr>';
	}).join('');
	// No card is a normal state, not a fault - sampling falls back to NAND.
	// Only the ARCHIVE needs a card, so that is what the row says.
	store += sd.mount
		? '<tr><td>SD card' + (sd.card ? ' (' + esc(sd.card) + ')' : '') +
		  '</td><td>' + esc(fmtMB(sd.free)) + ' free</td><td>' +
		  esc(fmtMB(sd.total)) + '</td><td>' + esc(sd.mount) + '</td></tr>'
		: '<tr><td>SD card</td><td colspan="3">none — logs go to NAND and are'
		  + ' capped; nothing is archived</td></tr>';
	$('aboutStorage').innerHTML =
		'<tr><th>Store</th><th>Free</th><th>Total</th><th></th></tr>' + store;
}

// The release string, with the bridge's install time behind it on hover.
//
// Both, because they answer different questions and either alone misleads.
// VERSION is hand-maintained, so it still reads correctly after a deploy that
// forgot to bump it; bridgeInstalledMs cannot be forgotten but says nothing
// about which release this is. Together, a version that did not move while the
// install time did is visible rather than silent.
function renderVersion(about) {
	var el = $('version');
	if (!el) return;
	if (!about.version) {
		el.hidden = true;
		return;
	}
	el.textContent = 'v' + about.version;
	var installed = num(about.bridgeInstalledMs);
	el.title = installed === null
		? 'bridge install time unknown'
		: 'bridge installed ' + new Date(installed).toLocaleString();
	el.hidden = false;
}

// /about carries the fan CONFIG - what rxd_fan.conf asks for, as strings.
// What the fan is actually doing lives on /fan, under `live`. The two
// disagree whenever the miner has grabbed the fan back, which is the entire
// reason the bridge reports both, so this reads the live one.
function renderFan(fan) {
	var live = fan.live || {};
	var rpm = num(live.rpm);
	// The tach reads 0 below about 19% duty - the fan is turning too slowly
	// for the miner's pulse counter. Printing "0 rpm" would read as a stopped
	// fan, which is a different and much more alarming thing.
	$('fanRpm').textContent = (rpm === null || rpm === 0)
		? (live.ratio !== undefined && live.ratio !== null ? live.ratio + '%' : '—')
		: rpm + ' rpm';
	var mode = [];
	if (fan.mode) mode.push(fan.mode);
	if (live.ratio !== undefined && live.ratio !== null) mode.push(live.ratio + '% duty');
	if (rpm === 0) mode.push('tach idle below ~19%');
	$('fanMode').textContent = mode.join(' · ');
}

/* --- history charts -------------------------------------------------------

   Hand-rolled SVG rather than a charting library, for one blunt reason: this
   page is served off a miner that may have no route to the internet, so a
   CDN script would leave the charts permanently empty. Two line charts do
   not justify vendoring a library either.

   Timestamps arrive as epoch milliseconds, deliberately - the device clock
   is UTC and the person reading this is not, so formatting has to happen
   here. The bridge stopped sending pre-rendered 'HH:MM' for exactly this
   reason after it put the chip charts four hours out.
*/

/* `hint` is measured, not guessed - timed cold on this device, first load
   after a cache lapse:  6h 120ms,  24h 560ms,  7d 2.7s,  30d 11.6s. The
   bridge caches the parsed result, so a repeat of any of them is ~40ms.
   `live` marks the ranges worth refreshing in the background: at a week or a
   month one more sample is invisible, and re-parsing run.log and his.log
   every two minutes is real CPU on a machine whose job is hashing. */
var RANGES = [
	{ label: '6h', hours: 6, points: 200, live: true },
	{ label: '24h', hours: 24, points: 400, live: true },
	{ label: '7d', hours: 168, points: 700,
	  hint: 'first load takes a few seconds' },
	{ label: '30d', hours: 720, points: 1000,
	  hint: 'first load takes around ten seconds, then it is cached for ten minutes' }
];
var currentRange = RANGES[1];
var lastHistory = null;

function fmtTick(ms, hours) {
	var d = new Date(ms);
	function p(n) { return (n < 10 ? '0' : '') + n; }
	return hours <= 48
		? p(d.getHours()) + ':' + p(d.getMinutes())
		: p(d.getDate()) + '/' + p(d.getMonth() + 1);
}

// Round tick values to something a person would choose: 1, 2, 5 x 10^n.
function niceTicks(lo, hi, count) {
	if (!(hi > lo)) { hi = lo + 1; }
	var raw = (hi - lo) / count;
	var step = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
	// Thresholds deliberately below the textbook 1.5/3.5/7.5: those round up
	// reluctantly and a 55-68 C range came out as seven gridlines two degrees
	// apart, which is clutter on a 190px chart. Rounding up sooner gives
	// three to five rounder lines.
	var err = raw / step;
	if (err >= 7) step *= 10;
	else if (err >= 3) step *= 5;
	else if (err >= 1.5) step *= 2;
	// The length cap is insurance, not arithmetic: a NaN or a zero step from
	// pathological data would otherwise spin this loop forever and hang the
	// tab. Four ticks are wanted, fifty is already absurd.
	var ticks = [];
	for (var v = Math.ceil(lo / step) * step;
	     v <= hi + step * 1e-9 && ticks.length < 50; v += step) {
		ticks.push(Math.round(v * 1000) / 1000);
	}
	return ticks;
}

function usable(s, point) {
	var v = point[1];
	if (v === null || v === undefined) return false;
	// 0 and 127 are failed reads for the temperature sensors, not readings -
	// plotting either draws a cliff and makes a rebooting miner look like one
	// whose cooling died. Zero hashrate IS a real measurement, so only the
	// series that opt in get this.
	return !(s.drop && s.drop(Number(v)));
}

/* Each series' plottable points and its own sampling cadence, worked out once
   because three things need them and must agree: where the line breaks, which
   sample the hover readout snaps to, and how far away is too far to snap. */
function prepareSeries(series) {
	return series.map(function(s) {
		var good = (s.points || []).filter(function(p) { return usable(s, p); });
		var deltas = [];
		for (var i = 1; i < good.length; i++) deltas.push(good[i][0] - good[i - 1][0]);
		deltas.sort(function(a, b) { return a - b; });
		// The median, not the mean: one reboot gap would drag a mean far enough
		// to let the line bridge a real outage.
		var median = deltas[Math.floor(deltas.length / 2)] || 60000;
		return { s: s, good: good, median: median,
		         maxGap: Math.max(median * 3, 300000) };
	});
}

function drawChart(svg, series, opts) {
	opts = opts || {};
	var w = svg.clientWidth || svg.parentNode.clientWidth || 640;
	var h = svg.clientHeight || 190;
	var padL = 46, padR = 10, padT = 10, padB = 22;

	var prepared = prepareSeries(series);
	var pts = [];
	prepared.forEach(function(p) {
		p.good.forEach(function(pt) { pts.push([pt[0], Number(pt[1])]); });
	});
	if (pts.length < 2) {
		svg.innerHTML = '<text x="' + (w / 2) + '" y="' + (h / 2) +
			'" text-anchor="middle">no data in this window</text>';
		// Nothing is plotted, so there is nothing to hover. Clearing the saved
		// geometry stops the readout answering with the PREVIOUS window's
		// numbers over an empty chart.
		svg._chart = null;
		return;
	}

	var t0 = Infinity, t1 = -Infinity, vlo = Infinity, vhi = -Infinity;
	pts.forEach(function(p) {
		if (p[0] < t0) t0 = p[0];
		if (p[0] > t1) t1 = p[0];
		if (p[1] < vlo) vlo = p[1];
		if (p[1] > vhi) vhi = p[1];
	});
	var pad = (vhi - vlo) * 0.08 || 1;
	vlo = opts.yMin !== undefined ? opts.yMin : vlo - pad;
	vhi = vhi + pad;

	function X(t) { return padL + (t - t0) / (t1 - t0 || 1) * (w - padL - padR); }
	function Y(v) { return h - padB - (v - vlo) / (vhi - vlo || 1) * (h - padT - padB); }

	var out = [];
	niceTicks(vlo, vhi, 4).forEach(function(v) {
		var y = Y(v);
		if (y < padT - 1 || y > h - padB + 1) return;
		out.push('<line class="grid" x1="' + padL + '" y1="' + y.toFixed(1) +
			'" x2="' + (w - padR) + '" y2="' + y.toFixed(1) + '"/>');
		out.push('<text x="' + (padL - 6) + '" y="' + (y + 3.5).toFixed(1) +
			'" text-anchor="end">' + v + '</text>');
	});

	var slots = Math.max(2, Math.min(6, Math.floor(w / 110)));
	for (var i = 0; i <= slots; i++) {
		var t = t0 + (t1 - t0) * i / slots;
		var x = X(t);
		out.push('<text x="' + x.toFixed(1) + '" y="' + (h - 6) +
			'" text-anchor="' + (i === 0 ? 'start' : (i === slots ? 'end' : 'middle')) +
			'">' + fmtTick(t, opts.hours || 24) + '</text>');
	}
	out.push('<line class="axis" x1="' + padL + '" y1="' + (h - padB) +
		'" x2="' + (w - padR) + '" y2="' + (h - padB) + '"/>');

	prepared.forEach(function(p) {
		if (p.good.length < 2) return;
		// A gap wider than three sampling intervals is missing data, not a
		// straight line between two distant readings. Break the path instead
		// of drawing a plausible-looking segment nobody measured.
		var d = '', prev = null;
		p.good.forEach(function(pt) {
			var cmd = (prev === null || pt[0] - prev > p.maxGap) ? 'M' : 'L';
			d += cmd + X(pt[0]).toFixed(1) + ' ' + Y(pt[1]).toFixed(1) + ' ';
			prev = pt[0];
		});
		out.push('<path d="' + d.trim() + '" stroke="' + p.s.color + '"/>');
	});

	// The hover furniture is created with the chart and parked, rather than
	// built on first move: every redraw replaces innerHTML, so anything added
	// later would be thrown away by the next refresh or resize.
	out.push('<g class="hover" style="display:none">');
	out.push('<line class="hover-line" y1="' + padT + '" y2="' + (h - padB) + '"/>');
	prepared.forEach(function(p) {
		out.push('<circle class="hover-dot" r="3.5" fill="' + p.s.color +
			'" style="display:none"/>');
	});
	out.push('</g>');

	svg.innerHTML = out.join('');

	var group = svg.querySelector('g.hover');
	svg._chart = {
		series: series, prepared: prepared, X: X, Y: Y, t0: t0, t1: t1,
		w: w, padL: padL, padR: padR,
		hours: opts.hours || 24, legend: opts.legend || null,
		group: group,
		line: group.querySelector('line'),
		dots: Array.prototype.slice.call(group.querySelectorAll('circle'))
	};
	bindHover(svg);
}

/* --- hover readout -------------------------------------------------------

   The legend already holds a slot per series, so the hovered values go THERE
   rather than into a floating tooltip: no positioning to get wrong near the
   edges, it cannot cover the line you are reading, and it works at phone
   width where a tooltip has nowhere to go. Leaving the chart restores the
   latest values, so the legend means the same thing whether or not a cursor
   is in it. */

function hoverTime(ms, hours) {
	var d = new Date(ms);
	function p(n) { return (n < 10 ? '0' : '') + n; }
	var hm = p(d.getHours()) + ':' + p(d.getMinutes());
	// Seconds are never shown: the series is written every 300 s, so a
	// to-the-second label would imply a precision the data does not have.
	return hours > 48 ? p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + hm : hm;
}

/* Which sample the cursor is actually pointing at, or null for "nothing was
   measured here". Kept pure and separate from the drawing so it can be tested:
   it is the one hover decision that can put a wrong number in front of you. */
function nearestSample(prep, t) {
	var best = null, bestD = Infinity;
	for (var j = 0; j < prep.good.length; j++) {
		var d = Math.abs(prep.good[j][0] - t);
		if (d < bestD) { bestD = d; best = prep.good[j]; }
	}
	// Snapping across a gap would put a number under the cursor that was
	// measured somewhere else entirely - the same lie the broken path line
	// exists to avoid. Past one and a half intervals, say nothing.
	if (!best || bestD > prep.median * 1.5) return null;
	return best;
}

function chartHoverOff(svg) {
	var c = svg._chart;
	if (!c) return;
	c.group.style.display = 'none';
	if (c.legend) c.legend.innerHTML = legendHTML(c.series);
}

function chartHover(svg, clientX) {
	var c = svg._chart;
	if (!c) return;
	var x = clientX - svg.getBoundingClientRect().left;
	// Outside the plotted area there is no reading. Clamping to the nearest
	// edge would invent one, and the axis labels are out here too.
	if (x < c.padL || x > c.w - c.padR) { chartHoverOff(svg); return; }

	var span = (c.w - c.padL - c.padR) || 1;
	var t = c.t0 + (x - c.padL) / span * (c.t1 - c.t0);

	var values = [], at = null;
	c.prepared.forEach(function(p, i) {
		var best = nearestSample(p, t);
		values.push(best ? best[1] : null);
		var dot = c.dots[i];
		if (best) {
			dot.setAttribute('cx', c.X(best[0]).toFixed(1));
			dot.setAttribute('cy', c.Y(Number(best[1])).toFixed(1));
			dot.style.display = '';
			if (at === null) at = best[0];
		} else {
			dot.style.display = 'none';
		}
	});

	// The guide sits on the matched sample, not under the cursor, so it passes
	// through the dots instead of beside them. These series share one log and
	// one cadence, so in practice they match on the same stamp.
	var lineX = (at === null ? x : c.X(at)).toFixed(1);
	c.line.setAttribute('x1', lineX);
	c.line.setAttribute('x2', lineX);
	c.group.style.display = '';
	if (c.legend) {
		c.legend.innerHTML = legendHTML(c.series, values,
			at === null ? t : at, c.hours);
	}
}

function bindHover(svg) {
	// Bound to the element, not re-bound per draw: drawChart runs on every
	// refresh, resize and range change, and a listener added each time would
	// accumulate silently.
	if (svg._hoverBound) return;
	svg._hoverBound = true;
	svg.addEventListener('pointermove', function(ev) {
		// A touch DRAG is the page's scroll gesture. Scrubbing on it would
		// mean the page could not be scrolled past a chart, so touch reads by
		// tapping (pointerdown) instead.
		if (ev.pointerType === 'touch') return;
		chartHover(svg, ev.clientX);
	});
	svg.addEventListener('pointerdown', function(ev) { chartHover(svg, ev.clientX); });
	svg.addEventListener('pointerleave', function() { chartHoverOff(svg); });
}

/* With no `values` this is the resting legend: the latest reading per series.
   With `values` it is the hover readout for one instant, which is why a
   missing one renders as a dash rather than as nothing - "no reading at this
   moment" and "this series has no data at all" look identical otherwise, and
   a silently absent number reads as the previous one. */
function legendHTML(series, values, atMs, hours) {
	var html = series.map(function(s, i) {
		var v;
		if (values) {
			v = values[i];
		} else {
			var good = (s.points || []).filter(function(p) { return usable(s, p); });
			v = good.length ? good[good.length - 1][1] : null;
		}
		var text;
		if (v === null || v === undefined) {
			text = values ? ' <b>—</b>' : '';
		} else {
			text = ' <b>' + Number(v).toFixed(s.dp === undefined ? 0 : s.dp) +
				(s.unit || '') + '</b>';
		}
		return '<span><i style="background:' + s.color + '"></i>' +
			s.label + text + '</span>';
	}).join('');
	if (values) html += '<span class="at">' + hoverTime(atMs, hours) + '</span>';
	return html;
}

function historySeries() {
	if (!lastHistory) return null;
	var boards = lastHistory.boards || {};
	var key = Object.keys(boards)[0];
	var b = key ? boards[key] : {};
	var dropSensor = function(v) { return v === 0 || v === 127; };
	return {
		hash: [{ label: 'Hashrate', color: '#00F2F2', unit: ' GH/s', dp: 0,
		         points: lastHistory.hashrate || [] }],
		temp: [
			{ label: 'Chips', color: '#00F2F2', unit: '°C', dp: 0,
			  points: b.chiptemp || [], drop: dropSensor },
			{ label: 'PCB hot side', color: '#E0A030', unit: '°C', dp: 0,
			  points: b.pcbtemp1 || [], drop: dropSensor },
			{ label: 'PCB cool side', color: '#00A8DE', unit: '°C', dp: 0,
			  points: b.pcbtemp2 || [], drop: dropSensor }
		]
	};
}

function drawHistory() {
	var s = historySeries();
	if (!s) return;
	$('hashLegend').innerHTML = legendHTML(s.hash);
	$('tempLegend').innerHTML = legendHTML(s.temp);
	// yMin 0 on hashrate so a reboot ramp reads as the dip to zero it is,
	// rather than being rescaled into a cliff off the bottom of the axis.
	drawChart($('hashChart'), s.hash,
		{ hours: currentRange.hours, yMin: 0, legend: $('hashLegend') });
	drawChart($('tempChart'), s.temp,
		{ hours: currentRange.hours, legend: $('tempLegend') });
}

function setHistoryBusy(busy, label) {
	['hashCard', 'tempCard'].forEach(function(id) {
		var card = $(id);
		if (!card) return;
		card.className = busy ? 'card busy' : 'card';
		var text = card.querySelector('.spin-label');
		if (text) text.textContent = label || '';
	});
	Array.prototype.forEach.call($('ranges').children, function(b) {
		b.disabled = !!busy;
	});
}

/* Every request takes a ticket, and only the newest one is allowed to draw.
   Without this, clicking 6h then 30d leaves whichever the device finishes
   LAST on screen - and the long range is the slow one, so the common case is
   the chart quietly disagreeing with the highlighted button. */
var historyReq = 0;

function loadHistory(silent) {
	var id = ++historyReq;
	var range = currentRange;
	if (!silent) {
		setHistoryBusy(true, 'loading ' + range.label +
			(range.hint ? ' — ' + range.hint : '…'));
	}
	return getJSON('/history?hours=' + range.hours + '&points=' + range.points)
		.then(function(h) {
			if (id !== historyReq) return;      // superseded; discard
			lastHistory = h;
			drawHistory();
		})
		.catch(function(ex) {
			if (id !== historyReq) return;
			$('hashChart').innerHTML = '';
			$('hashLegend').textContent = 'history unavailable: ' + (ex.message || ex);
		})
		.then(function() {
			// Only the newest request may clear the busy state, or a stale
			// one landing late would un-dim a chart that is still loading.
			if (id === historyReq) setHistoryBusy(false);
		});
}

function buildRanges() {
	$('ranges').innerHTML = RANGES.map(function(r) {
		return '<button data-h="' + r.hours + '"' +
			(r === currentRange ? ' class="on"' : '') + '>' + r.label + '</button>';
	}).join('');
	Array.prototype.forEach.call($('ranges').children, function(btn) {
		btn.addEventListener('click', function() {
			var hours = Number(btn.getAttribute('data-h'));
			RANGES.forEach(function(r) { if (r.hours === hours) currentRange = r; });
			buildRanges();
			loadHistory();
		});
	});
}

/* --- chip history ----------------------------------------------------------

   /chiphistory answers in PARALLEL ARRAYS - one timestamps array and one array
   per metric - rather than the [epoch, value] pairs /history returns, so the
   two cannot share a loader. zip() below is the whole difference.

   The spread between tempMin and tempMax is the reason this page exists. The
   live grid above shows it at one instant; only the chart shows it widening,
   and a single chip pulling away from the others is how a cooling problem
   announces itself long before the average moves. */

var chipHistory = null;
var chipRange = RANGES[1];
var chipReq = 0;

function zip(times, values) {
	if (!times || !values) return [];
	var out = [], n = Math.min(times.length, values.length);
	for (var i = 0; i < n; i++) {
		if (values[i] === null || values[i] === undefined) continue;
		out.push([times[i], values[i]]);
	}
	return out;
}

function chipSeries() {
	if (!chipHistory) return null;
	var t = chipHistory.timestamps || [];
	var boards = chipHistory.boards || {};
	var key = Object.keys(boards)[0];
	var b = key ? boards[key] : {};
	// 0 and 127 are the sensor's two failure codes, not temperatures - the
	// same rule the History page applies. See the 127 C fix in the bridge.
	var dropSensor = function(v) { return v === 0 || v === 127; };
	return {
		temp: [
			{ label: 'Hottest chip', color: '#E0A030', unit: '°C', dp: 1,
			  points: zip(t, b.tempMax), drop: dropSensor },
			{ label: 'Average', color: '#00F2F2', unit: '°C', dp: 1,
			  points: zip(t, b.tempAvg), drop: dropSensor },
			{ label: 'Coldest chip', color: '#00A8DE', unit: '°C', dp: 1,
			  points: zip(t, b.tempMin), drop: dropSensor },
			{ label: 'SoC', color: '#8A94A6', unit: '°C', dp: 1,
			  points: zip(t, chipHistory.soc), drop: dropSensor }
		],
		volt: [
			{ label: 'Highest', color: '#E0A030', unit: ' mV', dp: 0,
			  points: zip(t, b.voltMax) },
			{ label: 'Average', color: '#00F2F2', unit: ' mV', dp: 0,
			  points: zip(t, b.voltAvg) },
			{ label: 'Lowest', color: '#00A8DE', unit: ' mV', dp: 0,
			  points: zip(t, b.voltMin) }
		],
		pll: [
			{ label: 'Highest', color: '#E0A030', unit: ' MHz', dp: 0,
			  points: zip(t, b.pllMax) },
			{ label: 'Average', color: '#00F2F2', unit: ' MHz', dp: 0,
			  points: zip(t, b.pllAvg) },
			{ label: 'Lowest', color: '#00A8DE', unit: ' MHz', dp: 0,
			  points: zip(t, b.pllMin) }
		]
	};
}

function drawChipHistory() {
	var s = chipSeries();
	if (!s) return;
	[['chipTemp', s.temp], ['chipVolt', s.volt], ['chipPll', s.pll]]
		.forEach(function(pair) {
			var id = pair[0], series = pair[1];
			$(id + 'Legend').innerHTML = legendHTML(series);
			// No yMin 0 here, unlike the hashrate chart: these are narrow bands
			// around a working point, and anchoring them at zero would flatten
			// the only thing worth seeing into a straight line.
			drawChart($(id + 'Chart'), series,
				{ hours: chipRange.hours, legend: $(id + 'Legend') });
		});
}

function setChipBusy(busy, label) {
	['chipTempCard', 'chipVoltCard', 'chipPllCard'].forEach(function(id) {
		var card = $(id);
		if (!card) return;
		card.className = busy ? 'card busy' : 'card';
		var text = card.querySelector('.spin-label');
		if (text) text.textContent = label || '';
	});
	Array.prototype.forEach.call($('chipRanges').children, function(b) {
		b.disabled = !!busy;
	});
}

function loadChipHistory() {
	var id = ++chipReq;                 // same stale-response guard as /history
	var range = chipRange;
	setChipBusy(true, 'loading ' + range.label + '…');
	return getJSON('/chiphistory?hours=' + range.hours + '&points=' + range.points)
		.then(function(h) {
			if (id !== chipReq) return;
			chipHistory = h;
			drawChipHistory();
		})
		.catch(function(ex) {
			if (id !== chipReq) return;
			$('chipTempChart').innerHTML = '';
			$('chipTempLegend').textContent =
				'chip history unavailable: ' + (ex.message || ex);
		})
		.then(function() {
			if (id === chipReq) setChipBusy(false);
		});
}

function buildChipRanges() {
	$('chipRanges').innerHTML = RANGES.map(function(r) {
		return '<button data-h="' + r.hours + '"' +
			(r === chipRange ? ' class="on"' : '') + '>' + r.label + '</button>';
	}).join('');
	Array.prototype.forEach.call($('chipRanges').children, function(btn) {
		btn.addEventListener('click', function() {
			var hours = Number(btn.getAttribute('data-h'));
			RANGES.forEach(function(r) { if (r.hours === hours) chipRange = r; });
			buildChipRanges();
			loadChipHistory();
		});
	});
}

/* --- fan control -----------------------------------------------------------

   The bridge CLAMPS rather than refuses: ask for 200% and it stores 100 and
   says so in the reply. So the form is repopulated from what came back, not
   from what was typed, and anything that changed on the way in is named. A
   silent clamp would leave the page showing a setting the machine is not
   running - the same class of lie as the startup log that announced "bridge
   up" before it had bound a port. */

var fanLimits = { floor: 10, targetMin: 40, targetMax: 85 };

function fanSummary(fan) {
	var live = fan.live || {};
	var rpm = num(live.rpm), ratio = num(live.ratio);
	var bits = [];
	bits.push('<b>' + (fan.mode === 'fixed' ? 'Fixed duty' : 'Holding ' +
		esc(fan.target) + ' °C') + '</b>');
	if (ratio !== null) bits.push(ratio + '% duty');
	bits.push(rpm === null ? 'rpm unknown'
		: (rpm === 0 ? 'tach idle (below ~19%)' : rpm + ' rpm'));
	if (fan.mode !== 'fixed') {
		bits.push('range ' + esc(fan.minfan) + '–' + esc(fan.maxfan) + '%');
	}
	return bits.join(' · ');
}

function fillFanForm(fan) {
	if (fan.limits) fanLimits = fan.limits;
	$('fanNow').innerHTML = fanSummary(fan);
	$('fanModeSel').value = fan.mode === 'fixed' ? 'fixed' : 'target';
	$('fanTargetIn').value = num(fan.target) === null ? '' : fan.target;
	$('fanRatioIn').value = num(fan.ratio) === null ? '' : fan.ratio;
	$('fanMinIn').value = num(fan.minfan) === null ? '' : fan.minfan;
	$('fanMaxIn').value = num(fan.maxfan) === null ? '' : fan.maxfan;
	$('fanTargetIn').min = fanLimits.targetMin;
	$('fanTargetIn').max = fanLimits.targetMax;
	$('fanMinIn').min = fanLimits.floor;
	$('fanMaxIn').min = fanLimits.floor;
	syncFanMode();
}

// In target mode the duty is the controller's to choose, so showing an
// editable box for it invites someone to set a value that is immediately
// overwritten. Disabled rather than hidden, so the layout does not jump.
function syncFanMode() {
	var fixed = $('fanModeSel').value === 'fixed';
	$('fanRatioIn').disabled = !fixed;
	$('fanTargetIn').disabled = fixed;
	$('fanMinIn').disabled = fixed;
	$('fanMaxIn').disabled = fixed;
}

function loadFanConfig() {
	return getJSON('/fan').then(fillFanForm).catch(function(ex) {
		$('fanMsg').className = 'power-msg bad';
		$('fanMsg').textContent = 'could not read the fan: ' + (ex.message || ex);
	});
}

function submitFan(event) {
	event.preventDefault();
	var asked = {
		mode: $('fanModeSel').value,
		ratio: Number($('fanRatioIn').value),
		target: Number($('fanTargetIn').value),
		minfan: Number($('fanMinIn').value),
		maxfan: Number($('fanMaxIn').value)
	};
	var msg = $('fanMsg');
	$('fanSave').disabled = true;
	msg.className = 'power-msg';
	msg.textContent = 'applying…';

	fetch('/setfan', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(asked)
	}).then(function(r) {
		return r.json().then(function(d) {
			if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
			return d;
		});
	}).then(function(d) {
		var stored = d.fan || {};
		// Name every field the device changed. This is the whole point of
		// reading the response instead of assuming the request took.
		var changed = ['mode', 'ratio', 'target', 'minfan', 'maxfan']
			.filter(function(k) {
				return String(asked[k]) !== String(stored[k]);
			})
			.map(function(k) { return k + ' ' + asked[k] + ' → ' + stored[k]; });
		msg.className = 'power-msg';
		msg.textContent = changed.length
			? 'applied, with changes: ' + changed.join(', ')
			: 'applied';
		// Re-read rather than trusting the echo: /setfan returns the CONFIG,
		// and what the fan is actually doing lives under live on /fan.
		return loadFanConfig();
	}).catch(function(ex) {
		msg.className = 'power-msg bad';
		msg.textContent = 'could not apply: ' + (ex.message || ex);
	}).then(function() {
		$('fanSave').disabled = false;
	});
}

/* --- clock -----------------------------------------------------------------

   Two-step rather than a confirm() dialog, deliberately: a modal dialog blocks
   the page and this control reboots the miner, so the confirmation is in the
   button itself and says what it will do. */

var clockArmed = false;
var clockState = null;

function loadClock() {
	return getJSON('/clock').then(function(c) {
		clockState = c;
		var sel = $('clockSel'), out = [];
		for (var mhz = c.min; mhz <= c.max; mhz += (c.step || 5)) {
			out.push('<option value="' + mhz + '"' +
				(mhz === c.configured ? ' selected' : '') + '>' + mhz + ' MHz' +
				(mhz === c.configured ? ' (current)' : '') + '</option>');
		}
		sel.innerHTML = out.join('');
		var live = num(c.live);
		$('clockNow').innerHTML = '<b>' + esc(c.configured) + ' MHz</b> configured' +
			(live === null ? '' : ' · ' + live.toFixed(0) + ' MHz reported by the chips') +
			' · range ' + esc(c.min) + '–' + esc(c.max) + ' in ' + esc(c.step) + ' MHz steps';
		disarmClock();
	}).catch(function(ex) {
		$('clockMsg').className = 'power-msg bad';
		$('clockMsg').textContent = 'could not read the clock: ' + (ex.message || ex);
	});
}

function disarmClock() {
	clockArmed = false;
	$('clockSave').textContent = 'Apply';
	$('clockSave').className = '';
}

function submitClock(event) {
	event.preventDefault();
	var mhz = Number($('clockSel').value);
	var msg = $('clockMsg');

	if (clockState && mhz === clockState.configured) {
		msg.className = 'power-msg';
		msg.textContent = 'already set to ' + mhz + ' MHz — nothing to do';
		return;
	}

	if (!clockArmed) {
		clockArmed = true;
		$('clockSave').textContent = 'Confirm ' + mhz + ' MHz — REBOOTS the miner';
		$('clockSave').className = 'danger';
		msg.className = 'power-msg bad';
		msg.textContent = 'This writes the EEPROM and reboots immediately.'
			+ ' Mining stops for a boot and about an hour of warm-up.'
			+ ' Click again to go ahead, or change the selection to cancel.';
		return;
	}

	$('clockSave').disabled = true;
	msg.className = 'power-msg';
	msg.textContent = 'writing ' + mhz + ' MHz…';
	fetch('/setclock', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mhz: mhz })
	}).then(function(r) {
		return r.json().then(function(d) {
			if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
			return d;
		});
	}).then(function(d) {
		msg.className = 'power-msg';
		msg.textContent = (d.note || 'clock set') +
			' — this page will stop responding until the miner is back.';
	}).catch(function(ex) {
		msg.className = 'power-msg bad';
		msg.textContent = 'could not set the clock: ' + (ex.message || ex);
	}).then(function() {
		$('clockSave').disabled = false;
		disarmClock();
	});
}

/* --- logs ------------------------------------------------------------------

   The tail, not the whole file: his.log alone is 2.3 MB and the end is the
   part anyone wants. Download is offered separately for the rest.

   /logfile serves by NAME against a fixed catalogue - the name is never joined
   onto a directory, so there is no path to traverse. */

var LOG_TAIL_LINES = 300;
var LOG_BIG_BYTES = 1024 * 1024;

function fmtBytes(n) {
	var v = num(n);
	if (v === null) return '—';
	if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
	if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
	return v + ' B';
}

function loadLogs() {
	return getJSON('/logs').then(function(d) {
		var head = '<tr><th>Log</th><th>Where</th><th>Size</th><th>Changed</th>'
			+ '<th>What it is</th><th></th></tr>';
		$('logTable').innerHTML = head + (d.logs || []).map(function(l) {
			var mod = num(l.modified);
			return '<tr><td>' + esc(l.name) + '</td>' +
				'<td>' + esc(l.source === 'card' ? 'SD card' : 'NAND') + '</td>' +
				'<td>' + esc(fmtBytes(l.bytes)) + '</td>' +
				'<td>' + (mod === null ? '—' : esc(new Date(mod).toLocaleString())) + '</td>' +
				'<td>' + esc(l.label) + '</td>' +
				'<td><button type="button" data-log="' + esc(l.name) + '">tail</button> ' +
				'<a href="/logfile?name=' + encodeURIComponent(l.name) + '">download</a>' +
				'</td></tr>';
		}).join('');
		Array.prototype.forEach.call($('logTable').querySelectorAll('button'),
			function(btn) {
				btn.addEventListener('click', function() {
					tailLog(btn.getAttribute('data-log'), d.logs || []);
				});
			});
	}).catch(function(ex) {
		$('logTable').innerHTML = '<tr><td>could not list the logs: ' +
			esc(ex.message || ex) + '</td></tr>';
	});
}

function tailLog(name, logs) {
	var entry = null;
	logs.forEach(function(l) { if (l.name === name) entry = l; });
	var card = $('logViewCard'), view = $('logView');
	card.className = 'card';
	$('logViewName').textContent = name + ' — loading…';
	view.textContent = '';
	// Named rather than blocked: fetching 2 MB over a LAN is fine, it is the
	// miner's 500 MHz core serving it that is slow, and the wait is worth
	// knowing about before it happens rather than after.
	if (entry && num(entry.bytes) > LOG_BIG_BYTES) {
		$('logViewName').textContent = name + ' — reading ' +
			fmtBytes(entry.bytes) + ', this takes a moment…';
	}
	fetch('/logfile?name=' + encodeURIComponent(name), { cache: 'no-store' })
		.then(function(r) {
			if (!r.ok) throw new Error('HTTP ' + r.status);
			return r.text();
		})
		.then(function(text) {
			var lines = text.replace(/\s+$/, '').split('\n');
			var shown = lines.slice(-LOG_TAIL_LINES);
			$('logViewName').textContent = name + ' — last ' + shown.length +
				' of ' + lines.length + ' lines';
			view.textContent = shown.join('\n');
			view.scrollTop = view.scrollHeight;
		})
		.catch(function(ex) {
			$('logViewName').textContent = name + ' — could not read: ' +
				(ex.message || ex);
		});
}

/* --- swarm -----------------------------------------------------------------

   The peer list is written whole, not patched: POST /peers replaces it, so
   adding or removing one means sending the rest back unchanged. */

var peerList = [];
var peerMax = 0;
var editingPeer = -1;

/* A name is written to rxd_peers.conf as "<host>  <name>" and read back with
   split(None, 1), so SPACES ARE SAFE and survive the round trip. Two things
   are not, and the bridge guards against neither:

     * '#' - peers() does line.split('#', 1)[0], so everything from a hash
       onward is treated as a comment and the name is silently truncated.
     * newlines and other control characters - the file is one peer per line,
       so a name carrying a newline injects a line into the config.

   Both are stripped here rather than rejected: someone typing "shed #2" means
   "shed 2", not an error message. */
function tidyPeerName(text) {
	return String(text || '')
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/#/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function loadPeers() {
	return getJSON('/peers').then(function(d) {
		peerList = d.peers || [];
		peerMax = d.max || 0;
		renderPeers();
	}).catch(function(ex) {
		$('peerTable').innerHTML = '<tr><td>could not read peers: ' +
			esc(ex.message || ex) + '</td></tr>';
	});
}

function renderPeers() {
	if (!peerList.length) {
		$('peerTable').innerHTML =
			'<tr><td>No peers yet. Add one above, or scan the subnet.</td></tr>';
		return;
	}
	$('peerTable').innerHTML =
		'<tr><th>Name</th><th>Address</th><th></th></tr>' +
		peerList.map(function(p, i) {
			if (i === editingPeer) {
				// value= rather than textContent: this is the one place a peer
				// name goes back into markup, so it is escaped on the way in.
				return '<tr><td><input type="text" id="peerRename" maxlength="40"' +
					' value="' + esc(p.name || '') + '"></td>' +
					'<td>' + esc(p.host) + '</td>' +
					'<td><button type="button" data-act="save" data-i="' + i +
					'">save</button> <button type="button" data-act="cancel"' +
					' data-i="' + i + '">cancel</button></td></tr>';
			}
			return '<tr><td>' + esc(p.name || '—') + '</td><td>' + esc(p.host) +
				'</td><td><button type="button" data-act="rename" data-i="' + i +
				'">rename</button> <button type="button" data-act="remove"' +
				' data-i="' + i + '">remove</button></td></tr>';
		}).join('') +
		(peerMax ? '<tr><td colspan="3">' + peerList.length + ' of ' + peerMax +
			' allowed</td></tr>' : '');

	Array.prototype.forEach.call($('peerTable').querySelectorAll('button'),
		function(btn) {
			btn.addEventListener('click', function() {
				peerAction(btn.getAttribute('data-act'),
					Number(btn.getAttribute('data-i')));
			});
		});

	var box = $('peerRename');
	if (box) {
		box.focus();
		box.select();
		box.addEventListener('keydown', function(ev) {
			// Enter saves and Escape cancels, because a rename that needs the
			// mouse for a two-character edit is a rename nobody does.
			if (ev.key === 'Enter') { ev.preventDefault(); peerAction('save', editingPeer); }
			else if (ev.key === 'Escape') { ev.preventDefault(); peerAction('cancel', editingPeer); }
		});
	}
}

function peerAction(act, i) {
	if (act === 'remove') {
		editingPeer = -1;
		savePeers(peerList.filter(function(_, n) { return n !== i; }), 'removed');
		return;
	}
	if (act === 'rename') {
		editingPeer = i;
		$('peerMsg').textContent = '';
		renderPeers();
		return;
	}
	if (act === 'cancel') {
		editingPeer = -1;
		renderPeers();
		return;
	}
	if (act !== 'save') return;

	var box = $('peerRename');
	var typed = box ? box.value : '';
	var name = tidyPeerName(typed);
	editingPeer = -1;

	if (name === (peerList[i] || {}).name) {
		renderPeers();
		$('peerMsg').className = 'power-msg';
		$('peerMsg').textContent = 'name unchanged';
		return;
	}
	var next = peerList.map(function(p, n) {
		return n === i ? { host: p.host, name: name } : p;
	});
	// An empty name is legal and means "show the address": peers() falls back
	// to the host when the label is missing. Worth saying, because the row
	// then looks like the rename did not take.
	savePeers(next, name ? 'renamed' : 'name cleared — the address is shown instead')
		.then(function() {
			// Only when the save actually worked, and only when tidying
			// changed what was typed - silently storing something different
			// from what someone entered is the thing being avoided here.
			var msg = $('peerMsg');
			if (msg.className.indexOf('bad') < 0 && name !== typed.trim()) {
				msg.textContent += ' — stored as "' + name + '"';
			}
		});
}

function savePeers(entries, verb) {
	var msg = $('peerMsg');
	msg.className = 'power-msg';
	msg.textContent = 'saving…';
	return fetch('/peers', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ peers: entries })
	}).then(function(r) {
		return r.json().then(function(d) {
			if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
			return d;
		});
	}).then(function(d) {
		peerList = d.peers || [];
		renderPeers();
		msg.textContent = verb + ' — ' + peerList.length + ' peer' +
			(peerList.length === 1 ? '' : 's');
		return loadSwarm();
	}).catch(function(ex) {
		msg.className = 'power-msg bad';
		msg.textContent = 'could not save peers: ' + (ex.message || ex);
	});
}

function addPeer(event) {
	event.preventDefault();
	var host = $('peerHost').value.trim();
	if (!host) {
		$('peerMsg').className = 'power-msg bad';
		$('peerMsg').textContent = 'enter an address';
		return;
	}
	var next = peerList.concat([{ host: host, name: $('peerName').value.trim() }]);
	savePeers(next, 'added').then(function() {
		$('peerHost').value = '';
		$('peerName').value = '';
	});
}

// The bridge wants exactly "10.0.0" - three octets, no trailing dot. Typing
// the dot after the third octet is the natural thing to do and got a bare
// "prefix must look like 10.0.0" rejection, so it is trimmed here rather than
// loosening the guard on the device.
function tidyPrefix(text) {
	return String(text || '').trim().replace(/\.+$/, '');
}

// Prefill from whatever host this page was loaded over, so scanning the
// miner's own /24 - the only subnet most people want - needs no typing.
function defaultPrefix() {
	var m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(location.hostname);
	return m ? m[1] : '';
}

function scanSubnet() {
	var prefix = tidyPrefix($('scanPrefix').value) || defaultPrefix();
	$('scanPrefix').value = prefix;
	var msg = $('peerMsg');
	msg.className = 'power-msg';
	msg.textContent = 'scanning ' + (prefix || 'this subnet') + '…';
	$('scanBtn').disabled = true;
	fetch('/scan', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ prefix: prefix })
	}).then(function(r) {
		return r.json().then(function(d) {
			if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
			return d;
		});
	}).then(function(d) {
		// `new` is the useful half: hosts that answered and are NOT already
		// peers. Reporting the full list alone makes a rescan look like it
		// found something every time.
		var found = d.found || [], fresh = d['new'] || [];
		// A scan only reports; it never edits the peer list on its own. Joining
		// a machine to a swarm is a decision, and not one a subnet sweep is
		// entitled to make on someone's behalf.
		if (!found.length) {
			msg.textContent = 'nothing answered on ' + prefix + '.0/24';
		} else if (!fresh.length) {
			msg.textContent = 'found ' + found.length + ', all already peers: ' +
				found.join(', ');
		} else {
			msg.textContent = 'found ' + fresh.length + ' not yet a peer: ' +
				fresh.join(', ') + ' — add the ones you want above';
		}
	}).catch(function(ex) {
		msg.className = 'power-msg bad';
		msg.textContent = 'scan failed: ' + (ex.message || ex);
	}).then(function() {
		$('scanBtn').disabled = false;
	});
}

function loadSwarm() {
	return getJSON('/swarm').then(function(s) {
		var rate = num(s.hashrate);
		$('swarmNow').innerHTML = '<b>' + (rate === null ? '—' : rate.toFixed(0)) +
			' GH/s</b> across ' + esc(s.alive) + ' of ' + esc(s.count) +
			' miner' + (s.count === 1 ? '' : 's');
		$('swarmTable').innerHTML =
			'<tr><th>Miner</th><th>GH/s</th><th>Clock</th><th>Chips</th>' +
			'<th>Chip max</th><th>Fan</th><th>Shares</th><th>Uptime</th></tr>' +
			(s.miners || []).map(function(m) {
				if (!m.alive) {
					return '<tr><td>' + esc(m.name || m.host) +
						'</td><td colspan="7" class="bad">not answering' +
						(m.error ? ' — ' + esc(String(m.error).slice(0, 60)) : '') +
						'</td></tr>';
				}
				var dash = function(v, suffix) {
					return v === null || v === undefined ? '—' : esc(v) + (suffix || '');
				};
				return '<tr><td>' + esc(m.name || m.host) +
					(m.stock ? ' <span class="pill">stock</span>' : '') + '</td>' +
					'<td>' + dash(num(m.hashrate) === null ? null : num(m.hashrate).toFixed(0)) + '</td>' +
					'<td>' + dash(m.mhz === null ? null : m.mhz, ' MHz') + '</td>' +
					'<td>' + dash(m.chips) + '</td>' +
					'<td>' + dash(m.tempMax === null ? null : m.tempMax, ' °C') + '</td>' +
					'<td>' + dash(m.fanRpm === null ? null : m.fanRpm, ' rpm') + '</td>' +
					'<td>' + dash(m.accepted) +
					(num(m.rejected) ? ' / ' + esc(m.rejected) + ' rej' : '') + '</td>' +
					'<td>' + esc(fmtUptime(num(m.uptime))) + '</td></tr>';
			}).join('');
	}).catch(function(ex) {
		$('swarmTable').innerHTML = '<tr><td>swarm unavailable: ' +
			esc(ex.message || ex) + '</td></tr>';
	});
}

var resizeTimer = null;
window.addEventListener('resize', function() {
	// Redraw from the data already held - the geometry changed, not the
	// readings, so there is nothing to refetch. Pointless while the charts are
	// on a hidden page: they have no width there, and showing the page redraws
	// them anyway.
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(function() {
		if (currentPage.id === 'history') drawHistory();
		if (currentPage.id === 'chips') drawChipHistory();
	}, 180);
});

/* --- recorded operating points --------------------------------------------

   The one number this machine cannot measure for itself. There is no power
   sensor anywhere on the board, so wall watts come from a person with a
   meter, and until now every GH/W comparison this project made was assembled
   by hand and then lost.

   Each row carries its uptime, and rows taken inside the warm-up hour are
   marked, because that is what decides whether two rows are comparable at
   all. A point recorded 17 minutes after a restart and one recorded at 8
   hours are different measurements however similar the watts look - this
   board read 295 GH and 320 GH at identical chip temperatures for exactly
   that reason.
*/

var powerPoints = [];

function fmtWhen(epochSeconds) {
	var d = new Date(epochSeconds * 1000);
	function p(n) { return (n < 10 ? '0' : '') + n; }
	return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' +
		p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtAgo(epochSeconds) {
	var s = Date.now() / 1000 - epochSeconds;
	if (s < 90) return 'just now';
	if (s < 5400) return Math.round(s / 60) + ' min ago';
	if (s < 172800) return Math.round(s / 3600) + ' h ago';
	return Math.round(s / 86400) + ' d ago';
}

function renderPower() {
	var rows = powerPoints.slice().sort(function(a, b) { return b.epoch - a.epoch; });
	var rated = rows.filter(function(r) { return r.ghPerW; });
	var best = rated.length
		? rated.reduce(function(a, b) { return b.ghPerW > a.ghPerW ? b : a; })
		: null;

	if (!rows.length) {
		$('powerNow').innerHTML = 'No points recorded yet. Read your meter and' +
			' enter the watts below — everything else is captured for you.';
	} else {
		var latest = rows[0];
		var bits = ['Latest <b>' + (latest.ghPerW || '—') + ' GH/W</b>'];
		if (latest.gh) bits.push(latest.gh + ' GH at ' + latest.watts + ' W');
		bits.push(fmtAgo(latest.epoch));
		var line = bits.join(' · ');
		if (best && best !== latest && best.ghPerW > latest.ghPerW) {
			line += ' — best recorded is <b>' + best.ghPerW + ' GH/W</b>' +
				(best.note ? ' (' + best.note + ')' : '') + ', ' + fmtAgo(best.epoch);
		}
		$('powerNow').innerHTML = line;
	}

	if (!rows.length) { $('powerTable').innerHTML = ''; return; }

	var head = '<tr><th>When</th><th>Watts</th><th>GH/s</th><th>MHz</th>' +
		'<th>GH/W</th><th>Chips</th><th>Uptime</th><th>Note</th></tr>';
	var body = rows.map(function(r) {
		// Marked, not hidden. A row taken during the warm-up is still a real
		// reading of a real machine state - it just cannot be compared with a
		// settled one, and saying so is more useful than dropping it.
		var warm = r.uptimeSeconds !== null && r.uptimeSeconds !== undefined &&
			r.uptimeSeconds < SOAK_SECONDS;
		var up = (r.uptimeSeconds === null || r.uptimeSeconds === undefined)
			? '—' : fmtUptime(r.uptimeSeconds);
		return '<tr' + (best && r.epoch === best.epoch ? ' class="best"' : '') + '>' +
			'<td>' + fmtWhen(r.epoch) + '</td>' +
			'<td>' + r.watts + '</td>' +
			'<td>' + (r.gh === null || r.gh === undefined ? '—' : r.gh) + '</td>' +
			'<td>' + (r.mhz || '—') + '</td>' +
			'<td>' + (r.ghPerW || '—') + '</td>' +
			'<td>' + (r.chipMean === null || r.chipMean === undefined
				? '—' : r.chipMean + '°') + '</td>' +
			'<td' + (warm ? ' class="warm" title="Recorded inside the warm-up hour'
				+ ' - hashrate was still climbing, so this row is not comparable'
				+ ' with a settled one."' : '') + '>' + up + (warm ? ' *' : '') + '</td>' +
			'<td>' + (r.note || '') + '</td></tr>';
	}).join('');
	$('powerTable').innerHTML = head + body;
}

function loadPower() {
	return getJSON('/power').then(function(d) {
		powerPoints = d.points || [];
		renderPower();
	}).catch(function(ex) {
		$('powerMsg').className = 'power-msg bad';
		$('powerMsg').textContent = 'could not read recorded points: ' + (ex.message || ex);
	});
}

function submitPower(event) {
	event.preventDefault();
	var watts = Number($('watts').value);
	var msg = $('powerMsg');
	if (!isFinite(watts) || watts <= 0) {
		msg.className = 'power-msg bad';
		msg.textContent = 'enter the wall reading in watts';
		return;
	}
	$('powerSave').disabled = true;
	msg.className = 'power-msg';
	msg.textContent = 'recording…';
	fetch('/power', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ watts: watts, note: $('note').value || '' })
	}).then(function(r) {
		return r.json().then(function(d) {
			if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
			return d;
		});
	}).then(function(d) {
		var p = d.point || {};
		msg.className = 'power-msg';
		msg.textContent = 'recorded: ' + (p.ghPerW ? p.ghPerW + ' GH/W' : 'point saved');
		$('note').value = '';
		return loadPower();
	}).catch(function(ex) {
		msg.className = 'power-msg bad';
		msg.textContent = 'could not record: ' + (ex.message || ex);
	}).then(function() {
		$('powerSave').disabled = false;
	});
}

function tick() {
	var failures = [];
	Promise.all([
		soft('/performance', failures),
		soft('/chipinfo', failures),
		soft('/fan', failures),
		soft('/about', failures),
		soft('/pool', failures)
	]).then(function(res) {
		var perf = res[0], info = res[1], fan = res[2], about = res[3], pool = res[4];

		// Uptime gates the "still filling" marker and the warm-up banner.
		// Prefer the MINER's runtime: the board starts hashing about 39 s
		// after the kernel, so system uptime overstates how long there has
		// been a hashrate to average. Both are null-safe, and null means "do
		// not claim either way" rather than 0, which would assert the window
		// is full when we cannot tell.
		var uptime = about ? num(about.uptimeSeconds) : null;
		var miner = pool ? runtimeSeconds(pool.runtime) : null;
		if (miner !== null) uptime = (uptime === null) ? miner : Math.min(uptime, miner);

		if (pool) renderPool(pool);
		if (about) renderAbout(about);
		// Driven by uptime alone, so it is correct even when /performance is
		// the endpoint that failed - which is exactly when the figure on
		// screen is stalest and most likely to be misread.
		renderSoak(uptime);
		if (perf) renderPerf(perf, uptime);
		if (info) renderChips(info);
		if (fan) renderFan(fan);

		var ok = failures.length === 0;
		$('dot').className = ok ? 'dot live' : 'dot';
		$('status').textContent = (ok ? 'updated ' : 'partial ')
			+ new Date().toLocaleTimeString();
		// Panels whose endpoint answered are current; the rest are showing
		// their last good reading, so say which is which.
		setErr(ok ? '' : failures.join(' · ')
			+ ' — those panels are showing their last good reading.');
	});
}

/* The live tick runs whatever page is open: it carries the header's connection
   dot and timestamp, which are about the MACHINE rather than about the page,
   and five small endpoints cost far less than deciding per panel whether its
   page is visible. The history series is the opposite case - megabytes and
   seconds of log parsing - so it is fetched on demand and refreshed only
   while someone is looking at it. */
buildNav();
routeFromHash();
window.addEventListener('hashchange', routeFromHash);

$('powerForm').addEventListener('submit', submitPower);
$('fanForm').addEventListener('submit', submitFan);
$('fanModeSel').addEventListener('change', syncFanMode);
$('clockForm').addEventListener('submit', submitClock);
$('peerForm').addEventListener('submit', addPeer);
$('scanBtn').addEventListener('click', scanSubnet);
// Changing the selection cancels an armed confirmation, so a stray second
// click cannot land on a different clock than the one that was confirmed.
$('clockSel').addEventListener('change', function() {
	if (clockArmed) {
		disarmClock();
		$('clockMsg').textContent = '';
	}
});

tick();
setInterval(tick, REFRESH_MS);

// Silent: a spinner every two minutes on a chart nobody asked to reload is
// just flicker. The ticket system still protects it from racing a click.
// Long ranges opt out entirely - a 30-day window costs ~12 s of log parsing
// on a cold cache to gain one sample you could not see anyway.
setInterval(function() {
	if (currentPage.id === 'history' && currentRange.live) loadHistory(true);
}, 120000);
