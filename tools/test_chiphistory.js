// Why the three chip charts ran on a different timescale from the three above
// them, and the guards against each cause.
//
// 1. /chiphistory used to send 'HH:MM' strings rendered on the MINER, whose
//    clock ran four hours ahead of the viewer's, while /history sends epoch ms
//    that the browser renders itself. Two rows of charts, two clocks, a
//    constant offset between them - and an HH:MM carries no date, so points a
//    day apart sat side by side and a series could read backwards.
//
// 2. The seed was kept only when the server's array was LONGER than the
//    browser's. The bridge samples every 5 minutes; an open tab appends every
//    minute. The local copy is therefore five times denser, wins on length
//    while covering a fifth of the time, and once it hit the 288-point cap it
//    beat any 24 h the bridge could return - so the authoritative copy was
//    discarded on every load, for good.
//
// 3. The x-axis is Highcharts categories, so points are spaced by index. Mix
//    5-minute and 1-minute points in one array and the tick spacing changes
//    partway along: 2 h per tick in the seeded head, ~25 min in the live tail.
//    That is the visible symptom of 2, not a fault of its own.
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
const RXD_CHIP_MIN_GAP_MS = Number(/RXD_CHIP_MIN_GAP_MS = (\d+)/.exec(src)[1]);
const RXD = { chipHistory: { timestamps: [], boards: {} }, maxPoints: 288 };
function rxdSaveChipHistory() {}

eval(extract('rxdClock'));
eval(extract('rxdChipLabels'));
eval(extract('rxdChipTimesAreEpoch'));
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
check('epoch ms', rxdChipTimesAreEpoch({ timestamps: [NOW] }), true);
check("'HH:MM' from a pre-epoch bridge",
    rxdChipTimesAreEpoch({ timestamps: ['06:11'] }), false);
check('empty is not epoch', rxdChipTimesAreEpoch({ timestamps: [] }), false);
check('missing payload', rxdChipTimesAreEpoch(undefined), false);
check('no timestamps key', rxdChipTimesAreEpoch({}), false);

console.log('');
console.log('rxdChipLabels: the browser renders, in the browser\'s clock');
const lbl = rxdChipLabels({ timestamps: [NOW, NOW + 5 * MIN] });
check('two points five minutes apart differ by five minutes',
    (Number(lbl[1].slice(3)) - Number(lbl[0].slice(3)) + 60) % 60, 5);
check('rendered HH:MM', /^\d\d:\d\d$/.test(lbl[0]), true);
check('and it agrees with rxdClock, which /history uses',
    lbl[0], rxdClock(NOW));
check('a legacy string passes through untouched, not mangled',
    rxdChipLabels({ timestamps: ['06:11', '06:16'] }), ['06:11', '06:16']);
check('empty', rxdChipLabels({ timestamps: [] }), []);
check('absent', rxdChipLabels({}), []);

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

at(NOW + RXD_CHIP_MIN_GAP_MS - 1000, () => rxdRecordChipData(sample));
check('a second fetch moments later is dropped',
    RXD.chipHistory.timestamps.length, 1);
at(NOW + RXD_CHIP_MIN_GAP_MS + 1000, () => rxdRecordChipData(sample));
check('one past the guard is kept', RXD.chipHistory.timestamps.length, 2);
check('the 60 s poll interval clears the guard comfortably',
    MIN > RXD_CHIP_MIN_GAP_MS, true);

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
if (failures) {
    console.log(`${failures} failed`);
    process.exit(1);
}
console.log('all passed');
