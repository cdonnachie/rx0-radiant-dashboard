// The history charts' pure logic, pinned.
//
// Drawing cannot be tested without a DOM, but the two decisions that would
// actually mislead someone can be tested without one:
//
//   * which samples are plotted at all. 0 and 127 are the temperature
//     sensors' failed reads, not readings - plotting either draws a cliff
//     and makes a rebooting miner look like one whose cooling died. Zero
//     hashrate, by contrast, is a real measurement and must survive.
//   * the y-axis ticks, where a zero or NaN step would spin the tick loop
//     forever and hang the browser tab rather than merely look wrong.

const fs = require('fs');
const path = require('path');

// The page's logic moved out of index.html into app.js when the single file
// passed 54 KB. The markup is still read, separately, because the range
// buttons' limits are asserted against the bridge and the panels the router
// switches have to exist.
const SRC = path.join(__dirname, '..', 'device', 'web', 'app.js');
const src = fs.readFileSync(SRC, 'utf8');
const markup = fs.readFileSync(
    path.join(__dirname, '..', 'device', 'web', 'index.html'), 'utf8');

function extract(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('no ' + name);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
}

eval(extract('niceTicks'));
eval(extract('usable'));
eval(extract('fmtTick'));
eval(extract('prepareSeries'));
eval(extract('nearestSample'));
eval(extract('hoverTime'));
eval(extract('legendHTML'));

let failures = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
        (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

console.log('failed sensor reads are not plotted');
const sensor = { drop: v => v === 0 || v === 127 };
const rate = {};
check('0 C is a failed read, dropped', usable(sensor, [1, 0]), false);
check('127 C is the saturation value, dropped', usable(sensor, [1, 127]), false);
check('a real temperature survives', usable(sensor, [1, 65]), true);
check('126 is not the saturation value', usable(sensor, [1, 126]), true);
// Hashrate opts out: a miner that stopped really did produce zero.
check('zero HASHRATE is a real measurement', usable(rate, [1, 0]), true);
check('null is never plotted', usable(rate, [1, null]), false);
check('undefined is never plotted', usable(rate, [1, undefined]), false);

console.log('');
console.log('axis ticks are round numbers a person would choose');
check('0-320 gives hundreds', niceTicks(0, 320, 4), [0, 100, 200, 300]);
check('55-68 gives fives', niceTicks(55, 68, 4), [55, 60, 65]);
check('0-1 stays sub-unit', niceTicks(0, 1, 4), [0, 0.2, 0.4, 0.6, 0.8, 1]);

console.log('');
console.log('degenerate input terminates instead of hanging the tab');
check('a flat series still yields ticks', niceTicks(5, 5, 4).length > 0, true);
check('an inverted range terminates', niceTicks(10, 2, 4).length <= 50, true);
check('NaN yields no ticks rather than looping', niceTicks(NaN, NaN, 4), []);
check('and is capped either way', niceTicks(0, 1e9, 4).length <= 50, true);

console.log('');
console.log('time labels switch format with the window');
// Device clock is UTC and the reader is not, so these are rendered locally;
// the assertion is on SHAPE, which is what the window selector changes.
check('a short window shows clock time', /^\d\d:\d\d$/.test(fmtTick(Date.now(), 6)), true);
check('24h still shows clock time', /^\d\d:\d\d$/.test(fmtTick(Date.now(), 24)), true);
check('a long window shows the date', /^\d\d\/\d\d$/.test(fmtTick(Date.now(), 168)), true);

console.log('');
console.log('the page declares ranges the bridge will accept');
// HISTORY_MAX_HOURS = 24 * 30, HISTORY_MAX_POINTS = 2000. A range outside
// those is silently clamped by the bridge, so the chart would not show the
// window its own button claims.
const bridge = fs.readFileSync(
    path.join(__dirname, '..', 'device', 'rxd_bridge.py'), 'utf8');
const maxHours = eval(bridge.match(/HISTORY_MAX_HOURS = ([\d *]+)/)[1]);
const maxPoints = Number(bridge.match(/HISTORY_MAX_POINTS = (\d+)/)[1]);
const ranges = eval(src.match(/var RANGES = (\[[\s\S]*?\]);/)[1]);
check('every range is within the bridge hour limit',
    ranges.filter(r => r.hours > maxHours), []);
check('every range is within the bridge point limit',
    ranges.filter(r => r.points > maxPoints), []);
check('and none asks for fewer than the bridge floor of 10',
    ranges.filter(r => r.points < 10), []);

console.log('');
console.log('the warm-up banner names the right phase, and shuts up when settled');
// Each boundary matters: a banner that lingers past settling trains you to
// ignore it, and one that vanishes early lets you compare numbers that are
// still climbing. This board has produced two wrong conclusions from exactly
// that window, so the edges are pinned.
eval(src.match(/var WINDOW_SECONDS = \d+;/)[0]);
eval(src.match(/var MINER_START_SECONDS = \d+;/)[0]);
eval(src.match(/var SOAK_SECONDS = [^;]+;/)[0]);
eval(extract('soakState'));

const phase = s => { const r = soakState(s); return r === null ? null : r.key; };
check('the five-minute window is 300 s', WINDOW_SECONDS, 300);
// An hour, not the 48 minutes one cold start took: that was a single
// observation, today's settled at 50, and the convention everywhere else in
// this project is to drop a warm-up HOUR before comparing anything.
check('the soak is one hour', SOAK_SECONDS, 3600);
check('just booted: the miner is not reporting', phase(30), 'starting');
check('90 s in, still starting', phase(90), 'starting');
check('at 120 s the window phase begins', phase(120), 'window');
check('200 s is still filling the window', phase(200), 'window');
check('at 300 s the window is full and the ramp begins', phase(300), 'ramp');
check('17 min in: ramping', phase(17 * 60), 'ramp');
check('47 min in: still ramping', phase(47 * 60), 'ramp');
// 50 min is where this board actually settled; the banner deliberately runs
// past that rather than risk clearing while the number is still climbing.
check('50 min in: still nagging, on purpose', phase(50 * 60), 'ramp');
check('at exactly an hour it stops', phase(SOAK_SECONDS), null);
check('and stays quiet after', phase(9 * 3600), null);

// null uptime must not be read as zero: "we do not know" is not "just
// booted", and claiming a warm-up that is not happening is its own error.
check('unknown uptime says nothing', soakState(null), null);
check('undefined uptime says nothing', soakState(undefined), null);
check('NaN uptime says nothing', soakState(NaN), null);

const ramp = soakState(20 * 60);
check('the ramp phase warns against comparing clocks',
    /not compare clocks/i.test(ramp.detail), true);
// This used to assert the banner quoted "291 GH at 7 min" as THE measured
// curve, which was protecting the bug rather than the behaviour: that figure
// came from one 775 cold start, was still being shown after the board moved to
// 770, and the ramp turned out to be neither reproducible (305 vs 316 GH at
// 7 min on two boots at one clock) nor monotonic (334 at 22 min against a 324
// settled value, above theoretical maximum). The property worth locking down
// is the opposite one.
check('warns the reading is unreliable in both directions',
    /both directions/i.test(ramp.detail), true);
check('and gives the spread rather than a single curve',
    /305 and 316/.test(ramp.detail), true);
check('and no longer quotes the one 775 cold start',
    /291 GH at 7 min/.test(ramp.detail), false);
check('progress is a fraction of the soak', Math.round(ramp.progress * 100), 33);
check('progress never exceeds 1', soakState(SOAK_SECONDS - 1).progress <= 1, true);

console.log('');
console.log('the hover readout points at a real sample or says nothing');
// The chart's whole job is to be trusted at a glance, so the readout must not
// answer for a moment nobody measured. A reboot leaves a multi-minute hole in
// the series; a cursor over that hole has to come back empty rather than
// snapping to whichever reading happens to be closest.
const FIVE = 300000;
const even = prepareSeries([{ points: [
    [1000000, 320], [1000000 + FIVE, 321], [1000000 + 2 * FIVE, 319]] }])[0];
check('the cadence is the median gap, not the mean', even.median, FIVE);
check('a cursor on a sample returns it',
    nearestSample(even, 1000000 + FIVE)[1], 321);
check('and snaps to the closer neighbour between two',
    nearestSample(even, 1000000 + FIVE * 0.4)[1], 320);
check('just inside one and a half intervals still reads',
    nearestSample(even, 1000000 + 2 * FIVE + FIVE * 1.4)[1], 319);
check('beyond it reads nothing rather than the nearest',
    nearestSample(even, 1000000 + 2 * FIVE + FIVE * 2), null);
// The gap a reboot leaves. Snapping across it is exactly the error the broken
// path line already refuses to draw, so the two must agree.
const gapped = prepareSeries([{ points: [
    [0, 320], [FIVE, 321], [2 * FIVE, 320],
    [2 * FIVE + 40 * FIVE, 318], [3 * FIVE + 40 * FIVE, 319]] }])[0];
check('a cursor in a reboot gap reads nothing',
    nearestSample(gapped, 20 * FIVE), null);
check('and the same gap breaks the drawn line',
    (2 * FIVE + 40 * FIVE) - 2 * FIVE > gapped.maxGap, true);
// 0 and 127 are dropped before anything else sees them, so the readout can
// never show a failed sensor read as a temperature.
const hoverSensor = prepareSeries([{ drop: v => v === 0 || v === 127,
    points: [[0, 65], [FIVE, 127], [2 * FIVE, 64]] }])[0];
check('failed sensor reads are not hoverable', hoverSensor.good.length, 2);
check('and the cursor over one falls to a real neighbour',
    nearestSample(hoverSensor, FIVE)[1], 65);
check('an empty series is not hoverable', nearestSample(
    prepareSeries([{ points: [] }])[0], 0), null);

console.log('');
console.log('the legend reads the same whether or not a cursor is in it');
const one = [{ label: 'Hashrate', color: '#0ff', unit: ' GH/s', dp: 0,
               points: [[0, 320], [FIVE, 323]] }];
check('at rest it shows the latest reading',
    /323 GH\/s/.test(legendHTML(one)), true);
check('at rest it carries no timestamp',
    /class="at"/.test(legendHTML(one)), false);
check('hovering shows the hovered value, not the latest',
    /320 GH\/s/.test(legendHTML(one, [320], 0, 24)), true);
check('and stamps the moment', /class="at"/.test(legendHTML(one, [320], 0, 24)), true);
// A missing hovered value must be visibly missing. Rendering nothing leaves
// the previous number on screen and the reader attributes it to the cursor.
check('a gap renders as a dash, not as nothing',
    /—/.test(legendHTML(one, [null], 0, 24)), true);
check('seconds are never shown, the series is 5-minutely',
    /^\d\d:\d\d$/.test(hoverTime(Date.now(), 24)), true);
check('a long window dates the readout',
    /^\d\d\/\d\d \d\d:\d\d$/.test(hoverTime(Date.now(), 168)), true);

console.log('');
console.log('the markup and the script cannot drift apart');
// Splitting one file into three creates a failure that did not exist before:
// a renamed id, a panel the nav points at that was never written, a
// stylesheet that stopped being linked. None of those throws - the page just
// quietly loses a feature - so each is pinned here.
check('the markup loads the stylesheet', /href="app\.css"/.test(markup), true);
check('and the script', /src="app\.js"/.test(markup), true);
check('and keeps nothing inline, or the split has half come undone',
    /<style>|<script>[\s\S]/.test(markup), false);

// PAGES drives the nav, the routing and the lazy loading. onShow refers to
// functions this harness has no DOM for, so they are blanked before eval.
eval(src.match(/var PAGES = \[[\s\S]*?\];/)[0].replace(/onShow: \w+/g, 'onShow: null'));
const panels = markup.match(/<section class="page( hide)?" id="page-[a-z]+">/g) || [];
// Not a bare count any more. The Clock page is spliced into PAGES at runtime
// by maybeAddClockPage, only on a miner whose install enabled overclocking, so
// its panel is in the markup while its entry is not in the literal array. The
// invariant is still "no panel without a page and no page without a panel" -
// it just has to know about the one that arrives late.
const runtimePages = [...src.matchAll(/PAGES\.splice\([\s\S]{0,80}?id: '([a-z]+)'/g)]
    .map(m => m[1]);
check('the only panel not in the PAGES literal is one added at runtime',
    panels.map(s => s.match(/id="page-([a-z]+)"/)[1])
        .filter(id => !PAGES.some(p => p.id === id)),
    runtimePages);
check('and the runtime one is the overclock page, which is install-gated',
    runtimePages, ['clock']);
check('every page in the nav has a panel to show',
    PAGES.filter(p => !markup.includes('id="page-' + p.id + '"')), []);
// Exactly one, or the page opens showing two panels stacked, or none at all
// before the router runs.
check('exactly one panel starts visible',
    panels.filter(s => !s.includes('hide')).length, 1);
check('and it is the page the router falls back to',
    panels.find(s => !s.includes('hide')).includes('id="page-' + PAGES[0].id + '"'),
    true);

// Every literal $('id') in the script must exist in the markup. This is the
// one check that would have caught the ids the split could have dropped on
// the floor; the computed ones ($('tab-' + p.id)) are covered by the panel
// checks above.
const wanted = Array.from(new Set(
    Array.from(src.matchAll(/\$\('([a-zA-Z][\w-]*)'\)/g)).map(m => m[1])));
check('the script reaches for more than a couple of elements',
    wanted.length > 20, true);
// An element the script BUILDS is as real as one in index.html - the peer
// rename box lives inside a row that renderPeers writes - so the rule is
// "declared somewhere", not "declared in the markup". Still catches the thing
// it was written for: an id that exists in neither.
const built = new Set(
    Array.from(src.matchAll(/id="([a-zA-Z][\w-]*)"/g)).map(m => m[1]));
check('and every one of them exists in the markup or is built by the script',
    wanted.filter(id => !markup.includes('id="' + id + '"') && !built.has(id)), []);
// Named so the exception stays deliberate rather than becoming a hole.
check('exactly the ids the script builds for itself',
    wanted.filter(id => !markup.includes('id="' + id + '"')), ['peerRename']);

console.log('');
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
