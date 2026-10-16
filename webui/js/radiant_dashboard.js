/* Radiant (RXD) Dashboard - IceRiver RX0
   Brand: radiantblockchain.org/rxd-brand-guide.html */

var RXD = {
	history: { timestamps: [], hashrate: [], temp1: [], temp2: [], fan1: [], fan2: [] },
	// Per-chip series come from the bridge daemon, not /user/userpanel.
	// boards is keyed by board number as a string ("1", "2", ...), each
	// holding its own min/avg/max series aligned to the shared timestamps.
	chipHistory: {
		timestamps: [],
		boards: {}
	},
	maxPoints: 288, // 24 hours at 5-min intervals
	charts: {},
	chipBridgeUp: null,
	// Last /chipinfo payload, kept so the warm-up line can quote live chip
	// clocks between the bridge's own 60s polls.
	chip: null,
	// undefined until the bridge has answered once, so the row is not drawn
	// before there is anything to put in it.
	protection: undefined,
	refreshInFlight: false,
	// Epoch ms of the next scheduled refresh. The countdown reads this
	// rather than keeping its own clock, so it cannot drift out of step
	// with the refresh it is counting down to.
	nextRefreshAt: 0,
	initialized: false
};

// Served from port 80; the bridge is a separate listener on the same host.
/* The bridge listens twice: plain on 4112 and TLS on 4113. A page served over
   HTTPS must use the TLS port, because the browser blocks a plain-HTTP call
   from an HTTPS page as mixed content - and blocks it silently, which is why
   Protection, the chip charts and the clock pill were all missing on iPhone
   (https) while desktop (http) was fine. */
var RXD_BRIDGE_BASE = location.protocol + '//' + location.hostname +
	(location.protocol === 'https:' ? ':4113' : ':4112');
var RXD_BRIDGE_URL = RXD_BRIDGE_BASE + '/chipinfo';
var RXD_HISTORY_URL = RXD_BRIDGE_BASE + '/history?hours=24&points=288';
var RXD_CHIPHISTORY_URL = RXD_BRIDGE_BASE + '/chiphistory?hours=24&points=288';

/* Both history series append live samples roughly once a minute - the chip
   charts on their own 60 s interval, the board charts from the stock refresh
   hook - and in each case two can land close together, from a manual refresh
   or a double fire. Half a minute is well under either interval and well over
   the jitter, so this drops the duplicate without ever dropping a real sample.

   Both guards used to compare 'HH:MM' strings, which did the same job only
   because the points were minute-resolution strings to begin with. */
var RXD_MIN_SAMPLE_GAP_MS = 30000;
var RXD_CLOCK_URL = RXD_BRIDGE_BASE + '/clock';
var RXD_SETCLOCK_URL = RXD_BRIDGE_BASE + '/setclock';
var RXD_FAN_URL = RXD_BRIDGE_BASE + '/fan';
var RXD_SETFAN_URL = RXD_BRIDGE_BASE + '/setfan';
var RXD_PERF_URL = RXD_BRIDGE_BASE + '/performance';
var RXD_SWARM_URL = RXD_BRIDGE_BASE + '/swarm';
var RXD_PEERS_URL = RXD_BRIDGE_BASE + '/peers';
var RXD_SCAN_URL = RXD_BRIDGE_BASE + '/scan';

// The bridge reads hashrate, board temps and fan RPM out of three different
// log lines, written seconds apart, so no two of them share a timestamp. The
// hashrate line has the steadiest cadence and sets the timeline; the others
// snap to their nearest sample within half a logging interval, and anything
// further off is left at 0 rather than invented.
var RXD_SNAP_MS = 150000;

/* Official Radiant brand palette */
var RXD_BRAND = {
	black: '#000000',
	darkGrey: '#25252C',
	lightGrey: '#EDEDED',
	teal: '#00F2F2',
	softBlue: '#7FE0FF',
	skyBlue: '#00A8DE',
	blue1: '#4495F2',
	blue3: '#356FDB',
	blue5: '#1F4495',
	lightGreen: '#007A74',
	darkGreen: '#004946'
};

// Per-board colors for the chip charts (avg/min/max per board). Cycles if
// a unit ever reports more boards than this has entries for.
var RXD_BOARD_COLORS = [
	{ avg: RXD_BRAND.skyBlue,    min: RXD_BRAND.teal,      max: RXD_BRAND.softBlue },
	{ avg: RXD_BRAND.lightGrey,  min: RXD_BRAND.blue5,     max: RXD_BRAND.blue3 },
	{ avg: RXD_BRAND.lightGreen, min: RXD_BRAND.darkGreen, max: RXD_BRAND.blue1 }
];

var RXD_LOGO_SYMBOL =
	'<svg viewBox="0 0 145 136" xmlns="http://www.w3.org/2000/svg" class="rxd-symbol">' +
	'<path d="M88.6944 114.885C89.2163 115.401 89.906 115.675 90.6393 115.675H124.24C124.861 115.675 125.173 114.923 124.733 114.483L62.6656 52.4336C62.1421 51.9102 61.4321 51.6162 60.6918 51.6162H42.9265C36.6362 51.6162 33.4445 59.1721 37.8534 63.6587C51.6499 77.6978 74.3987 100.773 88.6944 114.885Z" fill="currentColor"/>' +
	'<path d="M72.158 20H18.7025C18.0741 20 17.7638 20.7679 18.2113 21.209C23.4549 26.3766 28.07 31.6859 33.3203 36.9323C33.9127 37.5244 34.5052 38.1164 35.2162 38.59C38.297 40.8398 41.7334 42.0239 45.6437 42.1423H81.6373C82.3483 42.1423 83.0593 42.1423 83.7702 42.2607C88.51 43.208 92.4203 47.9443 91.3539 53.6279C90.5517 57.9793 86.7573 61.2233 82.3285 61.4321C82.0026 61.4474 81.8539 61.842 82.0846 62.0727L97.6305 77.6142C98.2463 78.2298 99.1212 78.5604 99.9733 78.3817C99.9841 78.3795 99.9943 78.3773 100.004 78.3751C101.9 78.0199 103.796 77.191 105.573 76.2438C108.417 74.7045 111.024 72.6915 113.038 70.0866C116.712 65.2318 118.845 59.9035 119.2 53.8647C119.437 51.4965 119.319 49.1284 118.963 46.8786C118.489 43.9184 117.66 41.0766 116.475 38.3532C113.868 32.5512 109.839 27.9333 104.27 24.6179C99.767 22.0129 94.9088 20.7104 89.8135 20.2368C88.3915 20.1184 87.0881 20.1184 85.6661 20.1184C81.1634 20 76.6607 20 72.158 20Z" fill="currentColor"/>' +
	'</svg>';

var RXD_LOGO_WORDMARK =
	'<svg viewBox="0 0 545 93" xmlns="http://www.w3.org/2000/svg" class="rxd-wordmark">' +
	'<path d="M395.003 36.9684L434.683 71.5458C436.512 73.139 438.855 74.0167 441.28 74.0167C444.667 74.0167 447.413 71.2711 447.413 67.8841V20.1263H435.579V54.9308L396.91 21.0422C395.408 19.7258 393.478 19.0001 391.481 19C386.932 18.9999 383.244 22.6877 383.244 27.2368V72.8902H395.003V36.9684Z" fill="currentColor"/>' +
	'<path d="M138.172 35.3842L114.132 72.8902H98.5507L129.407 24.8774L129.408 24.8746C131.404 21.8085 134.161 19.2217 138.45 19.2217C142.53 19.2217 145.282 21.582 147.333 24.8608L177.408 72.8902H161.796L153.103 59.4143L153.096 59.4031C151.899 57.6431 150.096 54.7465 148.544 52.2544L148.506 52.193C148.352 51.9463 148.201 51.7036 148.054 51.4666L148.052 51.4635L138.172 35.3842Z" fill="currentColor"/>' +
	'<path d="M33.565 58.3342V72.8902H20.3897V47.018H62.6414C65.1995 47.018 67.5646 46.3805 69.3245 45.1492C71.1091 43.9005 72.2648 42.034 72.2648 39.7237C72.2648 37.2675 71.3239 35.3078 69.539 34.0033C67.8087 32.7385 65.4133 32.1826 62.6414 32.1826H20.3897L20.3896 20.1263H61.3744C66.9411 20.1263 73.1209 21.1014 77.8695 23.9068C82.5406 26.6665 85.8873 31.2225 85.8873 38.6546C85.8873 46.7703 81.3256 53.3122 73.7277 54.9889L72.0793 55.3527L75.4697 59.0006C76.4139 59.9535 77.5268 61.1568 78.9567 62.7525L79.1213 62.9296L79.118 62.9327C79.4384 63.2908 79.7744 63.6682 80.1277 64.0664L87.6942 72.8902H70.6192L57.2607 58.3342H33.565Z" fill="currentColor"/>' +
	'<path d="M189.612 32.1826V51.6093H202.862V32.1826H225.696C234.553 32.1826 241.58 38.2541 241.58 46.7138C241.58 50.9754 239.901 54.5764 237.033 57.0993C234.177 59.6115 230.209 60.9984 225.696 60.9984H202.862H189.612V72.8902H225.696C242.434 72.8902 254.606 61.2389 254.606 45.9737C254.606 30.8404 242.637 20.1263 225.696 20.1263H189.612V32.1826Z" fill="currentColor"/>' +
	'<path d="M333.154 35.3842L309.114 72.8902H293.533L324.389 24.8774L324.391 24.8736C326.387 21.8079 329.144 19.2217 333.432 19.2217C337.512 19.2217 340.264 21.582 342.315 24.8608L372.391 72.8902H356.288L348.094 59.4265L348.078 59.4031C346.882 57.6436 345.079 54.748 343.528 52.2564L343.526 52.2537L343.034 51.4635L333.154 35.3842Z" fill="currentColor"/>' +
	'<path d="M485.244 32.1826H459.179V20.1263H524.685V32.1826H498.419V72.8902H485.244V32.1826Z" fill="currentColor"/>' +
	'<path d="M281.633 72.8902V20.1263H268.457V72.8902H281.633Z" fill="currentColor"/>' +
	'</svg>';

var HC_DARK = {
	colors: [RXD_BRAND.teal, RXD_BRAND.softBlue, RXD_BRAND.skyBlue, RXD_BRAND.blue1,
	         RXD_BRAND.blue3, RXD_BRAND.lightGreen, RXD_BRAND.blue5, RXD_BRAND.darkGreen],
	chart: { backgroundColor: 'transparent', style: { fontFamily: "'Inter', system-ui, -apple-system, sans-serif" } },
	title: { style: { color: RXD_BRAND.lightGrey, fontSize: '14px', fontWeight: '600' } },
	subtitle: { style: { color: '#9A9AA5', fontSize: '11px' } },
	xAxis: {
		gridLineColor: '#2A2A33', lineColor: '#35353E', tickColor: '#35353E',
		labels: { style: { color: '#9A9AA5', fontSize: '10px' } },
		title: { style: { color: '#9A9AA5' } }
	},
	yAxis: {
		gridLineColor: '#2A2A33', lineColor: '#35353E', tickColor: '#35353E',
		labels: { style: { color: '#9A9AA5', fontSize: '10px' } },
		title: { style: { color: '#9A9AA5', fontSize: '11px' } }
	},
	legend: {
		itemStyle: { color: '#9A9AA5', fontSize: '11px' },
		itemHoverStyle: { color: RXD_BRAND.lightGrey }
	},
	tooltip: {
		backgroundColor: '#16161A', borderColor: '#35353E',
		style: { color: RXD_BRAND.lightGrey, fontSize: '12px' }
	},
	credits: { enabled: false }
};

/* rtpow is polymorphic: numeric 0 when idle, "274G" / "1.2T" while hashing.
   Always returns GH/s as a number. */
function rxdParseHashrate(v) {
	if (v === null || v === undefined) return 0;
	if (typeof v === 'number') return isFinite(v) ? v : 0;
	var s = String(v);
	var val = parseFloat(s);
	if (!isFinite(val)) return 0;
	if (s.indexOf('T') !== -1) return val * 1000;
	if (s.indexOf('M') !== -1) return val / 1000;
	if (s.indexOf('K') !== -1) return val / 1000000;
	return val;
}

function rxdNum(v) {
	var n = parseFloat(v);
	return isFinite(n) ? n : 0;
}

/* For charted sensors, where 0 is not a reading.
 *
 * A tach that reports 0 has not measured a stopped fan - it has failed to
 * measure anything, and the two are indistinguishable from the outside. The
 * same goes for a 0 degree chip. Plotting either as a value draws a cliff to
 * the floor of the axis, which is how a miner that was merely rebooting ends
 * up looking like one whose cooling died. null leaves a gap, which is what a
 * missing reading actually is.
 *
 * Deliberately not used for hashrate: zero hashrate is a real measurement. */
function rxdGap(v) {
	var n = parseFloat(v);
	return (isFinite(n) && n !== 0) ? n : null;
}

/* The other end of the same problem: 127 is the PCB sensors' failed read.
 *
 * 0x7F is the ceiling of the signed byte the stock firmware reports whole
 * degrees in, and the two board sensors land on it occasionally - five times
 * in 8,630 samples of his.log, 0.06%, both sensors affected. Every one is a
 * misread rather than a temperature:
 *
 * - the distribution runs continuously up to 84 C, then nothing at all
 *   between 85 and 126, then exactly 127. A real excursion fills in the climb.
 * - the other sensor read normally in the same sampling pass (54 C while
 *   temp1 claimed 127). Both sit on one small PCB.
 * - the chips read 76 C at that instant, and the board is heated BY the chips,
 *   so it is always the cooler of the two. 127 under 76 is backwards.
 * - always one isolated sample, never two in a row, hashrate unaffected.
 *
 * Exact equality, not a ceiling: the sensors are really 12-bit (0.0625 C) and
 * if the bridge ever exposes the low bits, a genuine reading near 127 should
 * still plot. What cannot be genuine is the saturation value itself.
 *
 * Only the two PCB sensors. The per-chip temperatures come over SPI, not the
 * bit-banged I2C bus these are on, and have never shown this value. */
var RXD_TEMP_SENTINEL = 127;

function rxdTempGap(v) {
	var n = rxdGap(v);
	return n === RXD_TEMP_SENTINEL ? null : n;
}

var RXD_UNIT_TO_GH = { H: 1e-9, K: 1e-6, M: 1e-3, G: 1, T: 1e3, P: 1e6 };

/* Whole-miner hashrate in GH/s, whatever state the payload is in.

   The stock content2() rewrites data.rtpow IN PLACE into raw H/s and parks the
   scaled figure in rtpow_hash/rtpow_unit, and it runs ahead of the content3
   hook this dashboard records from - so by the time the data arrives here
   "270G" has already become 270000000000. Prefer the scaled pair, and treat a
   bare number as the raw H/s it is. */
function rxdHashrateGH(data) {
	if (data.rtpow_hash !== undefined && data.rtpow_unit) {
		var scale = RXD_UNIT_TO_GH[String(data.rtpow_unit).charAt(0).toUpperCase()];
		if (scale) return rxdNum(data.rtpow_hash) * scale;
	}
	if (typeof data.rtpow === 'number') return data.rtpow / 1e9;
	return rxdParseHashrate(data.rtpow);
}

/* _v2 held hashrate in raw H/s, from before rxdHashrateGH, and would show up
   as a 10^9 spike on the new chart. _v3 is _v2 with epoch-millisecond
   timestamps instead of 'HH:MM' strings.

   Dropping _v2 rather than converting it is the point, not laziness. Those
   labels carry no date, and the array was stitched from whatever sessions
   this browser happened to have open, so a reading taken days ago sat beside
   today's with nothing to say so. That is how five sensor misreads from
   October 3rd-6th came to be drawn as spikes at "13:29" on the 16th. An
   instant cannot be recovered from an HH:MM, so the only honest thing to do
   with the old blob is discard it. */
var RXD_HIST_STORE = 'rxd_history_v3';

function rxdLoadHistory() {
	try {
		localStorage.removeItem('rxd_history_v2');
		var saved = localStorage.getItem(RXD_HIST_STORE);
		if (saved) {
			var parsed = JSON.parse(saved);
			if (parsed && parsed.timestamps && parsed.timestamps.length > 0) {
				RXD.history = parsed;
			}
		}
	} catch(e) {}
}

function rxdSaveHistory() {
	try {
		localStorage.setItem(RXD_HIST_STORE, JSON.stringify(RXD.history));
	} catch(e) {}
}

function rxdRecordData(data) {
	// Before the early-return below: the health row reflects the latest values
	// on every refresh, not only when a new history point is recorded.
	RXD.lastPanelData = data;
	try { rxdRenderHealth(data); } catch(e) { if (window.console) console.error('rxd health:', e); }

	if (!data) return;

	var ts = Date.now();
	var h = RXD.history;
	var last = h.timestamps[h.timestamps.length - 1];

	// A legacy 'HH:MM' tail is from the miner's clock or an older session.
	// Appending instants to it is the bug this replaced, so leave it for the
	// next seed to overwrite.
	if (h.timestamps.length > 0 && typeof last !== 'number') return;

	// Collapse repeat samples: the stock hook can fire more than once per
	// refresh. Was a same-minute string comparison, which this generalises.
	if (typeof last === 'number' && ts - last < RXD_MIN_SAMPLE_GAP_MS) return;

	h.timestamps.push(ts);
	h.hashrate.push(Math.round(rxdHashrateGH(data) * 100) / 100);

	// rxdTempGap, not rxdNum: the locally recorded history feeds the same
	// charts, so a sensor that did not answer has to leave a gap here too.
	var b = (data.boards && data.boards[0]) ? data.boards[0] : {};
	h.temp1.push(rxdTempGap(b.intmp));
	h.temp2.push(rxdTempGap(b.outtmp));

	var fans = data.fans || [];
	h.fan1.push(rxdGap(fans[0]));
	h.fan2.push(rxdGap(fans[1]));

	while (h.timestamps.length > RXD.maxPoints) {
		h.timestamps.shift(); h.hashrate.shift();
		h.temp1.shift(); h.temp2.shift();
		h.fan1.shift(); h.fan2.shift();
	}

	rxdSaveHistory();
}

/* --- device-side history -------------------------------------------------

   Everything in RXD.history above is recorded by this browser and kept in its
   localStorage, so it starts empty on a new machine and a reboot leaves a gap
   in it. The bridge can replay all of it from the miner's own logs, which is
   both older and the same for every browser, so that is preferred when it is
   reachable and the local copy is kept only as the fallback. */

function rxdClock(ms) {
	var d = new Date(ms);
	return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

/* The chart x-axis is categories, so it wants strings. Both rows of charts
   store instants and render them here, in the viewer's clock, at draw time.

   Legacy 'HH:MM' values pass through untouched rather than being mangled: a
   bridge older than this file sends them for /chiphistory, already rendered
   in the miner's clock, and an un-upgraded miner keeps the charts it had. */
function rxdTimeLabels(h) {
	return ((h && h.timestamps) || []).map(function(t) {
		return typeof t === 'number' ? rxdClock(t) : t;
	});
}

function rxdTimesAreEpoch(h) {
	return !!(h && h.timestamps && h.timestamps.length &&
	          typeof h.timestamps[0] === 'number');
}

/* How far a series may be snapped, derived from the series itself.
 *
 * The charts put every sensor on the hashrate series' timestamps, and the
 * bridge does NOT sample them all on one timer: the fan log lands about every
 * 286 s against the hashrate log's 303 s. Two grids that close drift past each
 * other by ~17 s per step, so with a fixed tolerance the offset exceeds it
 * roughly every nineteenth point and the nearest reading is rejected even
 * though it is right there. That drew a null every 19 samples - a gap every
 * ~95 minutes, suspiciously regular, and before nulls were gaps it drew a dip
 * to 0 rpm instead, which is what it was first reported as.
 *
 * A fixed 150 s was always going to do this: it is just under half the sample
 * interval, so the midpoint between two readings falls outside it. Scaling to
 * the series' own median spacing removes the beat, while still leaving a gap
 * for a genuinely missing reading, because a real hole is at least two
 * intervals wide and 1.5 medians will not reach across it. */
function rxdSnapWindow(points) {
	if (!points || points.length < 3) return RXD_SNAP_MS;
	var gaps = [];
	for (var i = 1; i < points.length; i++) {
		gaps.push(points[i][0] - points[i - 1][0]);
	}
	gaps.sort(function(a, b) { return a - b; });
	// Median, so the reboot-sized holes in the series do not widen it.
	return Math.max(RXD_SNAP_MS, Math.round(gaps[Math.floor(gaps.length / 2)] * 1.5));
}

// Points are [epoch ms, value] in ascending order. Walks forward from the
// last hit, so seeding a whole window stays linear rather than quadratic.
function rxdSnap(points, when, cursor, window) {
	if (!points || points.length === 0) return null;
	var i = cursor.i || 0;
	while (i + 1 < points.length &&
	       Math.abs(points[i + 1][0] - when) <= Math.abs(points[i][0] - when)) {
		i++;
	}
	cursor.i = i;
	return Math.abs(points[i][0] - when) <= (window || RXD_SNAP_MS) ? points[i] : null;
}

function rxdSeedHistory(payload) {
	var hash = (payload && payload.hashrate) || [];
	if (hash.length < 2) return false;

	// One board is the norm; a second would get its own chart series upstream
	// in the chip charts, and these three are whole-miner views.
	var keys = Object.keys(payload.boards || {}).sort();
	var board = keys.length ? payload.boards[keys[0]] : {};

	var seeded = { timestamps: [], hashrate: [], temp1: [], temp2: [], fan1: [], fan2: [] };
	var cursors = { t1: {}, t2: {}, fan: {} };
	// Each series gets its own tolerance, computed once - they are logged on
	// different timers and a shared constant beats against the difference.
	var windows = {
		t1: rxdSnapWindow(board.pcbtemp1),
		t2: rxdSnapWindow(board.pcbtemp2),
		fan: rxdSnapWindow(payload.fans)
	};

	hash.forEach(function(point) {
		var when = point[0];
		var t1 = rxdSnap(board.pcbtemp1, when, cursors.t1, windows.t1);
		var t2 = rxdSnap(board.pcbtemp2, when, cursors.t2, windows.t2);
		var fan = rxdSnap(payload.fans, when, cursors.fan, windows.fan);

		// The instant, not a label. rxdTimeLabels renders it at draw time.
		seeded.timestamps.push(when);
		seeded.hashrate.push(point[1]);
		seeded.temp1.push(rxdTempGap(t1 && t1[1]));
		seeded.temp2.push(rxdTempGap(t2 && t2[1]));
		seeded.fan1.push(rxdGap(fan && fan[1]));
		seeded.fan2.push(rxdGap(fan && fan[2]));
	});

	rxdCarryTail(RXD.history, seeded, ['hashrate', 'temp1', 'temp2', 'fan1', 'fan2']);

	while (seeded.timestamps.length > RXD.maxPoints) {
		for (var k in seeded) seeded[k].shift();
	}

	RXD.history = seeded;
	rxdSaveHistory();
	return true;
}

/* Append the local points the replay does not cover yet, so a re-seed cannot
   make the chart jump backwards. The flat parallel-array counterpart of
   rxdCarryChipTail; `keys` names the series beside `timestamps`.

   Both sides must be on epoch time for "newer" to mean anything. A legacy
   'HH:MM' local copy is simply dropped, which is what a re-seed is for. */
function rxdCarryTail(local, fresh, keys) {
	if (!rxdTimesAreEpoch(local) || !rxdTimesAreEpoch(fresh)) return;

	var last = fresh.timestamps[fresh.timestamps.length - 1];
	for (var i = 0; i < local.timestamps.length; i++) {
		if (local.timestamps[i] <= last) continue;
		fresh.timestamps.push(local.timestamps[i]);
		keys.forEach(function(k) {
			var v = local[k] ? local[k][i] : null;
			fresh[k].push(v === undefined ? null : v);
		});
	}
}

/* Re-fetched on a timer, not once per page load as it was.

   The replay covers 24 h and the live tail keeps arriving above, so one fetch
   looked like enough. It is not: live samples append about once a minute and
   RXD.maxPoints is 288, so after roughly 4.8 hours the appends have evicted
   every seeded point and the chart has quietly become "the last 4.8 hours
   this tab was open" while still being labelled a day. Re-seeding restores
   the real window; rxdCarryTail keeps the newest live points across it.

   Five minutes matches the bridge's own sampling, so a fetch never costs more
   than one sample's staleness. */
var RXD_HISTORY_REFRESH_MS = 300000;

function rxdFetchHistory() {
	return $.ajax({ url: RXD_HISTORY_URL, type: 'GET', dataType: 'json', timeout: 20000 })
		.done(function(payload) {
			if (rxdSeedHistory(payload)) rxdUpdateCharts();
			rxdRenderDayTile();
		});
		// On failure the locally recorded history is already loaded and the
		// charts draw from that, so there is nothing to handle.
}

/* --- live refresh ---------------------------------------------------------

   The stock home page renders itself exactly once, when it loads. base.js does
   set a 5-minute timer, but it only posts post=7 and calls login(re) - a
   session check, with the data refresh commented out beside it - so the tiles,
   pool table and board table sit frozen at whatever they held when the page
   opened. This re-runs the stock render chain on fresh data instead.

   Three details make it safe to call repeatedly:
   - content4/5/6 append rows without ever clearing, so their tables have to be
     emptied first or they grow a duplicate set every pass.
   - the stock highcharts() helper renders a new chart into the same container
     each time without destroying the previous one, which would pile up
     instances in a tab left open overnight.
   - no loading(1)/loaded() around it: the overlay those drive is for a user
     waiting on a click, and flashing it once a minute would be worse than the
     staleness this fixes. */

var RXD_REFRESH_MS = 60000;
var RXD_STOCK_CHART_ID = 'historyofboard';
var RXD_RENDER_CHAIN = ['content1', 'content7', 'content2', 'content3',
                        'content4', 'content5', 'content6'];

function rxdDropStockChart() {
	if (!window.Highcharts || !Highcharts.charts) return;
	Highcharts.charts.forEach(function(c) {
		if (!c) return;
		var el = c.renderTo || c.container;
		var id = el && (el.id || (el.parentNode && el.parentNode.id));
		if (id === RXD_STOCK_CHART_ID) {
			try { c.destroy(); } catch(e) {}
		}
	});
}

function rxdRefreshPanel() {
	// Only the home page carries these; on the settings pages there is
	// nothing to refresh and the chain would throw.
	if (RXD.refreshInFlight || $('.right .content2 .panlcss').length === 0) return;
	RXD.refreshInFlight = true;
	RXD.nextRefreshAt = Date.now() + RXD_REFRESH_MS;

	$.ajax({ url: '/user/userpanel', type: 'POST', data: { post: 4 },
	         dataType: 'json', timeout: 20000 })
		.done(function(re) {
			// A miner that has gone offline mid-session is left on screen as
			// it was: the stock path raises a modal here, which once a minute
			// would be unusable.
			if (!re || re.error !== 0 || !re.data) return;

			$('.right .content4 .poolcss tbody, .right .content5 .boardcss tbody,' +
			  ' .right .content6 .fancss tbody').empty();
			rxdDropStockChart();

			if (typeof window.login === 'function') login(re);
			if (typeof window.content1switchbox === 'function') content1switchbox(re.data);
			RXD_RENDER_CHAIN.forEach(function(fn) {
				// content3 is the base.js wrapper, so the charts, the warm-up
				// line and the protection row all come along with it.
				if (typeof window[fn] === 'function') {
					try { window[fn](re.data); }
					catch(e) { if (window.console) console.error('rxd refresh ' + fn + ':', e); }
				}
			});
			rxdRenderDayTile();
		})
		.always(function() { RXD.refreshInFlight = false; });
}

/* --- 24-hour hashrate ------------------------------------------------------

   Stock shows 5-minute and 30-minute figures, which are 6x apart and both
   describe right now. The day average answers a different question - what the
   machine actually delivered - and it is the most precise number available
   here: across seven untouched stock days the daily mean varied by 1.1 GH/s,
   against roughly 20 for a pool-side hourly figure.

   Having 30m and 24h side by side also gives the settling check for free. The
   miner's own average climbs for hours after a restart, so 30m well above 24h
   means it is still rising or the clock changed recently, and 30m near 24h
   means it has settled.

   The catch is that a day is long enough to span clock changes and restarts,
   and then the number is a blend rather than a result - it read 293 G while
   the miner was doing 318, because the window held four clock settings and
   three reboot ramps. So the tile detects that and says so rather than
   quietly averaging across it.

   Both inputs are already in memory: RXD.history from /history and
   RXD.chipHistory from /chiphistory, both seeded once per page load. Nothing
   here fetches anything. */

// Twelve five-minute samples: the warm-up hour that every measurement in this
// project drops before comparing anything.
var RXD_DAY_RAMP = 12;

function rxdDayStats() {
	var hr = (RXD.history && RXD.history.hashrate) || [];
	var i;

	var vals = [];
	for (i = 0; i < hr.length; i++) { if (hr[i] > 0) vals.push(hr[i]); }
	// Under an hour of history is not a day average by any reading.
	if (vals.length < 12) return null;

	var mean = 0;
	for (i = 0; i < vals.length; i++) mean += vals[i];
	mean = mean / vals.length;

	// Restarts show up as a short run of samples far below the window median:
	// the board ramps from near zero for about an hour after a boot. Counting
	// runs rather than points keeps one restart as one event.
	//
	// The first PCB temperature sample after a boot reads 0 C and would be a
	// cleaner marker, but it lasts around 30 s against a 5-minute sampling
	// interval, so rxdSnap nearly always lands on the real reading after it -
	// measured on a real payload it found none of three restarts. The hashrate
	// dip found all three at every threshold from 50% to 85% of the median.
	var sorted = vals.slice().sort(function(a, b) { return a - b; });
	var floorAt = sorted[Math.floor(sorted.length / 2)] * 0.7;
	var restarts = 0, inDip = false;
	for (i = 0; i < hr.length; i++) {
		if (!hr[i]) continue;
		if (hr[i] < floorAt) {
			if (!inDip) { restarts++; inDip = true; }
		} else { inDip = false; }
	}

	// Which clocks the window saw. One chip reading a single LSB low is a
	// readback artefact (799 of 800) and the clock steps in 5 MHz, so round to
	// 5 before counting distinct settings.
	//
	// Not paired with the hashrate series by timestamp. It used to be
	// impossible - the bridge labelled chip samples with the MINER's clock
	// while rxdClock labelled these with the BROWSER's, so every lookup missed
	// by the viewer's UTC offset and the per-clock figure below silently never
	// appeared. /chiphistory now returns epoch ms, so the two ARE comparable;
	// the fractions below are kept because the series still have different
	// cadences and thinnings, and matching by index costs nothing here.
	var ch = RXD.chipHistory || {};
	var boards = ch.boards || {};
	var keys = Object.keys(boards);
	var pll = keys.length ? (boards[keys[0]].pllAvg || []) : [];
	var seen = {};
	for (i = 0; i < pll.length; i++) {
		if (pll[i]) seen[Math.round(pll[i] / 5) * 5] = true;
	}
	var clocks = Object.keys(seen).map(Number).sort(function(a, b) { return a - b; });

	var current = null;
	for (i = pll.length - 1; i >= 0 && current === null; i--) {
		if (pll[i]) current = Math.round(pll[i] / 5) * 5;
	}
	// The live reading is fresher than the history and survives an empty tail.
	if (!current && RXD.chip && RXD.chip.pll && RXD.chip.pll.max) {
		current = Math.round(RXD.chip.pll.max / 5) * 5;
	}

	// How much of the window the current clock has been running. It is a
	// contiguous run at the end, so walk back until the clock changes - a gap
	// is not a change - and take the same fraction from the tail of the
	// hashrate series. Both are even-spread thinnings of one window ending
	// now, so the fractions correspond without the two agreeing on the time.
	var run = 0;
	for (i = pll.length - 1; i >= 0; i--) {
		if (!pll[i]) continue;
		if (Math.round(pll[i] / 5) * 5 !== current) break;
		run++;
	}
	var curSum = 0, curN = 0, curRamp = false;
	if (current && run && pll.length) {
		var take = Math.floor(hr.length * run / pll.length);
		var from = Math.max(0, hr.length - take);
		// Drop the run's own first hour. A clock change always involves a
		// restart and the miner's average climbs for hours afterwards, so
		// including it made this read 292.8 against a blended 293.5 - the two
		// were indistinguishable, which is exactly what the figure exists to
		// avoid. Only worth doing when something is left afterwards.
		if (take > RXD_DAY_RAMP + 6) { from += RXD_DAY_RAMP; curRamp = true; }
		for (i = from; i < hr.length; i++) {
			if (hr[i] > 0) { curSum += hr[i]; curN++; }
		}
	}

	return {
		mean: mean,
		samples: vals.length,
		restarts: restarts,
		clocks: clocks,
		current: current,
		// Six samples is half an hour; below that it is noise, not a figure.
		curMean: curN >= 6 ? curSum / curN : null,
		curN: curN,
		curRamp: curRamp
	};
}

function rxdRenderDayTile() {
	var host = $('.right .content2 .panlcss').has('.svgspeedcss').first();
	if (host.length === 0) return;

	var panel = $('.right .content2 .rxd-day-panel');
	if (panel.length === 0) {
		// Same shape as the stock tiles so the column layout and the flex rules
		// that centre them apply unchanged.
		panel = $('<div class="panlcss rxd-day-panel">' +
				'<p class="lan-trans">24h Hashrate</p>' +
				'<p><span class="rxd-day-value">-</span>' +
					'<span class="rxd-day-mark"></span>' +
					'&nbsp;&nbsp;<span class="rxd-day-unit"></span></p>' +
			'</div>');
		host.after(panel);
	}

	var s = rxdDayStats();
	if (!s) {
		panel.find('.rxd-day-value').text('-');
		panel.find('.rxd-day-unit').text('');
		panel.find('.rxd-day-mark').text('');
		panel.attr('title', 'Not enough history yet.');
		return;
	}

	panel.find('.rxd-day-value').text(s.mean.toFixed(0));
	panel.find('.rxd-day-unit').text('GH/s');

	var mixed = s.clocks.length > 1 || s.restarts > 0;
	var hours = (s.samples * 5 / 60).toFixed(1);
	var note = 'Mean of ' + s.samples + ' samples, about ' + hours + ' hours.';

	if (mixed) {
		var parts = [];
		if (s.clocks.length > 1) {
			parts.push(s.clocks.length + ' clock settings (' +
				s.clocks.join(', ') + ' MHz)');
		}
		if (s.restarts > 0) {
			parts.push(s.restarts + (s.restarts === 1 ? ' restart' : ' restarts'));
		}
		note += ' This window spans ' + parts.join(' and ') +
			', so it blends them rather than describing one setting.';
		if (s.curMean !== null) {
			note += ' At the current ' + s.current + ' MHz it is ' +
				s.curMean.toFixed(0) + ' GH/s over ' + s.curN + ' samples' +
				(s.curRamp ? ', warm-up hour dropped.' : '.');
		}
	}

	panel.find('.rxd-day-mark').text(mixed ? '*' : '');
	panel.toggleClass('is-mixed', mixed);
	panel.attr('title', note);
}

/* --- manual refresh and countdown -----------------------------------------

   The stock header carries a "refresh time" label and an .algocss3 span, and
   content1() rewrites it on every pass, so the page has always shown when it
   last updated. What it never showed is when the next one is due, or any way
   to ask for one now - which matters here because the refresh is ours (see
   rxdRefreshPanel) and runs only once a minute.

   The countdown is driven from RXD.nextRefreshAt, set by rxdRefreshPanel
   itself, rather than from a timer of its own. A manual refresh therefore
   restarts the interval instead of only resetting the display: otherwise the
   next automatic tick would arrive early and the countdown the user just
   watched would have been a lie.

   The control hides itself on the settings pages, using the same test
   rxdRefreshPanel uses, because there is nothing there for it to count down
   to. */

var RXD_REFRESH_TICK_MS = 1000;

var RXD_REFRESH_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
		'<path fill="currentColor" d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 ' +
			'7-7z"/>' +
	'</svg>';

function rxdRefreshIsHome() {
	return $('.right .content2 .panlcss').length > 0;
}

function rxdAddRefreshControl() {
	var stamp = $('.right .content1 .algocss3');
	if (stamp.length === 0) return;
	var host = stamp.closest('div');
	// content1() only rewrites individual spans, so the control survives a
	// refresh - but re-adding it is cheap and covers a re-rendered header.
	if (host.length === 0 || host.find('.rxd-refresh').length) return;

	var box = $('<span class="rxd-refresh">' +
			'<button type="button" class="rxd-refresh-btn" title="Refresh now">' +
				RXD_REFRESH_ICON +
			'</button>' +
			'<span class="rxd-refresh-next"></span>' +
			'<span class="rxd-refresh-bar"><i></i></span>' +
		'</span>');
	box.find('.rxd-refresh-btn').on('click', rxdRefreshNow);
	host.append(box);
}

function rxdScheduleRefresh() {
	if (RXD.refreshTimer) clearInterval(RXD.refreshTimer);
	RXD.refreshTimer = setInterval(rxdRefreshPanel, RXD_REFRESH_MS);
	RXD.nextRefreshAt = Date.now() + RXD_REFRESH_MS;
}

function rxdRefreshNow() {
	if (RXD.refreshInFlight) return;
	rxdScheduleRefresh();
	rxdRefreshPanel();
	// The bridge-backed pieces run on their own timers - chip data every
	// minute, Output every five - so without these a refresh the user asked
	// for would leave the clock pill and Output row stale behind everything
	// else on the card.
	rxdFetchChipData();
	rxdFetchPerformance();
}

function rxdRefreshTick() {
	var box = $('.rxd-refresh');
	if (box.length === 0) {
		rxdAddRefreshControl();
		box = $('.rxd-refresh');
		if (box.length === 0) return;
	}
	if (!rxdRefreshIsHome()) { box.addClass('is-off'); return; }
	box.removeClass('is-off');
	box.toggleClass('is-busy', !!RXD.refreshInFlight);

	var left = Math.max(0, RXD.nextRefreshAt - Date.now());
	box.find('.rxd-refresh-next')
		.text(RXD.refreshInFlight ? 'now' : Math.ceil(left / 1000) + 's');

	var done = RXD_REFRESH_MS ? (RXD_REFRESH_MS - left) / RXD_REFRESH_MS : 0;
	box.find('.rxd-refresh-bar > i')
		.css('width', Math.min(100, Math.max(0, done * 100)) + '%');
}

/* --- warm-up -------------------------------------------------------------

   rtpow is the miner's own 5-minute rolling average and it publishes nothing
   until a full window has closed, so for the first ~6 minutes after a restart
   the stock UI shows 0 GH/s and a red "Abnormal" pill while the miner is in
   fact already mining - shares are usually being accepted from about 2 minutes
   in. That window lives inside the closed miner binary and cannot be shortened
   from here, but it can be labelled for what it is, using evidence that does
   exist that early: the pool connection, accepted shares, and the chips
   themselves reporting clock and temperature through the bridge. */

var RXD_WARMUP_LIMIT = 15 * 60;   // past this, a zero really is a fault
var RXD_WARMUP_MIN_SHARES = 3;    // share arrival is Poisson; two can be 2x out

function rxdRuntimeSeconds(runtime) {
	var parts = String(runtime || '').split(':');
	if (parts.length !== 4) return 0;
	var n = parts.map(function(p) { return parseInt(p, 10); });
	if (n.some(function(v) { return isNaN(v); })) return 0;
	return ((n[0] * 24 + n[1]) * 60 + n[2]) * 60 + n[3];
}

function rxdLivePool(data) {
	var pools = data.pools || [];
	for (var i = 0; i < pools.length; i++) {
		if (rxdNum(pools[i].connect) === 1) return pools[i];
	}
	return null;
}

/* Hashrate implied by accepted shares, in GH/s.

   The pool's share difficulty is reported in hashes ("2199.02 G" = 2199.02 GH
   of work per share), so shares x difficulty / elapsed is a rate. Checked
   against a real restart: 25 shares in 261 s gave 211 GH/s where the miner
   went on to report 284 - the right order, and noisy, which is why it is only
   ever shown labelled as an estimate. */
function rxdShareEstimateGH(data, pool, elapsed) {
	if (!pool || elapsed < 60) return 0;
	var accepted = rxdNum(pool.accepted);
	if (accepted < RXD_WARMUP_MIN_SHARES) return 0;
	var perShare = rxdParseHashrate(pool.diff);
	if (!perShare) return 0;
	return accepted * perShare / elapsed;
}

function rxdRenderWarmup(data) {
	if (!data) return;

	var pill = $('.right .content2 .panlcss .speedcss').first();
	var panel = $('.right .content2 .panlcss').has('.nowspeedcss').first();
	if (pill.length === 0 || panel.length === 0) return;

	var elapsed = rxdRuntimeSeconds(data.runtime);
	var pool = rxdLivePool(data);
	var chips = (RXD.chip && RXD.chip.chipcount) || 0;
	var alive = !!pool || chips > 0;
	var warming = rxdHashrateGH(data) === 0 && alive && elapsed > 0 &&
	              elapsed < RXD_WARMUP_LIMIT;

	if (!warming) {
		panel.find('.rxd-warmup-note').remove();
		pill.removeClass('rxd-warmup-pill');

		// The stock page only refreshes every 5 minutes, so leaving the tile
		// for content2() to correct would strand "Warming up" on screen long
		// after the miner started reporting. Write the real figures from the
		// payload in hand instead - the same numbers, from the same endpoint,
		// just sooner.
		if (RXD.warmupActive) {
			RXD.warmupActive = false;
			var gh = rxdHashrateGH(data);
			if (gh > 0) {
				var scaled = gh >= 1000 ? gh / 1000 : gh;
				panel.find('.nowspeedcss').text(Math.round(scaled * 100) / 100);
				panel.find('.nowspeedunitcss').text(gh >= 1000 ? 'TH/s' : 'GH/s');
			}
			if (data.powstate === true) {
				pill.removeClass('content2radiusRedcss')
					.addClass('content2radiusGreencss')
					.text('Normal');
			}
		}
		return;
	}

	RXD.warmupActive = true;

	pill.removeClass('content2radiusGreencss content2radiusRedcss')
		.addClass('rxd-warmup-pill')
		.text('Warming up');

	var estimate = rxdShareEstimateGH(data, pool, elapsed);
	if (estimate > 0) {
		panel.find('.nowspeedcss').text(Math.round(estimate));
		panel.find('.nowspeedunitcss').text('GH/s (est.)');
	} else {
		// Saying nothing rather than asserting the 0 the miner is reporting.
		panel.find('.nowspeedcss').text('--');
	}

	var bits = [Math.floor(elapsed / 60) + ':' + ('0' + (elapsed % 60)).slice(-2)];
	if (chips) {
		bits.push(chips + ' chips' + (RXD.chip.pll && RXD.chip.pll.avg ?
			' @ ' + Math.round(RXD.chip.pll.avg) + ' MHz' : ''));
	}
	if (pool) bits.push(rxdNum(pool.accepted) + ' shares accepted');

	var note = panel.find('.rxd-warmup-note');
	if (note.length === 0) {
		note = $('<p class="rxd-warmup-note"></p>');
		panel.append(note);
	}
	note.text('5-minute average still filling - ' + bits.join(' · '));
}

/* The stock refresh runs every five minutes (base.js: setInterval(test,
   300000)), which is the other half of why a restart looks dead - even once
   the miner reports, the page can sit on the old zero for minutes. So while
   the warm-up state is live, poll the same endpoint on a much shorter timer.
   This is a read of one small JSON object, it only runs in the first minutes
   after a restart, and it stops itself the moment there is a real figure. */
var RXD_WARMUP_POLL_MS = 20000;

function rxdWarmupPoll() {
	$.ajax({ url: '/user/userpanel', type: 'POST', data: { post: 4 },
	         dataType: 'json', timeout: 15000 })
		.done(function(re) {
			if (!re || re.error !== 0 || !re.data) return;
			rxdRenderWarmup(re.data);

			var elapsed = rxdRuntimeSeconds(re.data.runtime);
			var settled = rxdHashrateGH(re.data) > 0 || elapsed >= RXD_WARMUP_LIMIT;
			if (settled && RXD.warmupTimer) {
				clearInterval(RXD.warmupTimer);
				RXD.warmupTimer = null;
			}
		});
}

/* Two sensors on one board, not two boards - so neither "PCB 1 / PCB 2" nor
   the stock "Temp. 1 / Temp. 2" says anything useful. What the readings
   themselves show, over 24h of the fans cycling on and off: sensor 1 sits in
   the hot zone, tracking chip temperature to within ~3 C and falling 10.6 C
   when the fans spin up, while sensor 2 runs ~20 C cooler and moves 6.5 C.
   Where each one physically sits is not something the data settles, so the
   labels describe what they read rather than where they are.

   The lan-trans class comes off: translate.js rewrites tagged elements from a
   phrase table on every language switch, which would put "Temp. 1" back. */
var RXD_BOARD_TEMP_NAMES = {
	'Temp. 1': { name: 'Sensor 1 (hot)',
	             hint: 'Hot zone - tracks chip temperature within ~3 C' },
	'Temp. 2': { name: 'Sensor 2 (cool)',
	             hint: 'Cooler part of the board - runs ~20 C below sensor 1' }
};

function rxdRenameBoardColumns() {
	$('.right .content5 th').each(function() {
		var th = $(this);
		var replacement = RXD_BOARD_TEMP_NAMES[th.text().trim()];
		if (replacement) {
			th.removeClass('lan-trans').text(replacement.name).attr('title', replacement.hint);
		}
	});
}

/* Three columns the stock Hash Board table does not carry: what voltage the
   chips sit at, what clock they are measured to be running, and how hot the
   hottest one is. The first two are the settings you change and the third is
   the reading protection acts on, so a board row without them describes the
   PCB rather than the silicon.

   Appended to the row content5 built, not woven into it: the stock renderer
   is left alone, and a firmware whose column order differs still works.

   The clock is snapped to the 5 MHz step for the same reason the chart is -
   the readback jitters one LSB and 774.917 in a summary row reads as a fault.
   See rxdChipSeries. */
var RXD_BOARD_EXTRA = [
	{ key: 'volt',  head: 'Voltage (avg)',
	  hint: 'Mean core voltage across this board\'s chips' },
	{ key: 'clock', head: 'Clock (avg)',
	  hint: 'Measured chip clock, rounded to the 5 MHz step it is set in' },
	{ key: 'ctemp', head: 'Chip temp (max)',
	  hint: 'Hottest chip on the board - the reading protection acts on' }
];

function rxdBoardExtraValues(boardNo) {
	// Dashes rather than zeros when the bridge has not answered: a board
	// reading 0 mV would be alarming, and it has not been measured at all.
	var out = { volt: '-', clock: '-', ctemp: '-' };
	var boards = (RXD.chip && RXD.chip.boards) || [];
	for (var i = 0; i < boards.length; i++) {
		var b = boards[i];
		if (String(b.board) !== String(boardNo)) continue;
		if (b.voltage && b.voltage.avg) out.volt = b.voltage.avg.toFixed(1) + ' mV';
		if (b.pll && b.pll.avg) {
			out.clock = (Math.round(b.pll.avg / RXD_CLOCK_STEP) * RXD_CLOCK_STEP) +
				' MHz';
		}
		if (b.temp && b.temp.max) out.ctemp = b.temp.max.toFixed(0) + ' \u00b0C';
		break;
	}
	return out;
}

function rxdAugmentBoardTable() {
	var table = $('.right .content5 .boardcss');
	if (table.length === 0) return;

	var head = table.find('thead tr').first();
	if (head.length && head.find('.rxd-board-extra').length === 0) {
		RXD_BOARD_EXTRA.forEach(function(c) {
			// No lan-trans: translate.js would rewrite these from the stock
			// phrase table on every language switch, as it does the two sensor
			// columns - see rxdRenameBoardColumns.
			head.append($('<th class="rxd-board-extra"></th>')
				.text(c.head).attr('title', c.hint));
		});
	}

	table.find('tbody tr').each(function() {
		var row = $(this);
		// content5 appends a hidden per-board chip row after each real one.
		if (row.hasClass('hidden')) return;
		var vals = rxdBoardExtraValues(row.children('td').first().text().trim());
		var cells = row.children('.rxd-board-extra');
		if (cells.length !== RXD_BOARD_EXTRA.length) {
			cells.remove();
			RXD_BOARD_EXTRA.forEach(function() {
				row.append('<td class="rxd-board-extra"></td>');
			});
			cells = row.children('.rxd-board-extra');
		}
		RXD_BOARD_EXTRA.forEach(function(c, i) { cells.eq(i).text(vals[c.key]); });
	});
}

/* --- protection ---------------------------------------------------------- */

// getshutdown exposes the counters the miner shuts itself down on. They read 0
// throughout normal operation, so this is a row that should say "Clear" and
// otherwise be ignored - the point is the day it doesn't. The field names are
// the miner's own and undocumented, so the row reports which ones are set and
// leaves interpreting them to the reader.
/* The chip clock on the status card. The stock UI shows the EEPROM's nameplate
   frequency elsewhere, which on this unit is a profile for a different machine
   (875 MHz, 18 chips) and not what the chips run - so this reports the measured
   clock from the bridge, and flags when a change is still waiting for a restart. */
function rxdRenderClock(data) {
	var panel = $('.right .content2 .panlcss').has('.speedcss').first();
	if (panel.length === 0) return;
	$('.rxd-clock-row').not(panel.find('.rxd-clock-row')).remove();

	var row = panel.find('.rxd-clock-row');
	if (row.length === 0) {
		row = $('<div class="rxd-clock-row">' +
				'<span class="lan-trans">Chip clock</span>' +
				'<span class="content2radiuscss rxd-clock-pill"></span>' +
			'</div>');
		// Above the protection row, so the two added rows keep a stable order
		// regardless of which bridge response lands first.
		var protection = panel.find('.rxd-protection-row');
		if (protection.length) protection.before(row); else panel.append(row);
	}

	var pill = row.find('.rxd-clock-pill');
	var live = data && data.pll ? data.pll.max : null;
	var configured = null;
	if (data && data.boards && data.boards.length && data.boards[0].configured) {
		configured = data.boards[0].configured.pll;
	}

	if (!live) {
		pill.removeClass('content2radiusGreencss content2radiusRedcss')
			.text('--')
			.attr('title', 'Chip clock unavailable from the bridge');
		return;
	}

	if (configured && configured !== live) {
		pill.removeClass('content2radiusGreencss').addClass('content2radiusRedcss')
			.text(live + ' MHz')
			.attr('title', 'Running at ' + live + ' MHz; EEPROM is set to ' +
				configured + ' MHz and takes effect on the next restart');
	} else {
		pill.removeClass('content2radiusRedcss').addClass('content2radiusGreencss')
			.text(live + ' MHz')
			.attr('title', 'Measured chip clock' +
				(configured ? ', matching the EEPROM setting' : ''));
	}
}

/* Health at a glance, without scrolling.

   The stock status rows say only "Normal" or "Abnormal". That tells you a
   threshold has not been crossed, not whether you are near it - a board at
   69 C and one at 45 C look identical. The numbers behind those pills are
   already in the same payload and simply unused, so this puts them beside the
   pill: "Normal  70 C" answers the question the pill was trying to answer.

   A Pool row is added too, which the stock card leaves out entirely - the pool
   table is at the very bottom of the page, so a dropped pool is the one failure
   you had to scroll to find. */
function rxdHealthValue(panel, selector, text) {
	var pill = panel.find(selector);
	if (pill.length === 0) return;
	var tag = pill.parent().find('.rxd-health-value');
	if (tag.length === 0) {
		tag = $('<span class="rxd-health-value"></span>');
		pill.after(tag);
	}
	tag.text(text || '');
}

/* The pool pill's three states, as a pure decision so it can be tested.
 *
 * `connect` is 1 connected, 0 mid-connect, -1 never attempted. Only entries
 * with an address count: the stock UI ships three slots and the unused ones
 * sit at -1 forever, so counting those as failures reports a healthy miner as
 * broken.
 *
 * Connecting gets its own pill rather than falling in with Disconnected. After
 * a reboot the miner sits at 0 for a few seconds while it opens the socket,
 * and painting that red is the same mistake as the stock warm-up state: it is
 * alarming, it is wrong, and a red that cries wolf is a red you stop reading.
 */
function rxdPoolState(all) {
	var pools = (all || []).filter(function(p) { return p.addr; });
	function addrs(want) {
		return pools.filter(function(p) { return rxdNum(p.connect) === want; })
			.map(function(p) { return p.addr; }).join(', ');
	}

	if (pools.length === 0) {
		return { text: '--', cls: '', title: 'No pool configured' };
	}
	if (pools.some(function(p) { return rxdNum(p.connect) === 1; })) {
		return { text: 'Connected', cls: 'content2radiusGreencss', title: addrs(1) };
	}
	if (pools.some(function(p) { return rxdNum(p.connect) === 0; })) {
		return { text: 'Connecting', cls: 'rxd-warmup-pill',
			title: 'Opening the connection to ' + addrs(0) };
	}
	return { text: 'Disconnected', cls: 'content2radiusRedcss',
		title: 'No configured pool is connected' };
}

function rxdRenderHealth(data) {
	var panel = $('.right .content2 .panlcss').has('.speedcss').first();
	if (panel.length === 0 || !data) return;

	var gh = rxdHashrateGH(data);
	rxdHealthValue(panel, '.speedcss', gh ? Math.round(gh) + ' GH/s' : '');

	// fans reports a fixed four slots; the unfitted ones read 0 and would drag
	// a min or an average down, so this reports the fastest fan actually turning.
	var fans = (data.fans || []).filter(function(r) { return r > 0; });
	rxdHealthValue(panel, '.volcss', fans.length ? Math.max.apply(null, fans) + ' rpm' : '');

	// intmp/outtmp are the two board sensors - the hot one is what matters.
	// Through rxdTempGap, so a 0 or a 127 sentinel is not "the hot one": this
	// tile reports a maximum, which is exactly where one bad read does the
	// most damage.
	var temps = [];
	(data.boards || []).forEach(function(b) {
		[rxdTempGap(b.intmp), rxdTempGap(b.outtmp)].forEach(function(t) {
			if (t !== null) temps.push(t);
		});
	});
	rxdHealthValue(panel, '.temcss', temps.length ? Math.round(Math.max.apply(null, temps)) + ' °C' : '');

	var state = rxdPoolState(data.pools);

	$('.rxd-pool-row').not(panel.find('.rxd-pool-row')).remove();
	var row = panel.find('.rxd-pool-row');
	if (row.length === 0) {
		row = $('<div class="rxd-pool-row">' +
				'<span class="lan-trans">Pool</span>' +
				'<span class="content2radiuscss rxd-pool-pill"></span>' +
			'</div>');
		var before = panel.find('.rxd-clock-row, .rxd-protection-row').first();
		if (before.length) before.before(row); else panel.append(row);
	}

	row.find('.rxd-pool-pill')
		.removeClass('content2radiusGreencss content2radiusRedcss rxd-warmup-pill')
		.addClass(state.cls)
		.text(state.text)
		.attr('title', state.title);
}

/* Actual against what the cores and clock say the board should be producing -
 * the shortfall a clock change is really buying or losing, rather than the raw
 * hashrate which says nothing on its own.
 *
 * The per-cycle constant behind "expected" is inferred from measurement, not
 * from a datasheet, so this is a relative scale across clocks on one board.
 * The thresholds are set accordingly: anything from 95% up reads as fine,
 * because a few percent either side of 100 is not a real signal. What IS real
 * is the shape - 645, 700, 750 and 775 all sit near the top of the band on
 * this board (700 reads about 98%, 775 about 95%) and 800 falls to 86%, which
 * is how the cliff shows up here. */
function rxdRenderPerformance(perf) {
	var panel = $('.right .content2 .panlcss').has('.speedcss').first();
	if (panel.length === 0 || !perf) return;

	$('.rxd-perf-row').not(panel.find('.rxd-perf-row')).remove();
	var row = panel.find('.rxd-perf-row');
	if (row.length === 0) {
		row = $('<div class="rxd-perf-row">' +
				'<span class="lan-trans">Output</span>' +
				'<span class="content2radiuscss rxd-perf-pill"></span>' +
			'</div>');
		var before = panel.find('.rxd-protection-row').first();
		if (before.length) before.before(row); else panel.append(row);
	}

	var pill = row.find('.rxd-perf-pill');
	pill.removeClass('content2radiusGreencss content2radiusRedcss');

	if (!perf.percent) {
		pill.text('--').attr('title', 'Not enough information yet');
		rxdHealthValue(panel, '.rxd-perf-pill', '');
		return;
	}

	pill.text(perf.percent + '%');
	if (perf.percent >= 95) pill.addClass('content2radiusGreencss');
	else if (perf.percent < 85) pill.addClass('content2radiusRedcss');

	pill.attr('title',
		Math.round(perf.actual) + ' GH/s against ' + Math.round(perf.expected) +
		' expected: ' + perf.cores + ' cores x ' + perf.mhz + ' MHz x ' +
		perf.hashesPerCoreCycle + ' hashes per core per cycle. That last figure ' +
		'is a fixed firmware constant, not a per-board calibration, so this ' +
		'percentage is comparable between miners - leave it alone unless the ' +
		'board design differs. Dead cores lower the expectation too, so read ' +
		'this next to the core count.');

	rxdHealthValue(panel, '.rxd-perf-pill',
		Math.round(perf.actual) + ' of ' + Math.round(perf.expected) + ' GH/s');
}

function rxdFetchPerformance() {
	return $.ajax({ url: RXD_PERF_URL, type: 'GET', dataType: 'json', timeout: 10000 })
		.done(rxdRenderPerformance);
}

function rxdRenderProtection(p) {
	// Five panels on this page carry .content2 .panlcss; the status rows live
	// in the one with the hashrate-state pill in it. Appending to the jQuery
	// set would clone the row into all five.
	var panel = $('.right .content2 .panlcss').has('.speedcss').first();
	if (panel.length === 0) return;
	$('.rxd-protection-row').not(panel.find('.rxd-protection-row')).remove();

	var row = panel.find('.rxd-protection-row');
	if (row.length === 0) {
		row = $('<div class="rxd-protection-row">' +
				'<span class="lan-trans">Protection</span>' +
				'<span class="content2radiuscss rxd-protection-pill"></span>' +
			'</div>');
		panel.append(row);
	}

	var pill = row.find('.rxd-protection-pill');

	// Bridge too old to report it, or the query failed - say so rather than
	// showing a reassuring green pill for a value nobody has.
	if (!p) {
		pill.removeClass('content2radiusGreencss content2radiusRedcss')
			.text('--')
			.attr('title', 'Protection state unavailable from the bridge');
		return;
	}

	var names = Object.keys(p.tripped || {});
	if (p.clear || names.length === 0) {
		pill.removeClass('content2radiusRedcss').addClass('content2radiusGreencss')
			.text('No faults')
			.attr('title', 'No thermal or power protection counter is set');
	} else {
		pill.removeClass('content2radiusGreencss').addClass('content2radiusRedcss')
			.text(names.length === 1 ? '1 counter set' : names.length + ' counters set')
			.attr('title', names.map(function(k) { return k + '=' + p.tripped[k]; }).join(', '));
	}
}

function rxdBrandSidebar() {
	var logo = $(".left ul li:first-child");
	if (logo.length && !logo.hasClass('rxd-branded')) {
		logo.css({
			'background-image': 'none',
			'height': 'auto',
			'padding': '18px 14px 16px',
			'margin': '0'
		}).html(
			'<div class="radiant-brand">' +
				'<div class="rxd-mark">' + RXD_LOGO_SYMBOL + '</div>' +
				'<div class="rxd-text">' +
					'<div class="rxd-word">' + RXD_LOGO_WORDMARK + '</div>' +
					'<div class="rxd-sub">RXD MINER</div>' +
				'</div>' +
			'</div>'
		).addClass('rxd-branded');
	}
}

/* _v2 was the per-board shape replacing a flat tempMin/tempAvg/tempMax one.
   _v3 is the same shape with epoch-millisecond timestamps instead of 'HH:MM'
   strings, so a v2 blob is dropped rather than loaded: its labels are a mix of
   two clocks and cannot be converted back into instants. The old key is
   cleared so it does not sit in storage forever. */
var RXD_CHIP_STORE = 'rxd_chip_history_v3';

function rxdSaveChipHistory() {
	try {
		localStorage.setItem(RXD_CHIP_STORE, JSON.stringify(RXD.chipHistory));
	} catch(e) {}
}

function rxdLoadChipHistory() {
	try {
		localStorage.removeItem('rxd_chip_history_v2');
		var saved = localStorage.getItem(RXD_CHIP_STORE);
		if (saved) {
			var parsed = JSON.parse(saved);
			if (parsed && parsed.timestamps && parsed.timestamps.length > 0 && parsed.boards) {
				rxdDropEmptyBoards(parsed);
				RXD.chipHistory = parsed;
			}
		}
	} catch(e) {}
}

/* localStorage is per-browser, so a dashboard opened somewhere new used to show
   three nearly empty chip charts beside a full day of board history. The bridge
   now records chip samples itself, so this replaces whatever this browser
   happens to hold with the miner's own record - the same data everywhere, and
   it survives clearing the browser.

   The server copy is authoritative; only local points NEWER than its last
   sample are carried over, which is the whole of what the local tail can
   legitimately add.

   This used to compare array LENGTHS and keep the local copy when it was
   longer, meaning to preserve that tail. Length is the wrong measure: the
   bridge samples every 5 minutes while an open tab appends every minute, so
   the local array is five times denser and goes on winning while covering a
   fifth of the time. Once it reached the 288-point cap it was longer than any
   24 h the bridge could return, and the server copy was discarded on every
   load, permanently. The symptom was three chip charts frozen on a previous
   session's data, with a tick spacing that changed partway along where the
   5-minute points gave way to 1-minute ones. */
function rxdFetchChipHistory() {
	return $.ajax({ url: RXD_CHIPHISTORY_URL, type: 'GET', dataType: 'json', timeout: 10000 })
		.done(function(h) {
			if (!h || !h.timestamps || h.timestamps.length === 0 || !h.boards) return;

			rxdDropEmptyBoards(h);
			rxdCarryChipTail(RXD.chipHistory, h);
			RXD.chipHistory = h;
			rxdSaveChipHistory();
			rxdUpdateChipCharts();
			rxdRenderDayTile();
		});
}

/* Append the local points the server has not recorded yet. The sampler runs
   every 5 minutes, so a tab left open always holds a few minutes the bridge
   has not written; dropping them would make the charts jump backwards on
   every reload.

   Both sides must be on epoch time for "newer" to mean anything - against a
   pre-epoch bridge there is no common clock, so the server copy is simply
   taken as it stands.

   rxdCarryTail does the same for the board history, whose series are flat
   arrays beside the timestamps rather than nested under a board key. */
function rxdCarryChipTail(local, h) {
	if (!rxdTimesAreEpoch(local) || !rxdTimesAreEpoch(h)) return;

	var last = h.timestamps[h.timestamps.length - 1];
	var keys = Object.keys(h.boards);

	for (var i = 0; i < local.timestamps.length; i++) {
		if (local.timestamps[i] <= last) continue;
		h.timestamps.push(local.timestamps[i]);
		keys.forEach(function(key) {
			var from = local.boards[key];
			var into = h.boards[key];
			for (var sk in into) {
				// The server decides which boards exist. One it lists that the
				// local copy never saw contributes a gap, not a zero - rxdGap's
				// rule, and a chip at 0 mV is a lie.
				var v = (from && from[sk]) ? from[sk][i] : null;
				into[sk].push(v === undefined ? null : v);
			}
		});
	}
}

// An empty board slot charted as a flat zero series would otherwise live in
// saved history forever, because board buckets are only ever added. The
// bridge no longer reports unpopulated boards, so drop any bucket here that
// never recorded a single non-zero sample.
function rxdDropEmptyBoards(h) {
	Object.keys(h.boards).forEach(function(key) {
		var series = h.boards[key];
		var hasData = Object.keys(series).some(function(sk) {
			return series[sk].some(function(v) { return v; });
		});
		if (!hasData) delete h.boards[key];
	});
}

function rxdEmptyBoardSeries() {
	return {
		tempMin: [], tempAvg: [], tempMax: [],
		voltMin: [], voltAvg: [], voltMax: [],
		pllMin: [], pllAvg: [], pllMax: []
	};
}

function rxdRecordChipData(d) {
	if (!d || !d.boards || !d.boards.length) return;

	var ts = Date.now();
	var h = RXD.chipHistory;
	var last = h.timestamps[h.timestamps.length - 1];

	// A pre-epoch bridge fills this with 'HH:MM' rendered in the miner's
	// clock. Appending browser-clock points to that is precisely the bug this
	// replaced, so leave the series alone and let the server own it - all the
	// append would have added is the few minutes since the last 5-minute
	// sample, and every page load re-fetches those anyway.
	if (h.timestamps.length > 0 && typeof last !== 'number') return;
	if (typeof last === 'number' && ts - last < RXD_MIN_SAMPLE_GAP_MS) return;

	// A board bucket created after other boards already have history is
	// back-filled with zeros so every board's arrays stay aligned with the
	// shared timestamps array.
	var priorLen = h.timestamps.length;
	h.timestamps.push(ts);

	d.boards.forEach(function(b) {
		var key = String(b.board);
		if (!h.boards[key]) {
			h.boards[key] = rxdEmptyBoardSeries();
			for (var k in h.boards[key]) {
				for (var i = 0; i < priorLen; i++) h.boards[key][k].push(0);
			}
		}
		var bh = h.boards[key];
		bh.tempMin.push(b.temp.min);     bh.tempAvg.push(b.temp.avg);     bh.tempMax.push(b.temp.max);
		bh.voltMin.push(b.voltage.min);  bh.voltAvg.push(b.voltage.avg);  bh.voltMax.push(b.voltage.max);
		bh.pllMin.push(b.pll.min);       bh.pllAvg.push(b.pll.avg);       bh.pllMax.push(b.pll.max);
	});

	while (h.timestamps.length > RXD.maxPoints) {
		h.timestamps.shift();
		for (var bk in h.boards) {
			for (var sk in h.boards[bk]) h.boards[bk][sk].shift();
		}
	}

	rxdSaveChipHistory();
}

function rxdFetchChipData() {
	return $.ajax({ url: RXD_BRIDGE_URL, type: 'GET', dataType: 'json', timeout: 8000 })
		.done(function(d) {
			RXD.chipBridgeUp = true;
			RXD.chip = d;
			RXD.protection = d.protection;
			rxdRecordChipData(d);
			rxdAugmentBoardTable();
			rxdUpdateChipCharts();
			rxdRenderProtection(d.protection);
			rxdRenderClock(d);
		})
		.fail(function() {
			// Bridge not installed or not running - the chip charts simply
			// stay absent rather than breaking the rest of the dashboard.
			RXD.chipBridgeUp = false;
		});
}

function rxdCreateChipContainers() {
	if ($('#rxd-chip-row').length > 0) return;
	if ($('#rxd-charts-row').length === 0) return;

	$('#rxd-charts-row').after(
		'<div id="rxd-chip-row" class="radiant-charts">' +
			'<div class="radiant-chart-box" id="rxd-chiptemp-chart"></div>' +
			'<div class="radiant-chart-box" id="rxd-chipvolt-chart"></div>' +
			'<div class="radiant-chart-box" id="rxd-chipclock-chart"></div>' +
		'</div>'
	);
}

function rxdChipBoardNums() {
	return Object.keys(RXD.chipHistory.boards).sort(function(a, b) { return a - b; });
}

/* One chart, one series triple (avg/min/max) per board - matches the
   per-board breakdown pbfarmer shows, instead of lumping every chip on
   every board into a single min/avg/max. */
/* The chip clock readback jitters by exactly one LSB. Measured across 308
   samples at four settings, a chip reads 1 MHz low in 0.51% of samples at 800
   and 4.30% at 700, independently per chip - the counts fit a binomial almost
   exactly (at 700, 57/30/10 rows with none/one/two chips low against a
   predicted 57.3/30.9/7.6) - never by more than 1, with voltage identical in
   those rows and no temperature difference between dip and clean rows.

   So it is the readback, not the chip changing frequency. Plotted raw it puts
   a notch in the min series every few samples, which looks like a fault and
   was reported as one.

   Snapped for DISPLAY ONLY. rxd_chips.log, /chiphistory and the stored
   history keep the raw values, and rxdDayStats, the overclock verification
   and the clock pill all still read them - an actual clock change is 5 MHz,
   so rounding to the step cannot hide one. */
var RXD_CLOCK_STEP = 5;

function rxdChipSeries(board, statKey, suffix) {
	var data = (board[statKey + suffix] || []).slice();
	if (statKey !== 'pll') return data;
	return data.map(function(v) {
		// Leaves 0 and null alone: a gap is not a reading to round.
		return v ? Math.round(v / RXD_CLOCK_STEP) * RXD_CLOCK_STEP : v;
	});
}

function rxdChipChart(container, title, yTitle, statKey, suffix) {
	var h = RXD.chipHistory;
	var boardNums = rxdChipBoardNums();
	var series = [];

	boardNums.forEach(function(bn, i) {
		var colors = RXD_BOARD_COLORS[i % RXD_BOARD_COLORS.length];
		var b = h.boards[bn];
		series.push({ name: 'Board' + bn + ' (avg)', data: rxdChipSeries(b, statKey, 'Avg'), color: colors.avg });
		series.push({ name: 'Board' + bn + ' (min)', data: rxdChipSeries(b, statKey, 'Min'), color: colors.min });
		series.push({ name: 'Board' + bn + ' (max)', data: rxdChipSeries(b, statKey, 'Max'), color: colors.max });
	});

	return rxdMakeChart(container, title, yTitle, series, null, suffix, rxdTimeLabels(h));
}

function rxdUpdateChipCharts() {
	var h = RXD.chipHistory;
	var boardNums = rxdChipBoardNums();
	if (boardNums.length === 0) return;
	if (h.timestamps.length < 2) return;
	if (typeof Highcharts === 'undefined') return;

	// Same stale-instance problem as the board charts: navigating away
	// destroys the nodes while the Highcharts objects survive.
	if ($('#rxd-chip-row').length === 0) {
		['chiptemp','chipvolt','chipclock'].forEach(function(k) {
			if (RXD.charts[k]) {
				try { RXD.charts[k].destroy(); } catch(e) {}
				RXD.charts[k] = null;
			}
		});
	}

	rxdCreateChipContainers();

	var defs = [
		['chiptemp',  'rxd-chiptemp-chart',  'Chip Temperature', 'Temp',    'temp', ' °C'],
		['chipvolt',  'rxd-chipvolt-chart',  'Chip Voltage',     'Voltage', 'volt', ' mV'],
		['chipclock', 'rxd-chipclock-chart', 'Chip Clock',       'Clock',   'pll',  ' MHz']
	];
	var expectedSeries = boardNums.length * 3;

	defs.forEach(function(d) {
		var key = d[0], el = d[1], statKey = d[4];
		if (RXD.charts[key] && RXD.charts[key].series.length === expectedSeries) {
			RXD.charts[key].xAxis[0].setCategories(rxdTimeLabels(h), false);
			var si = 0;
			boardNums.forEach(function(bn) {
				var b = h.boards[bn];
				RXD.charts[key].series[si++].setData(rxdChipSeries(b, statKey, 'Avg'), false);
				RXD.charts[key].series[si++].setData(rxdChipSeries(b, statKey, 'Min'), false);
				RXD.charts[key].series[si++].setData(rxdChipSeries(b, statKey, 'Max'), false);
			});
			RXD.charts[key].redraw();
		} else {
			// No chart yet, or the board count changed since it was built
			// (series count would no longer match) - rebuild from scratch.
			if (RXD.charts[key]) {
				try { RXD.charts[key].destroy(); } catch(e) {}
				RXD.charts[key] = null;
			}
			if ($('#' + el).length) {
				RXD.charts[key] = rxdChipChart(el, d[2], d[3], statKey, d[5]);
			}
		}
	});
}

function rxdSetupMobileNav() {
	var left = $('.left');
	if (left.length === 0 || left.find('.rxd-nav-toggle').length > 0) return;

	var btn = $('<button type="button" class="rxd-nav-toggle" aria-label="Menu" aria-expanded="false">' +
		'<span></span><span></span><span></span></button>');

	function setOpen(open) {
		left.toggleClass('rxd-nav-open', open);
		btn.attr('aria-expanded', open ? 'true' : 'false');
	}

	btn.on('click', function(e) {
		e.stopPropagation();
		setOpen(!left.hasClass('rxd-nav-open'));
	});

	// Picking a destination closes the menu
	left.on('click', 'li.menucss', function() { setOpen(false); });

	// Tapping the content area dismisses it
	$(document).on('click', function(e) {
		if (left.hasClass('rxd-nav-open') && !$(e.target).closest('.left').length) {
			setOpen(false);
		}
	});

	left.append(btn);
}

/* The stock Mining Settings page has a "Fan Speed(%)" checkbox that is a
   write-only input, not a status readout: view/machine.esp ships it with no
   checked attribute and the name "fancontrol" appears in no JavaScript at all,
   so nothing ever reflects the miner's state onto it. It is always clear on
   load, sitting next to a fanratio field that IS filled from live data.

   That combination is a trap. machine_save_fansetting() submits
   $('#form1').serialize(), and jQuery omits unchecked boxes entirely, so
   saving a ratio without noticing the box sends control=false - which the
   miner answers code 0 and then ignores, keeping the fans for itself. The
   setting appears to have been accepted and silently does nothing.

   So default it to ticked, which is what anyone typing a ratio means. Clearing
   it deliberately still works as the "hand the fans back to auto" gesture: the
   element is marked once defaulted and never re-ticked behind the user. The
   views load as fragments into index.esp, so a fresh unmarked checkbox appears
   each time the page is opened, and each gets the default exactly once. */
function rxdDefaultFanControl(root) {
	$(root || document).find('input[name=fancontrol]').each(function() {
		var box = $(this);
		if (box.data('rxdDefaulted')) return;
		box.data('rxdDefaulted', true);
		if (!box.prop('checked')) box.prop('checked', true);
	});
}

/* The Fan page owns the fan now, so the stock fan speed control on Mining
   Settings is removed - two controls writing the same miner state, one of them
   showing a value our controller is about to overwrite, is just a way to
   confuse yourself.

   It is HIDDEN rather than deleted, because it cannot simply be deleted. The
   "Mode" dropdown beside it is not a fan setting at all - it is the miner work
   mode, normal or sleep - and both live in #form1, which
   machine_save_fansetting() serializes whole before appending post=3. The
   backend then builds one message from all three fields:

       {"id":"sethw", "fan":{"control":%s, "ratio":%s}, "mode":"%s"}

   with `ratio` substituted by %s straight from the form. Remove the input and
   saving a work mode sends `"ratio":` - malformed JSON the miner rejects. So
   the inputs stay, carrying the live ratio machine_content() filled in, and
   saving Mode re-asserts the ratio already in force instead of changing it.

   The section heading is relabelled for the same reason: with the fan row gone
   "Hardware Configuration" describes a single dropdown. */
function rxdStripStockFanControls(root) {
	$(root || document).find('input[name=fanratio]').each(function() {
		var ratio = $(this);
		if (ratio.data('rxdStripped')) return;
		ratio.data('rxdStripped', true);

		// The row is the input's parent div: checkbox, label, ratio field.
		var row = ratio.closest('div');
		if (row.length && row.find('input[name=fancontrol]').length) {
			row.hide();
			// A bare <br/> follows it in machine.esp and would leave a gap.
			row.next('br').hide();
		} else {
			ratio.hide();
		}

		var section = ratio.closest('.machine_bottom');
		var head = section.find('.top').first();
		// Drop lan-trans first or translate.js puts the Chinese label back.
		if (head.length) head.removeClass('lan-trans').text('Work Mode');
	});
}

function rxdWatchForFanControl() {
	rxdDefaultFanControl();
	rxdStripStockFanControls();

	if (typeof MutationObserver === 'undefined') return;
	// The settings view is injected after load, so there is nothing to bind to
	// up front; watch for it arriving instead of polling on a timer.
	var observer = new MutationObserver(function(records) {
		for (var i = 0; i < records.length; i++) {
			if (records[i].addedNodes.length > 0) {
				rxdDefaultFanControl();
				rxdStripStockFanControls();
				return;
			}
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	RXD.fanControlObserver = observer;
}

/* ---------------------------------------------------------------- overclock

   The chip clock lives in the hash board's EEPROM, not in any config file, and
   the miner reads it at startup and ramps the chips to it. So changing it means
   writing two bytes plus a checksum and rebooting - there is no way to apply it
   to a running miner, and the page says so rather than pretending otherwise.

   Measured on this board at a fixed chip temperature: 645 ~268 G, 700 ~295 G,
   750 ~309 G, 775 ~319 G, 800 ~296 G. Higher is NOT automatically faster -
   output peaks at 775 here and 800 falls back below 700, because the chips still
   calibrate and run but find fewer nonces per cycle as the clock climbs. So the
   honest way to choose a value is to run one for hours and compare the average,
   not to pick the biggest number. The page carries that warning.

   A clock the board cannot run fails safe: the miner refuses to start rather
   than hashing badly, and the next change (or a restore) brings it back.

   There is no token on this page. There was, and it protected nothing worth
   the friction: the stock web API next to it already takes an unauthenticated
   POST to change pools, reboot or reflash, so a password here only guarded one
   door in an open wall. The real guards are the ones that cannot be typed
   past - the clock is bounded, the write verifies by reading back, a bad value
   fails safe, and every change is logged with the caller's address. */

/* One confirmation dialog for every page here, so a consequential action always
   looks the same and always says what it is about to do. bootbox is a Bootstrap
   modal, which radiant.css themes; a native confirm() would be unstyled, and it
   blocks the whole page while it is up. bootbox ships with the stock firmware,
   but fall back to confirm() if a future package drops it - asking badly beats
   a button that silently does nothing. */
function rxdConfirm(title, message, label, onYes) {
	if (!window.bootbox) {
		if (window.confirm(title + '\n\n' + message.replace(/<[^>]+>/g, ''))) onYes();
		return;
	}
	bootbox.dialog({
		title: title,
		message: message,
		closeButton: true,
		buttons: {
			cancel: { label: 'Cancel', className: 'btn-default' },
			ok: { label: label, className: 'btn-primary', callback: function() { onYes(); } }
		}
	});
}

function rxdOcForgetToken() {
	// Earlier builds offered to remember the token here. Nothing reads it now,
	// so do not leave a stale secret sitting in the browser's storage.
	try { localStorage.removeItem('rxd_oc_token'); } catch(e) {}
}

function rxdOcOptions(info, selected) {
	var min = info.min || 600, max = info.max || 800, step = info.step || 5;
	var html = '';
	for (var v = min; v <= max; v += step) {
		html += '<option value="' + v + '"' + (v === selected ? ' selected' : '') +
			'>' + v + ' MHz' + (v === 640 ? ' (stock)' : '') + '</option>';
	}
	return html;
}

function rxdOcRender(info) {
	var live = info.live || null;
	var configured = info.configured || null;
	var pending = (live && configured && live !== configured);

	var html =
		'<div class="rxd-oc">' +
		'<div class="rxd-oc-card">' +
			'<h3>Overclock</h3>' +
			'<div class="rxd-oc-now">' +
				'<div><span class="rxd-oc-label">Chips running at</span>' +
					'<span class="rxd-oc-value">' + (live ? live + ' MHz' : '--') + '</span></div>' +
				'<div><span class="rxd-oc-label">EEPROM set to</span>' +
					'<span class="rxd-oc-value">' + (configured ? configured + ' MHz' : '--') + '</span></div>' +
			'</div>' +
			(pending ? '<p class="rxd-oc-pending">A change is waiting for a restart - ' +
				'the chips keep running at ' + live + ' MHz until then.</p>' : '') +
			'<div class="rxd-oc-form">' +
				'<label for="rxd-oc-mhz">New clock</label>' +
				'<select id="rxd-oc-mhz">' + rxdOcOptions(info, configured || live || 640) + '</select>' +
				'<button type="button" id="rxd-oc-apply" class="rxd-oc-apply">Apply and restart</button>' +
			'</div>' +
			'<p class="rxd-oc-warn"><strong>This restarts the miner.</strong> Mining stops for ' +
				'about three minutes. The clock only takes effect on the restart, because the ' +
				'miner reads it from the board EEPROM at startup.</p>' +
			'<p class="rxd-oc-note"><strong>Output climbs to 775, then falls off a ' +
				'cliff.</strong> Measured on one board at a fixed chip temperature, so the ' +
				'clock is the only thing changing: <strong>645</strong> gave 268 G, ' +
				'<strong>700</strong> gave 295 G, <strong>750</strong> gave 309 G, ' +
				'<strong>775</strong> gave <strong>319 G</strong> - the best of the five - ' +
				'and <strong>800</strong> dropped to 296 G, below even 700.</p>' +
			'<p class="rxd-oc-note">The shape matters more than the winner. The steps ' +
				'up to 750 buy less hashrate than the clock they add (645 to 700 is ' +
				'+10.3% for +8.5%, 700 to 750 is +4.6% for +7.1%), which looks like ' +
				'ordinary diminishing returns - but <strong>750 to 775 is +3.4% for ' +
				'+3.3%</strong>, one for one, with no loss of efficiency at all. Then ' +
				'<strong>775 to 800 is -7.4%</strong>. So the top of the range does not ' +
				'taper off; it works and then it stops working, somewhere in the 25 MHz ' +
				'below 800 that has not been measured. Your silicon is not this silicon, ' +
				'so find your own edge - walk up and step back when a setting goes ' +
				'backwards, because a curve fitted through the far side of the cliff will ' +
				'point at the wrong clock.</p>' +
			'<p class="rxd-oc-note"><strong>That peak is for the stock voltage.</strong> ' +
				'This page changes the clock and nothing else, and the figures above ' +
				'were measured with the board rail at its stock 2.00 V, about 371 mV ' +
				'at the chips. More core voltage holds timing at a higher clock and ' +
				'moves the peak up: reported elsewhere, 958 MHz at 448 mV gives about ' +
				'9% more hashrate than 775 does here. But power goes as <em>V&sup2;f</em>, ' +
				'so that point costs roughly 65% more energy per hash, needs a supply ' +
				'the stock one may not match, and runs the power stage far hotter. A ' +
				'different trade, not a better setting.</p>' +
			'<p class="rxd-oc-note">Judge a setting by its average over <em>hours</em>. The ' +
				'5-minute figure keeps climbing for most of the first eight hours after a ' +
				'restart, and short samples mislead badly - an early version of this note ' +
				'quoted numbers that were wrong for exactly that reason. Compare windows at ' +
				'the same chip temperature too, or you are measuring your fan: fixing the ' +
				'cooling on this unit was worth about +3% on its own. A clock the board ' +
				'cannot run fails safe - the miner refuses to start, and setting a working ' +
				'value here brings it back.</p>' +
			'<div id="rxd-oc-result"></div>' +
		'</div></div>';

	$('.right .srcollcss').html(html);
}

function rxdOcApply() {
	var mhz = parseInt($('#rxd-oc-mhz').val(), 10);
	var result = $('#rxd-oc-result');

	rxdConfirm('Change the chip clock',
		'<p>Set the chip clock to <strong>' + mhz + ' MHz</strong> and restart the ' +
			'miner now?</p><p>Mining stops for about three minutes. If the board ' +
			'cannot run this clock the miner refuses to start, and setting a working ' +
			'value here brings it back.</p>',
		'Apply and restart',
		function() {
			result.html('<p class="rxd-oc-busy">Writing ' + mhz + ' MHz and restarting...</p>');
			$.ajax({
				url: RXD_SETCLOCK_URL,
				type: 'POST',
				contentType: 'application/json',
				data: JSON.stringify({ mhz: mhz }),
				dataType: 'json',
				timeout: 30000
			}).done(function(re) {
				result.html('<p class="rxd-oc-ok">' + (re.message || 'Done') +
					'<br>The miner is restarting. This page will not update until it is ' +
					'back - give it about three minutes, then reload.</p>');
			}).fail(function(xhr) {
				var msg = 'Could not reach the miner bridge on port 4112.';
				try { msg = JSON.parse(xhr.responseText).error || msg; } catch(e) {}
				result.html('<p class="rxd-oc-error">' + msg + '</p>');
			});
		});
}

/* Our three nav entries highlight themselves, and base.js's stock handlers
   know nothing about them - so whoever lights up has to put the others out.
   Doing that pairwise is what broke: clicking Fan cleared Overclock but not
   Swarm, so two pages showed as current at once. One list, cleared in full
   before the current item is set, and the clear happens inside the page
   function rather than in a click handler so it cannot race the add. */
var RXD_NAV_ITEMS = '.left .rxdOcMenu, .left .rxdFanMenu, .left .rxdSwarmMenu';

function rxdNavSelect(cls) {
	$(RXD_NAV_ITEMS).removeClass('menucssStatus');
	if (cls) $('.left .' + cls).addClass('menucssStatus');
}

function rxdOcMenu() {
	rxdOcForgetToken();
	rxdNavSelect('rxdOcMenu');
	$('.right .srcollcss').html('<div class="rxd-oc"><div class="rxd-oc-card">' +
		'<h3>Overclock</h3><p class="rxd-oc-busy">Reading the current clock...</p>' +
		'</div></div>');

	$.ajax({ url: RXD_CLOCK_URL, type: 'GET', dataType: 'json', timeout: 8000 })
		.done(function(info) {
			if (!info.enabled) {
				$('.right .srcollcss').html('<div class="rxd-oc"><div class="rxd-oc-card">' +
					'<h3>Overclock</h3><p class="rxd-oc-error">Overclocking is not enabled ' +
					'on this miner - /var/order/conf/rxd_oc.enable is missing. Reinstall ' +
					'with <code>--enable-oc</code>, or create the file.</p></div></div>');
			} else {
				rxdOcRender(info);
			}
			if (window.loaded) loaded();
		})
		.fail(function() {
			// Worth naming the likely cause: the bridge serves plain HTTP, so a
			// dashboard opened over HTTPS cannot call it (mixed content).
			$('.right .srcollcss').html('<div class="rxd-oc"><div class="rxd-oc-card">' +
				'<h3>Overclock</h3><p class="rxd-oc-error">Could not reach the miner bridge ' +
				'at ' + RXD_BRIDGE_BASE + '.' + (location.protocol === 'https:' ?
					' Over HTTPS the bridge is reached on port 4113 - if your browser has not ' +
					'accepted the miner certificate, open ' + RXD_BRIDGE_BASE + '/clock once ' +
					'and accept it.' : '') +
				'</p></div></div>');
			if (window.loaded) loaded();
		});
}

function rxdAddOcNav() {
	var list = $('.left ul');
	if (list.length === 0 || list.find('.rxdOcMenu').length > 0) return;

	// Placed after Mining Settings, which is where anyone looking for it starts.
	var item = $('<li class="rxdOcMenu menucss"><span>Overclock</span></li>');
	var after = list.find('.fpgaMenu');
	if (after.length) after.after(item); else list.append(item);

	item.on('click', function() {
		// menu() is the stock clear-and-load-spinner helper; it also strips the
		// highlight from every stock item, so ours is set afterwards.
		if (window.menu) menu();
		rxdOcMenu();
	});

	// The stock handlers never heard of our items, so clear every one of them
	// when any stock page is opened. See rxdNavSelect.
	$('.left .userMenu, .left .fpgaMenu, .left .ipMenu, .left .sysMenu, .left .firMenu, .left .logMenu')
		.on('click', function() { rxdNavSelect(null); });

	$(document).on('click', '#rxd-oc-apply', rxdOcApply);
}

/* --- Fan -----------------------------------------------------------------
 *
 * Stock runs the fan bang-bang: idle until the board heats up, then full
 * speed, around 13 cycles a day. A fixed ratio fixes that but is only correct
 * for one ambient, so this also offers a target temperature and lets the
 * ratio move. The service does the controlling; this page only edits its
 * config and shows what the fan is actually doing, which is not always the
 * same thing - the miner keeps trying to take the fan back.
 */
function rxdFanEscape(s) {
	return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
	});
}

var RXD_FAN_LIVE = null;   // what the fan is doing now, for the Save warning

function rxdFanRender(info) {
	var limits = info.limits || { targetMin: 40, targetMax: 85, floor: 10 };
	var live = info.live || {};
	var isTarget = info.mode === 'target';

	RXD_FAN_LIVE = (live.ratio == null) ? null : live.ratio;

	function slider(id, label, value, min, max, suffix) {
		return '<div class="rxd-fan-slider">' +
			'<label for="' + id + '">' + label +
				'<span class="rxd-fan-readout" id="' + id + '-out">' +
				value + suffix + '</span></label>' +
			'<input type="range" id="' + id + '" min="' + min + '" max="' + max +
				'" value="' + value + '" data-suffix="' + suffix + '">' +
			'</div>';
	}

	var html =
		'<div class="rxd-oc"><div class="rxd-oc-card">' +
			'<h3>Fan</h3>' +
			'<div class="rxd-oc-now">' +
				'<div><span class="rxd-oc-label">Fan now</span>' +
					'<span class="rxd-oc-value">' +
					(live.ratio == null ? '--' : live.ratio + '%') +
					(live.rpm ? ' &middot; ' + live.rpm + ' rpm' : '') + '</span></div>' +
				'<div><span class="rxd-oc-label">Mode</span>' +
					'<span class="rxd-oc-value">' +
					(isTarget ? 'Hold temperature' : 'Hold fan speed') + '</span></div>' +
			'</div>' +

			'<div class="rxd-fan-form">' +
				'<label class="rxd-fan-mode">' +
					'<input type="radio" name="rxd-fan-mode" value="fixed"' +
					(isTarget ? '' : ' checked') + '> Hold a fixed fan speed</label>' +
				'<div class="rxd-fan-group" id="rxd-fan-fixed">' +
					slider('rxd-fan-ratio', 'Fan speed', info.ratio, 0, 100, '%') +
				'</div>' +

				'<label class="rxd-fan-mode">' +
					'<input type="radio" name="rxd-fan-mode" value="target"' +
					(isTarget ? ' checked' : '') + '> Hold a chip temperature</label>' +
				'<div class="rxd-fan-group" id="rxd-fan-target">' +
					slider('rxd-fan-temp', 'Target temperature', info.target,
						limits.targetMin, limits.targetMax, ' &deg;C') +
					slider('rxd-fan-min', 'Minimum fan speed', info.minfan,
						limits.floor, 100, '%') +
					slider('rxd-fan-max', 'Maximum fan speed', info.maxfan,
						limits.floor, 100, '%') +
				'</div>' +

				'<button type="button" id="rxd-fan-apply" class="rxd-oc-apply">Save</button>' +
			'</div>' +

			'<p class="rxd-oc-note">Target mode controls on the <strong>hottest ' +
				'chip</strong>, not the average, and moves slowly on purpose - it ' +
				'settles over tens of minutes rather than chasing the sensor, because ' +
				'a loop that reacts quickly to a board with minutes of thermal lag is ' +
				'just the stock bang-bang curve again. It rises faster than it falls, ' +
				'since running cool costs a little fan noise and running hot costs ' +
				'silicon.</p>' +
			'<p class="rxd-oc-note">The minimum is a real floor: the fan never goes ' +
				'below it, the controller jumps straight to maximum if the chips get ' +
				'' + '15 &deg;C over target, and it holds a high speed rather than a low ' +
				'one if the temperature cannot be read at all. If your unit has extra ' +
				'cooling the target may be unreachable in either direction - the fan ' +
				'then sits at a limit, and the service log says so.</p>' +
			'<div id="rxd-fan-result"></div>' +
		'</div></div>';

	$('.right .srcollcss').html(html);
	rxdFanToggleGroups();
}

function rxdFanToggleGroups() {
	var mode = $('input[name="rxd-fan-mode"]:checked').val();
	$('#rxd-fan-fixed').toggleClass('rxd-fan-off', mode !== 'fixed');
	$('#rxd-fan-target').toggleClass('rxd-fan-off', mode !== 'target');
}

function rxdFanApply() {
	var mode = $('input[name="rxd-fan-mode"]:checked').val() || 'fixed';
	var body = {
		mode: mode,
		ratio: parseInt($('#rxd-fan-ratio').val(), 10),
		target: parseInt($('#rxd-fan-temp').val(), 10),
		minfan: parseInt($('#rxd-fan-min').val(), 10),
		maxfan: parseInt($('#rxd-fan-max').val(), 10)
	};
	var result = $('#rxd-fan-result');

	// Most fan edits are harmless and instantly reversible, so they just save.
	// The two that can let the board get hotter than it is right now get a
	// dialog, because the cost of that mistake is paid in silicon.
	var warn = null;
	if (body.mode === 'fixed' && RXD_FAN_LIVE != null && body.ratio < RXD_FAN_LIVE - 10) {
		warn = '<p>The fan is at <strong>' + RXD_FAN_LIVE + '%</strong> now. Holding ' +
			'it at <strong>' + body.ratio + '%</strong> will let the chips run hotter.</p>' +
			'<p>Fixed mode does not back off on its own - only the miner\'s own ' +
			'protection will, by stopping. Watch the chip temperature after this.</p>';
	} else if (body.mode === 'target' && body.target >= 75) {
		warn = '<p>Hold the hottest chip at <strong>' + body.target + ' &deg;C</strong>?</p>' +
			'<p>This unit has been running in the low 60s. Hotter chips are said to ' +
			'hash slightly better, but 75 &deg;C and up is a real test of the ' +
			'cooling - check the hashrate actually improved.</p>';
	}

	function send() {
		result.html('<p class="rxd-oc-busy">Saving...</p>');
		rxdFanSend(body, result);
	}
	if (warn) rxdConfirm('Fan setting', warn, 'Save anyway', send);
	else send();
}

function rxdFanSend(body, result) {
	$.ajax({
		url: RXD_SETFAN_URL, type: 'POST', contentType: 'application/json',
		data: JSON.stringify(body), dataType: 'json', timeout: 20000
	}).done(function(re) {
		var fan = re.fan || {};
		// The bridge clamps rather than refuses, so say what was actually
		// stored - a slider that overshot should not look like it was obeyed.
		var note = fan.mode === 'target' ?
			'Holding the hottest chip at ' + fan.target + ' &deg;C, fan between ' +
				fan.minfan + '% and ' + fan.maxfan + '%.' :
			'Holding the fan at ' + fan.ratio + '%.';
		result.html('<p class="rxd-oc-ok">' + note +
			(fan.warning ? '<br>' + rxdFanEscape(fan.warning) : '') +
			'<br>The controller restarts now and takes a few minutes to settle.</p>');
	}).fail(function(xhr) {
		var msg = 'Could not reach the miner bridge at ' + RXD_BRIDGE_BASE + '.';
		try { msg = JSON.parse(xhr.responseText).error || msg; } catch(e) {}
		result.html('<p class="rxd-oc-error">' + rxdFanEscape(msg) + '</p>');
	});
}

function rxdFanMenu() {
	rxdNavSelect('rxdFanMenu');
	$('.right .srcollcss').html('<div class="rxd-oc"><div class="rxd-oc-card">' +
		'<h3>Fan</h3><p class="rxd-oc-busy">Reading the fan settings...</p></div></div>');

	$.ajax({ url: RXD_FAN_URL, type: 'GET', dataType: 'json', timeout: 8000 })
		.done(function(info) { rxdFanRender(info); if (window.loaded) loaded(); })
		.fail(function() {
			$('.right .srcollcss').html('<div class="rxd-oc"><div class="rxd-oc-card">' +
				'<h3>Fan</h3><p class="rxd-oc-error">Could not reach the miner bridge ' +
				'at ' + RXD_BRIDGE_BASE + '.</p></div></div>');
			if (window.loaded) loaded();
		});
}

/* --- Swarm ---------------------------------------------------------------
 *
 * Every RX0 on the network, from any one of their dashboards. The fetching
 * happens in the bridge rather than here: this page makes a single same-origin
 * call, which keeps it working over HTTPS. Talking to peers from the browser
 * would need CORS on every miner and would be blocked as mixed content the
 * moment the page was served over TLS.
 */
function rxdSwarmUptime(seconds) {
	if (!seconds) return '--';
	var d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600);
	if (d) return d + 'd ' + h + 'h';
	var m = Math.floor((seconds % 3600) / 60);
	return h ? h + 'h ' + m + 'm' : m + 'm';
}

/* A peer with no bridge on 4112 may still be a stock miner rather than a dead
   one - the stock web API answers without a session, so the bridge falls back
   to it and marks the row `stock`. Those rows carry hashrate, board
   temperature, fans, shares and uptime, but NOT chips, clock or chip
   temperature: the stock payload's values for those are wrong on an RX0 (18
   chips against 12, 875 MHz against 775), so the bridge sends null and the
   cells stay blank. Blank is the honest rendering - a dash reads as "not
   reported", which is exactly right, whereas a number would be believed. */
function rxdSwarmRow(m) {
	var dot = m.alive ? 'rxd-swarm-up' : 'rxd-swarm-down';
	function cell(v, suffix) {
		return '<td>' + (v == null || v === '' ? '--' : rxdFanEscape(v) + (suffix || '')) + '</td>';
	}
	var shares = (m.accepted == null) ? '--' :
		m.accepted + (m.rejected ? ' / ' + m.rejected : '');
	var tag = m.stock ?
		' <span class="rxd-swarm-tag" title="Stock firmware: reachable, but ' +
		'chip detail, overclocking and fan control need this build">stock</span>' : '';
	// The second line is there to say which address a NAMED miner is at. With
	// no name the first line is already the address, so printing it again just
	// shows the same string twice and reads like two different fields - one of
	// which you then go looking for a meaning for.
	var sub = (m.name && m.name !== m.host) ?
		'<div class="rxd-swarm-host">' + rxdFanEscape(m.host) + '</div>' : '';
	return '<tr' + (m.stock ? ' class="rxd-swarm-stockrow"' : '') + '>' +
		'<td><span class="rxd-swarm-dot ' + dot + '"></span>' +
			rxdFanEscape(m.name || m.host) + tag + sub + '</td>' +
		cell(m.hashrate, ' GH/s') +
		cell(m.chips) +
		cell(m.mhz, ' MHz') +
		cell(m.tempMax, ' °C') +
		cell(m.fanRatio, '%') +
		cell(m.fanRpm, ' rpm') +
		'<td>' + shares + '</td>' +
		cell(rxdSwarmUptime(m.uptime)) +
		'<td class="rxd-swarm-actions">' +
			'<button type="button" class="rxd-swarm-rename" data-host="' +
				rxdFanEscape(m.host) + '" data-name="' +
				rxdFanEscape(m.name || '') + '">Rename</button>' +
			'<button type="button" class="rxd-swarm-del" data-host="' +
				rxdFanEscape(m.host) + '">Remove</button></td>' +
		'</tr>';
}

function rxdSwarmRender(data) {
	var miners = data.miners || [];
	var rows = miners.length ? miners.map(rxdSwarmRow).join('') :
		'<tr><td colspan="10" class="rxd-swarm-empty">No other miners added yet. ' +
		'Add one by address below, or scan this network for them.</td></tr>';

	$('.right .srcollcss').html(
		'<div class="rxd-oc"><div class="rxd-oc-card rxd-oc-card--wide">' +
			'<h3>Swarm</h3>' +
			'<div class="rxd-oc-now">' +
				'<div><span class="rxd-oc-label">Miners</span>' +
					'<span class="rxd-oc-value">' + (data.alive || 0) + ' of ' +
					(data.count || 0) + ' up</span></div>' +
				'<div><span class="rxd-oc-label">Total hashrate</span>' +
					'<span class="rxd-oc-value">' + (data.hashrate || 0) + ' GH/s</span></div>' +
			'</div>' +
			'<div class="rxd-swarm-wrap">' +
			'<table class="rxd-swarm"><thead><tr>' +
				'<th>Miner</th><th>Hashrate</th><th>Chips</th><th>Clock</th>' +
				'<th>Hottest chip</th><th>Fan</th><th>RPM</th>' +
				'<th>Shares A/R</th><th>Uptime</th><th></th>' +
			'</tr></thead><tbody>' + rows + '</tbody></table>' +
			'</div>' +
			'<div class="rxd-swarm-add">' +
				'<input id="rxd-swarm-host" type="text" placeholder="10.0.0.42">' +
				'<input id="rxd-swarm-name" type="text" placeholder="name (optional)">' +
				'<button type="button" id="rxd-swarm-add">Add</button>' +
				'<button type="button" id="rxd-swarm-scan">Scan this network</button>' +
			'</div>' +
			'<p class="rxd-oc-note">This miner fetches the others itself, so they ' +
				'only need to be reachable from <em>it</em>, not from your browser. ' +
				'Each one must be running this dashboard. Totals cover the miners ' +
				'listed here; power is not shown because the RX0 reports none.</p>' +
			'<div id="rxd-swarm-result"></div>' +
		'</div></div>');
	if (window.loaded) loaded();
}

function rxdSwarmLoad() {
	$.ajax({ url: RXD_SWARM_URL, type: 'GET', dataType: 'json', timeout: 25000 })
		.done(rxdSwarmRender)
		.fail(function() {
			$('.right .srcollcss').html('<div class="rxd-oc"><div class="rxd-oc-card">' +
				'<h3>Swarm</h3><p class="rxd-oc-error">Could not reach the miner bridge ' +
				'at ' + RXD_BRIDGE_BASE + '.</p></div></div>');
			if (window.loaded) loaded();
		});
}

function rxdSwarmSavePeers(peers, done) {
	$.ajax({
		url: RXD_PEERS_URL, type: 'POST', contentType: 'application/json',
		data: JSON.stringify({ peers: peers }), dataType: 'json', timeout: 15000
	}).done(done).fail(function() {
		$('#rxd-swarm-result').html('<p class="rxd-oc-error">Could not save the list.</p>');
	});
}

function rxdSwarmMutate(change) {
	$.ajax({ url: RXD_PEERS_URL, type: 'GET', dataType: 'json', timeout: 10000 })
		.done(function(data) {
			rxdSwarmSavePeers(change(data.peers || []), function() { rxdSwarmLoad(); });
		});
}

function rxdSwarmMenu() {
	rxdNavSelect('rxdSwarmMenu');
	$('.right .srcollcss').html('<div class="rxd-oc"><div class="rxd-oc-card">' +
		'<h3>Swarm</h3><p class="rxd-oc-busy">Contacting the other miners...</p>' +
		'</div></div>');
	rxdSwarmLoad();
}

function rxdAddExtraNav() {
	var list = $('.left ul');
	if (list.length === 0) return;

	// Both sit under Overclock, which is itself after Mining Settings.
	var anchor = list.find('.rxdOcMenu');
	if (anchor.length === 0) return;

	if (list.find('.rxdFanMenu').length === 0) {
		var fan = $('<li class="rxdFanMenu menucss"><span>Fan</span></li>');
		anchor.after(fan);
		fan.on('click', function() { if (window.menu) menu(); rxdFanMenu(); });
	}
	if (list.find('.rxdSwarmMenu').length === 0) {
		var swarm = $('<li class="rxdSwarmMenu menucss"><span>Swarm</span></li>');
		list.find('.rxdFanMenu').after(swarm);
		swarm.on('click', function() { if (window.menu) menu(); rxdSwarmMenu(); });
	}

	// Stock pages clear all three of ours; our own pages set themselves through
	// rxdNavSelect, which clears the other two first. Nothing pairwise.
	$('.left .userMenu, .left .fpgaMenu, .left .ipMenu, .left .sysMenu, ' +
	  '.left .firMenu, .left .logMenu')
		.on('click', function() { rxdNavSelect(null); });

	$(document)
		.on('click', '#rxd-fan-apply', rxdFanApply)
		.on('change', 'input[name="rxd-fan-mode"]', rxdFanToggleGroups)
		.on('input change', '.rxd-fan-slider input[type="range"]', function() {
			var el = $(this);
			$('#' + el.attr('id') + '-out').html(el.val() + (el.data('suffix') || ''));
		})
		.on('click', '#rxd-swarm-add', function() {
			var host = $.trim($('#rxd-swarm-host').val());
			var name = $.trim($('#rxd-swarm-name').val());
			if (!host) return;
			rxdSwarmMutate(function(peers) {
				// Re-adding an address should rename it, not duplicate the row.
				peers = peers.filter(function(p) { return p.host !== host; });
				peers.push({ host: host, name: name });
				return peers;
			});
		})
		// Scanning adds peers with no name, and until now the only way to give
		// one was to retype the address into the Add form - which does rename
		// rather than duplicate, but nothing on the page says so. Editing the
		// cell in place is the obvious gesture, and it reuses the same mutate.
		.on('click', '.rxd-swarm-rename', function() {
			var btn = $(this);
			var host = String(btn.data('host'));
			var cell = btn.closest('tr').children('td').first();
			if (cell.find('.rxd-swarm-rename-input').length) return;

			var input = $('<input type="text" class="rxd-swarm-rename-input">')
				.val(btn.data('name') || '')
				.attr('placeholder', host)
				.attr('aria-label', 'Name for ' + host);
			cell.empty().append(input);
			input.trigger('focus').trigger('select');

			// Enter and losing focus both commit; Escape abandons. The guard
			// matters because committing re-renders the table, which blurs the
			// input and would otherwise run the save a second time.
			var settled = false;
			function commit() {
				if (settled) return;
				settled = true;
				var name = $.trim(input.val());
				rxdSwarmMutate(function(peers) {
					return peers.map(function(p) {
						return p.host === host ? { host: host, name: name } : p;
					});
				});
			}
			input.on('keydown', function(e) {
				if (e.which === 13) { commit(); }
				else if (e.which === 27) { settled = true; rxdSwarmLoad(); }
			}).on('blur', commit);
		})
		.on('click', '.rxd-swarm-del', function() {
			var host = $(this).data('host');
			rxdConfirm('Remove a miner',
				'<p>Stop showing <strong>' + rxdFanEscape(host) + '</strong> here?</p>' +
					'<p>Nothing changes on that miner - it keeps hashing, and you can ' +
					'add it back by address.</p>',
				'Remove',
				function() {
					rxdSwarmMutate(function(peers) {
						return peers.filter(function(p) { return p.host !== host; });
					});
				});
		})
		.on('click', '#rxd-swarm-scan', function() {
			var prefix = location.hostname.split('.').slice(0, 3).join('.');
			if (!/^\d+\.\d+\.\d+$/.test(prefix)) {
				$('#rxd-swarm-result').html('<p class="rxd-oc-error">Only works when ' +
					'you reach this miner by IP address.</p>');
				return;
			}
			$('#rxd-swarm-result').html('<p class="rxd-oc-busy">Scanning ' + prefix +
				'.0/24 - this takes a few seconds...</p>');
			$.ajax({
				url: RXD_SCAN_URL, type: 'POST', contentType: 'application/json',
				data: JSON.stringify({ prefix: prefix }), dataType: 'json', timeout: 60000
			}).done(function(re) {
				var found = re['new'] || [];
				if (!found.length) {
					$('#rxd-swarm-result').html('<p class="rxd-oc-note">No miners found ' +
						'that are not already listed.</p>');
					return;
				}
				rxdSwarmMutate(function(peers) {
					found.forEach(function(host) { peers.push({ host: host, name: '' }); });
					return peers;
				});
			}).fail(function() {
				$('#rxd-swarm-result').html('<p class="rxd-oc-error">Scan failed.</p>');
			});
		});
}

function rxdCreateChartContainers() {
	if ($('#rxd-charts-row').length > 0 || $('#rxd-hash-row').length > 0) return;
	if ($('.right .content3').length === 0) return;

	// Hashrate gets a row to itself - it is the chart worth reading closely,
	// and a day of 5-minute samples needs the width. Temperature and fans
	// share the row below it.
	$('.right .content3').after(
		'<div id="rxd-hash-row" class="radiant-charts rxd-charts-single">' +
			'<div class="radiant-chart-box" id="rxd-hash-chart"></div>' +
		'</div>' +
		'<div id="rxd-charts-row" class="radiant-charts">' +
			'<div class="radiant-chart-box" id="rxd-temp-chart"></div>' +
			'<div class="radiant-chart-box" id="rxd-fan-chart"></div>' +
		'</div>'
	);
}

function rxdMakeChart(container, title, yTitle, series, yMin, ySuffix, categories) {
	// Instants in, labels out - rxdTimeLabels renders in the viewer's clock.
	var cats = categories || rxdTimeLabels(RXD.history);
	var opts = $.extend(true, {}, HC_DARK, {
		chart: {
			renderTo: container,
			type: 'spline',
			zoomType: 'x',
			panning: true,
			panKey: 'ctrl',
			height: 270
		},
		title: { text: title },
		subtitle: { text: 'Left click + drag to zoom. Ctrl + drag to pan' },
		xAxis: {
			categories: cats,
			tickInterval: Math.max(1, Math.floor(cats.length / 12)),
			crosshair: { width: 1, color: '#35353E' }
		},
		yAxis: {
			title: { text: yTitle },
			min: yMin,
			labels: { formatter: function() { return this.value + ySuffix; } },
			crosshair: { width: 1, color: '#35353E', dashStyle: 'Dash' }
		},
		tooltip: {
			shared: true,
			formatter: function() {
				var s = '<b>' + this.x + '</b>';
				$.each(this.points, function() {
					s += '<br/><span style="color:' + this.color + '">●</span> ' +
						this.series.name + ': <b>' + this.y + ySuffix + '</b>';
				});
				return s;
			}
		},
		plotOptions: {
			spline: {
				lineWidth: 2,
				states: { hover: { lineWidth: 3 } },
				marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } }
			}
		},
		series: series
	});
	return Highcharts.chart(opts);
}

function rxdDropStaleCharts() {
	// Leaving the page replaces .srcollcss wholesale, which destroys our chart
	// nodes while the Highcharts instances live on. Without this the update
	// path below would silently redraw detached DOM and the charts would never
	// come back.
	if ($('#rxd-charts-row').length > 0 && $('#rxd-hash-row').length > 0) return;
	['hash', 'temp', 'fan'].forEach(function(k) {
		if (RXD.charts[k]) {
			try { RXD.charts[k].destroy(); } catch(e) {}
			RXD.charts[k] = null;
		}
	});
}

function rxdUpdateCharts() {
	var h = RXD.history;
	if (h.timestamps.length < 2) return;
	if (typeof Highcharts === 'undefined') return;

	rxdDropStaleCharts();
	rxdCreateChartContainers();

	// Cheap and idempotent: the stock panel is rebuilt whenever the page is
	// navigated away from and back, taking our row and our column names with
	// it.
	if (RXD.protection !== undefined) rxdRenderProtection(RXD.protection);
	if (RXD.chip) rxdRenderClock(RXD.chip);
	if (RXD.lastPanelData) rxdRenderHealth(RXD.lastPanelData);
	rxdRenameBoardColumns();
	rxdAugmentBoardTable();

	// The stock hashrate chart only ever holds the current boot. This one is
	// seeded from the bridge's replay of the miner's logs, so it spans a day
	// and across restarts.
	if (RXD.charts.hash) {
		RXD.charts.hash.xAxis[0].setCategories(rxdTimeLabels(h), false);
		RXD.charts.hash.series[0].setData(h.hashrate, false);
		RXD.charts.hash.redraw();
	} else if ($('#rxd-hash-chart').length) {
		RXD.charts.hash = rxdMakeChart('rxd-hash-chart', 'Miner Hashrate (24 h)', 'Hashrate', [
			{ name: 'Hashrate', data: h.hashrate.slice(), color: RXD_BRAND.teal }
		], 0, ' GH/s');
	}

	if (RXD.charts.temp) {
		RXD.charts.temp.xAxis[0].setCategories(rxdTimeLabels(h), false);
		RXD.charts.temp.series[0].setData(h.temp1, false);
		RXD.charts.temp.series[1].setData(h.temp2, false);
		RXD.charts.temp.redraw();
	} else if ($('#rxd-temp-chart').length) {
		// Same two sensors as the hash board table, same names - see
		// RXD_BOARD_TEMP_NAMES for what the readings support calling them.
		RXD.charts.temp = rxdMakeChart('rxd-temp-chart', 'Board Temperature', 'Temperature', [
			{ name: 'Sensor 1 (hot)', data: h.temp1.slice(), color: RXD_BRAND.teal },
			{ name: 'Sensor 2 (cool)', data: h.temp2.slice(), color: RXD_BRAND.blue3 }
		], 0, ' °C');
	}

	if (RXD.charts.fan) {
		RXD.charts.fan.xAxis[0].setCategories(rxdTimeLabels(h), false);
		RXD.charts.fan.series[0].setData(h.fan1, false);
		RXD.charts.fan.series[1].setData(h.fan2, false);
		RXD.charts.fan.redraw();
	} else if ($('#rxd-fan-chart').length) {
		RXD.charts.fan = rxdMakeChart('rxd-fan-chart', 'Fan Speed', 'RPM', [
			{ name: 'Fan 1', data: h.fan1.slice(), color: RXD_BRAND.softBlue },
			{ name: 'Fan 2', data: h.fan2.slice(), color: RXD_BRAND.blue1 }
		], 0, ' RPM');
	}
}

function rxdInit() {
	if (RXD.initialized) return;
	RXD.initialized = true;

	rxdLoadHistory();
	rxdLoadChipHistory();
	rxdBrandSidebar();
	rxdSetupMobileNav();
	rxdWatchForFanControl();
	rxdAddOcNav();
	// Must follow rxdAddOcNav: both items are inserted relative to it.
	rxdAddExtraNav();

	if (typeof Highcharts !== 'undefined') {
		Highcharts.setOptions({
			global: { useUTC: false },
			chart: { backgroundColor: 'transparent',
			         style: { fontFamily: "'Inter', system-ui, sans-serif" } }
		});
	}

	// Board data arrives via the content3 hook installed in base.js, which
	// fires on every stock refresh. No separate polling for it - that would
	// add load to the SoC and can collide with the stock request.
	setTimeout(rxdUpdateCharts, 1500);

	// Replayed from the miner's logs once per page load, so the charts open
	// with a day of history instead of starting from whatever this browser
	// happens to have seen. Fetched once rather than on the refresh timer:
	// the response covers 24h and the live tail keeps arriving above.
	setTimeout(rxdFetchHistory, 800);

	// Chip data has no such hook, so it is fetched directly. The bridge only
	// reads, and the interval is well clear of the stock refresh. Fetched
	// early rather than at 2.5s: the Protection and clock pills live on the
	// status card, and arriving well after everything else around them read as
	// a fault rather than as loading.
	setTimeout(rxdFetchChipData, 500);

	// Seeded from the miner's own record so the chip charts show the same
	// history in every browser, not just the one that happened to be open.
	setTimeout(rxdFetchChipHistory, 1000);

	// Output against expected. Derived from the miner's 30-minute average, so
	// it only moves every few minutes - polling it faster would cost the SoC
	// three command-port round trips for a number that has not changed.
	setTimeout(rxdFetchPerformance, 2000);
	// After the two history fetches above have had time to land.
	setTimeout(rxdRenderDayTile, 2500);
	setInterval(rxdFetchPerformance, 300000);
	RXD.chipInterval = setInterval(rxdFetchChipData, 60000);

	// Both histories are re-seeded on a timer rather than once per load. Live
	// samples append about once a minute against a 288-point cap, so a single
	// seed is fully evicted after ~4.8 hours and the charts silently stop
	// being the day they claim to be. See RXD_HISTORY_REFRESH_MS.
	setInterval(rxdFetchHistory, RXD_HISTORY_REFRESH_MS);
	setInterval(rxdFetchChipHistory, RXD_HISTORY_REFRESH_MS);

	// Only alive while the miner is inside its 5-minute averaging window: the
	// first tick stops the timer again if the page was opened any later than
	// that, which is almost always.
	RXD.warmupTimer = setInterval(rxdWarmupPoll, RXD_WARMUP_POLL_MS);
	setTimeout(rxdWarmupPoll, 1200);

	// Nothing else on this page updates itself - see rxdRefreshPanel.
	rxdScheduleRefresh();
	rxdAddRefreshControl();
	setInterval(rxdRefreshTick, RXD_REFRESH_TICK_MS);
	rxdRefreshTick();
}

$(document).ready(function() {
	rxdInit();
});
