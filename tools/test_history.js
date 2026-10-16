// Why the chip charts ran on a different timescale from the board charts
// above them, why both quietly stopped being the day they claimed to be, and
// the guards against each cause.
//
// 1. /chiphistory used to send 'HH:MM' strings rendered on the MINER, whose
//    clock ran four hours ahead of the viewer's, while /history sends epoch ms.
//    Two rows of charts, two clocks. Both now store instants and render them
//    at draw time, in the viewer's clock.
//
// 2. An HH:MM carries no date. Both series are kept in localStorage and
//    appended to only while a tab is open, so an array could hold a reading
//    from days ago beside today's with nothing to say so. Five PCB sensor
//    misreads of 127 C from October 3rd-6th were drawn as spikes at "13:29"
//    on the 16th because of this.
//
// 3. The chip seed was kept only when the server's array was LONGER than the
//    browser's. The bridge samples every 5 minutes, an open tab appends every
//    minute, so the local copy is five times denser - longer while covering a
//    fifth of the time. Once it hit the 288-point cap it beat any 24 h the
//    bridge could return and the authoritative copy was discarded for good.
//
// 4. Both histories were seeded ONCE per page load. Live samples append about
//    once a minute against a 288-point cap, so after ~4.8 hours the appends
//    have evicted every seeded point and a chart labelled "24 h" is really
//    showing the last 4.8 hours this tab happened to be open.
//
// 5. The x-axis is Highcharts categories, so points are spaced by index. Mix
//    5-minute and 1-minute points and the tick spacing changes partway along:
//    2 h per tick in the seeded head, ~25 min in the live tail. That is the
//    visible symptom of 3 and 4, not a fault of its own.
//
// No jsdom or jQuery, as in test_sensorgap.js: the pure functions are
// extracted from source and exercised directly.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'webui', 'js', 'radiant_dashboard.js');
const src = fs.readFileSync(SRC, 'utf8');

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

// Pulled from source so the test fails if the constant moves.
const RXD_MIN_SAMPLE_GAP_MS = Number(/RXD_MIN_SAMPLE_GAP_MS = (\d+)/.exec(src)[1]);
const RXD_SNAP_MS = Number(/RXD_SNAP_MS = (\d+)/.exec(src)[1]);
const RXD_TEMP_SENTINEL = Number(/RXD_TEMP_SENTINEL = (\d+)/.exec(src)[1]);
const RXD = {
    chipHistory: { timestamps: [], boards: {} },
    history: { timestamps: [], hashrate: [], temp1: [], temp2: [], fan1: [], fan2: [] },
    maxPoints: 288
};
const RXD_UNIT_TO_GH = { H: 1e-9, K: 1e-6, M: 1e-3, G: 1, T: 1e3, P: 1e6 };
function rxdSaveChipHistory() {}
function rxdSaveHistory() {}
function rxdRenderHealth() {}
function rxdParseHashrate() { return 0; }

eval(extract('rxdClock'));
eval(extract('rxdNum'));
eval(extract('rxdGap'));
eval(extract('rxdTempGap'));
eval(extract('rxdHashrateGH'));
eval(extract('rxdSnapWindow'));
eval(extract('rxdSnap'));
eval(extract('rxdCarryTail'));
eval(extract('rxdSeedHistory'));
eval(extract('rxdRecordData'));
eval(extract('rxdTimeLabels'));
eval(extract('rxdTimesAreEpoch'));
eval(extract('rxdCarryChipTail'));
eval(extract('rxdDropEmptyBoards'));
eval(extract('rxdEmptyBoardSeries'));
eval(extract('rxdRecordChipData'));

let failures = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
        (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

const SERIES = ['tempMin','tempAvg','tempMax','voltMin','voltAvg','voltMax',
                'pllMin','pllAvg','pllMax'];

// A history in the on-the-wire shape: n points every stepMs, ending at endMs.
function hist(endMs, n, stepMs, boards, base) {
    const h = { timestamps: [], boards: {} };
    (boards || ['1']).forEach(b => h.boards[b] = rxdEmptyBoardSeries());
    for (let i = n - 1; i >= 0; i--) h.timestamps.push(endMs - i * stepMs);
    h.timestamps.forEach((t, i) => {
        Object.keys(h.boards).forEach(b => {
            SERIES.forEach(sk => h.boards[b][sk].push((base || 100) + i));
        });
    });
    return h;
}

function aligned(h) {
    return Object.keys(h.boards).every(b =>
        SERIES.every(sk => h.boards[b][sk].length === h.timestamps.length));
}

const MIN = 60000;
const NOW = 1792178599000;   // the real clock this was found at

console.log('rxdChipTimesAreEpoch: tells the new wire format from the old');
check('epoch ms', rxdTimesAreEpoch({ timestamps: [NOW] }), true);
check("'HH:MM' from a pre-epoch bridge",
    rxdTimesAreEpoch({ timestamps: ['06:11'] }), false);
check('empty is not epoch', rxdTimesAreEpoch({ timestamps: [] }), false);
check('missing payload', rxdTimesAreEpoch(undefined), false);
check('no timestamps key', rxdTimesAreEpoch({}), false);

console.log('');
console.log('rxdChipLabels: the browser renders, in the browser\'s clock');
const lbl = rxdTimeLabels({ timestamps: [NOW, NOW + 5 * MIN] });
check('two points five minutes apart differ by five minutes',
    (Number(lbl[1].slice(3)) - Number(lbl[0].slice(3)) + 60) % 60, 5);
check('rendered HH:MM', /^\d\d:\d\d$/.test(lbl[0]), true);
check('and it agrees with rxdClock, which /history uses',
    lbl[0], rxdClock(NOW));
check('a legacy string passes through untouched, not mangled',
    rxdTimeLabels({ timestamps: ['06:11', '06:16'] }), ['06:11', '06:16']);
check('empty', rxdTimeLabels({ timestamps: [] }), []);
check('absent', rxdTimeLabels({}), []);

console.log('');
console.log('the regression: a dense local copy must NOT beat the server');
// The exact numbers this was found on: the bridge held 227 samples at 300 s
// (18.9 h), the browser 288 at 60 s (4.8 h) and pinned at RXD.maxPoints.
const server = hist(NOW, 227, 5 * MIN, ['1'], 100);
const localDense = hist(NOW - 20 * 3600000, 288, MIN, ['1'], 900);
check('the local copy really is the longer one - the old test',
    localDense.timestamps.length > server.timestamps.length, true);
check('...while covering far less time',
    (localDense.timestamps[287] - localDense.timestamps[0]) <
    (server.timestamps[226] - server.timestamps[0]), true);

rxdCarryChipTail(localDense, server);
check('nothing stale is carried over', server.timestamps.length, 227);
check('the server copy is intact and still ends now',
    server.timestamps[server.timestamps.length - 1], NOW);
check('its first point is the bridge\'s, not the browser\'s',
    server.timestamps[0], NOW - 226 * 5 * MIN);
check('series stay aligned with timestamps', aligned(server), true);

console.log('');
console.log('but a genuinely newer local tail IS carried');
const srv = hist(NOW, 10, 5 * MIN, ['1'], 100);
// A tab open for four minutes past the bridge's last 5-minute sample.
const loc = { timestamps: [NOW - MIN, NOW, NOW + 2 * MIN, NOW + 3 * MIN],
              boards: { '1': rxdEmptyBoardSeries() } };
loc.timestamps.forEach((t, i) => SERIES.forEach(sk => loc.boards['1'][sk].push(700 + i)));

rxdCarryChipTail(loc, srv);
check('only the two points past the server\'s last survive',
    srv.timestamps.length, 12);
check('and they are the right two, in order',
    srv.timestamps.slice(-2), [NOW + 2 * MIN, NOW + 3 * MIN]);
check('a point equal to the server\'s last is not duplicated',
    srv.timestamps.filter(t => t === NOW).length, 1);
check('their values came across', srv.boards['1'].pllAvg.slice(-2), [702, 703]);
check('series stay aligned', aligned(srv), true);
check('the series is strictly increasing - no backwards jump',
    srv.timestamps.every((t, i) => i === 0 || t > srv.timestamps[i - 1]), true);

console.log('');
console.log('a board the server lists but the browser never saw gaps, not zeroes');
const twoBoard = hist(NOW, 3, 5 * MIN, ['1', '2'], 100);
const oneBoard = { timestamps: [NOW + MIN], boards: { '1': rxdEmptyBoardSeries() } };
SERIES.forEach(sk => oneBoard.boards['1'][sk].push(500));
rxdCarryChipTail(oneBoard, twoBoard);
check('board 1 took the value', twoBoard.boards['1'].tempAvg.slice(-1), [500]);
check('board 2 took a gap, not 0 C', twoBoard.boards['2'].tempAvg.slice(-1), [null]);
check('both boards stay aligned', aligned(twoBoard), true);

console.log('');
console.log('no common clock means no merge, rather than a wrong one');
const legacySrv = { timestamps: ['06:11', '06:16'],
                    boards: { '1': rxdEmptyBoardSeries() } };
legacySrv.timestamps.forEach(() => SERIES.forEach(sk => legacySrv.boards['1'][sk].push(1)));
rxdCarryChipTail({ timestamps: [NOW], boards: { '1': rxdEmptyBoardSeries() } }, legacySrv);
check('epoch local + legacy server: server kept as it stands',
    legacySrv.timestamps, ['06:11', '06:16']);
const okSrv = hist(NOW, 2, 5 * MIN, ['1'], 100);
rxdCarryChipTail({ timestamps: ['18:17'], boards: { '1': rxdEmptyBoardSeries() } }, okSrv);
check('legacy local + epoch server: nothing is carried across',
    okSrv.timestamps.length, 2);
check('an empty local copy is not a merge either',
    (rxdCarryChipTail({ timestamps: [], boards: {} }, okSrv), okSrv.timestamps.length), 2);

console.log('');
console.log('rxdRecordChipData: live points are instants on the browser clock');
const sample = { boards: [{ board: 1, temp: { min: 64, avg: 66, max: 67 },
                            voltage: { min: 368, avg: 371, max: 376 },
                            pll: { min: 775, avg: 775, max: 775 } }] };
const realNow = Date.now;
function at(ms, fn) { Date.now = () => ms; try { return fn(); } finally { Date.now = realNow; } }

RXD.chipHistory = { timestamps: [], boards: {} };
at(NOW, () => rxdRecordChipData(sample));
check('a number, not a string', typeof RXD.chipHistory.timestamps[0], 'number');
check('the instant it was taken', RXD.chipHistory.timestamps[0], NOW);

at(NOW + RXD_MIN_SAMPLE_GAP_MS - 1000, () => rxdRecordChipData(sample));
check('a second fetch moments later is dropped',
    RXD.chipHistory.timestamps.length, 1);
at(NOW + RXD_MIN_SAMPLE_GAP_MS + 1000, () => rxdRecordChipData(sample));
check('one past the guard is kept', RXD.chipHistory.timestamps.length, 2);
check('the 60 s poll interval clears the guard comfortably',
    MIN > RXD_MIN_SAMPLE_GAP_MS, true);

// Two samples in the same minute used to collapse, because the old guard
// compared 'HH:MM'. They are distinct instants and both belong.
RXD.chipHistory = { timestamps: [], boards: {} };
at(NOW, () => rxdRecordChipData(sample));
at(NOW + 40000, () => rxdRecordChipData(sample));
check('two samples 40 s apart inside one minute are both kept',
    RXD.chipHistory.timestamps.length, 2);

RXD.chipHistory = { timestamps: ['18:17'], boards: { '1': rxdEmptyBoardSeries() } };
SERIES.forEach(sk => RXD.chipHistory.boards['1'][sk].push(1));
at(NOW, () => rxdRecordChipData(sample));
check('browser-clock points are NOT appended to miner-clock ones',
    RXD.chipHistory.timestamps, ['18:17']);

RXD.chipHistory = { timestamps: [], boards: {} };
for (let i = 0; i < RXD.maxPoints + 20; i++) {
    at(NOW + i * MIN, () => rxdRecordChipData(sample));
}
check('the cap still holds', RXD.chipHistory.timestamps.length, RXD.maxPoints);
check('and it drops the oldest, keeping the newest',
    RXD.chipHistory.timestamps[RXD.maxPoints - 1], NOW + (RXD.maxPoints + 19) * MIN);
check('series still aligned at the cap', aligned(RXD.chipHistory), true);

console.log('');
console.log('the BOARD history: the seed stores instants too');
// /history already returns epoch ms; rxdSeedHistory used to throw that away
// with rxdClock() before storing. Payload shape: [epochMs, value] pairs.
function payload(endMs, n, stepMs) {
    const p = { hashrate: [], fans: [], boards: { '1': { pcbtemp1: [], pcbtemp2: [] } } };
    for (let i = n - 1; i >= 0; i--) {
        const t = endMs - i * stepMs;
        p.hashrate.push([t, 324 + (i % 3)]);
        p.fans.push([t, 1206, 1198]);
        p.boards['1'].pcbtemp1.push([t, 71]);
        p.boards['1'].pcbtemp2.push([t, 49]);
    }
    return p;
}

RXD.history = { timestamps: [], hashrate: [], temp1: [], temp2: [], fan1: [], fan2: [] };
check('a seed is accepted', rxdSeedHistory(payload(NOW, 20, 302000)), true);
check('timestamps are numbers, not HH:MM',
    typeof RXD.history.timestamps[0], 'number');
check('and they are the payload\'s own instants',
    RXD.history.timestamps[19], NOW);
check('rendering them agrees with the chip row',
    rxdTimeLabels(RXD.history)[19], rxdClock(NOW));
check('a short payload is refused', rxdSeedHistory({ hashrate: [] }), false);

console.log('');
console.log('127 C reaches the chart through both paths, and is a gap in both');
// The real shape from his.log: one isolated sentinel in an otherwise healthy
// series, the other sensor reading normally in the same pass.
const spiked = payload(NOW, 20, 302000);
spiked.boards['1'].pcbtemp1[7][1] = RXD_TEMP_SENTINEL;
spiked.boards['1'].pcbtemp2[12][1] = RXD_TEMP_SENTINEL;
RXD.history = { timestamps: [], hashrate: [], temp1: [], temp2: [], fan1: [], fan2: [] };
rxdSeedHistory(spiked);
check('the seeded sentinel is a gap', RXD.history.temp1[7], null);
check('on the other sensor too', RXD.history.temp2[12], null);
check('no 127 anywhere in the seeded series',
    RXD.history.temp1.concat(RXD.history.temp2)
        .filter(v => v === RXD_TEMP_SENTINEL).length, 0);
check('its neighbours are untouched',
    [RXD.history.temp1[6], RXD.history.temp1[8]], [71, 71]);
check('the sample itself is kept - only that one reading is missing',
    RXD.history.timestamps.length, 20);
check('and the hashrate at that instant still plots',
    RXD.history.hashrate[7] > 0, true);

// The live path: the panel can carry one before the next re-seed covers it.
RXD.history = { timestamps: [], hashrate: [], temp1: [], temp2: [], fan1: [], fan2: [] };
at(NOW, () => rxdRecordData({ rtpow_hash: 324, rtpow_unit: 'G',
    fans: [1206, 1198], boards: [{ intmp: RXD_TEMP_SENTINEL, outtmp: 49 }] }));
check('a live sentinel is a gap', RXD.history.temp1[0], null);
check('the sensor that answered is kept', RXD.history.temp2[0], 49);

// rxdTempGap's own semantics - which value is filtered and which is not -
// live in test_sensorgap.js, beside rxdGap's.

console.log('');
console.log('the eviction that made a 24 h chart into a 4.8 h one');
// 288 live appends at one a minute completely displace a seeded day.
RXD.history = { timestamps: [], hashrate: [], temp1: [], temp2: [], fan1: [], fan2: [] };
rxdSeedHistory(payload(NOW, 288, 302000));
const seededSpanH =
    (RXD.history.timestamps[287] - RXD.history.timestamps[0]) / 3600000;
check('the seed really is a day', Math.round(seededSpanH), 24);

const live = { rtpow_hash: 324, rtpow_unit: 'G', fans: [1206, 1198],
               boards: [{ intmp: 71, outtmp: 49 }] };
for (let i = 1; i <= RXD.maxPoints; i++) {
    at(NOW + i * MIN, () => rxdRecordData(live));
}
const afterSpanH =
    (RXD.history.timestamps[287] - RXD.history.timestamps[0]) / 3600000;
check('after 288 live samples not one seeded point is left',
    RXD.history.timestamps[0] > NOW, true);
check('and the window has collapsed to 4.8 h',
    afterSpanH.toFixed(1), '4.8');

// Which is exactly what the re-seed undoes.
const evicted = RXD.history.timestamps.slice();
rxdSeedHistory(payload(NOW + 288 * MIN, 288, 302000));
check('re-seeding restores the day',
    Math.round((RXD.history.timestamps[RXD.history.timestamps.length - 1] -
                RXD.history.timestamps[0]) / 3600000), 24);
check('the newest live point survived the re-seed',
    RXD.history.timestamps.indexOf(evicted[evicted.length - 1]) >= 0, true);
check('nothing is duplicated', new Set(RXD.history.timestamps).size,
    RXD.history.timestamps.length);
check('and it is still in order',
    RXD.history.timestamps.every((t, i) => i === 0 || t > RXD.history.timestamps[i - 1]),
    true);
check('the cap is respected',
    RXD.history.timestamps.length <= RXD.maxPoints, true);

console.log('');
console.log('rxdCarryTail: the flat-array counterpart');
const KEYS = ['hashrate', 'temp1', 'temp2', 'fan1', 'fan2'];
function flat(ts, v) {
    const h = { timestamps: ts.slice() };
    KEYS.forEach(k => h[k] = ts.map(() => v));
    return h;
}
const fresh = flat([NOW - MIN, NOW], 1);
rxdCarryTail(flat([NOW - MIN, NOW, NOW + MIN, NOW + 2 * MIN], 9), fresh, KEYS);
check('only the newer two cross', fresh.timestamps.length, 4);
check('their values come with them', fresh.hashrate.slice(-2), [9, 9]);
check('every series stays the same length',
    KEYS.every(k => fresh[k].length === fresh.timestamps.length), true);
const legacyFresh = flat([NOW], 1);
rxdCarryTail({ timestamps: ['13:29'], hashrate: [127] }, legacyFresh, KEYS);
check('a dateless local copy is dropped, not merged',
    legacyFresh.timestamps.length, 1);

console.log('');
console.log('rxdRecordData: board samples are instants, on the same guard');
RXD.history = { timestamps: [], hashrate: [], temp1: [], temp2: [], fan1: [], fan2: [] };
at(NOW, () => rxdRecordData(live));
check('a number', typeof RXD.history.timestamps[0], 'number');
at(NOW + RXD_MIN_SAMPLE_GAP_MS - 1000, () => rxdRecordData(live));
check('a double fire of the stock hook is dropped',
    RXD.history.timestamps.length, 1);
at(NOW + MIN, () => rxdRecordData(live));
check('the next real sample is kept', RXD.history.timestamps.length, 2);
check('a dead sensor is still a gap, not a zero',
    (at(NOW + 2 * MIN, () => rxdRecordData(
        { rtpow_hash: 324, rtpow_unit: 'G', fans: [0, 0],
          boards: [{ intmp: 71, outtmp: 49 }] })),
     RXD.history.fan1[2]), null);
check('zero hashrate is still a reading, not a gap',
    (at(NOW + 3 * MIN, () => rxdRecordData(
        { rtpow_hash: 0, rtpow_unit: 'G', fans: [1206, 1198],
          boards: [{ intmp: 71, outtmp: 49 }] })),
     RXD.history.hashrate[3]), 0);

RXD.history = flat(['13:29'], 1);
at(NOW, () => rxdRecordData(live));
check('instants are NOT appended to a dateless legacy series',
    RXD.history.timestamps, ['13:29']);

console.log('');
if (failures) {
    console.log(`${failures} failed`);
    process.exit(1);
}
console.log('all passed');
