// Two things that made a healthy miner look sick, and the guards against them.
//
// 1. A tach reading of 0 is not a stopped fan, it is a failed read - the two
//    are indistinguishable from outside. Plotted as a value it draws a cliff
//    to the floor of the axis, so a reboot (when the miner is down and nothing
//    answers) renders exactly like the cooling dying. 14 such points showed up
//    in one 24 h window and all 14 were reboots. They must be gaps.
//
// 2. The miner reports connect = 0 for the few seconds it spends opening the
//    socket after a reboot. Lumping that in with "Disconnected" paints the
//    health panel red while the Pool table right below it says "Connecting".
//
// No jsdom or jQuery, as in test_nav.js and test_fanstrip.js: the pure
// functions are extracted from source and exercised directly.

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

const RXD_SNAP_MS = 150000;
eval(extract('rxdNum'));
eval(extract('rxdGap'));
eval(extract('rxdSnapWindow'));
eval(extract('rxdSnap'));
eval(extract('rxdPoolState'));

let failures = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
        (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

console.log('rxdGap: 0 and unreadable become gaps, real values survive');
check('a zero tach is a gap, not zero rpm', rxdGap(0), null);
check('the string "0" too, since JSON brings strings', rxdGap('0'), null);
check('0 degrees is a failed sensor, not a cold chip', rxdGap(0.0), null);
check('missing', rxdGap(undefined), null);
check('null', rxdGap(null), null);
check('empty string', rxdGap(''), null);
check('not a number', rxdGap('--'), null);
check('a real reading passes through', rxdGap(1162), 1162);
check('a real reading as a string', rxdGap('1162'), 1162);
check('a fractional reading', rxdGap(66.5), 66.5);
check('6034 rpm, the fan at maximum', rxdGap(6034), 6034);

console.log('');
console.log('rxdNum is unchanged - 0 still means 0 where a count is wanted');
check('rxdNum keeps zero', rxdNum(0), 0);
check('rxdNum floors junk at zero', rxdNum('--'), 0);

console.log('');
console.log('the seeding path: a reboot leaves a hole, not a crater');
// The real shape: fan samples every ~302 s, a block of them reading 0 while
// the miner was down, then real readings again.
const t0 = 1792112628000;
const fans = [];
for (let i = 0; i < 8; i++) {
    const zero = (i >= 3 && i <= 5);
    fans.push([t0 + i * 302000, zero ? 0 : 1162, zero ? 0 : 1117]);
}
const seededFan1 = [], seededFan2 = [];
const cursor = {};
for (let i = 0; i < 8; i++) {
    const fan = rxdSnap(fans, t0 + i * 303000, cursor);
    seededFan1.push(rxdGap(fan && fan[1]));
    seededFan2.push(rxdGap(fan && fan[2]));
}
check('fan1: the three dead reads are gaps',
    seededFan1, [1162, 1162, 1162, null, null, null, 1162, 1162]);
check('fan2: likewise', seededFan2, [1117, 1117, 1117, null, null, null, 1117, 1117]);
check('nothing was plotted at zero', seededFan1.filter(v => v === 0).length, 0);

// A sample too far from any reading is also a gap rather than a zero.
const sparse = [[t0, 1162], [t0 + 3600000, 1206]];
check('no sample within the snap window is a gap too',
    rxdGap(rxdSnap(sparse, t0 + 1800000, {}) || null), null);

console.log('');
console.log('the snap tolerance must exceed HALF the sample interval');
// The bridge logs every ~302 s. Half of that is 151 s, which is MORE than the
// old fixed 150 s tolerance - so whenever a hashrate timestamp landed near the
// midpoint between two fan readings, the adjacent reading was rejected and the
// chart drew a gap (and before gaps, a dip to 0 rpm). It showed up as a null
// every nineteenth point, roughly every 95 minutes, which is far too regular
// to be a sensor.
const STEP = 302000;
const grid = [];
for (let i = 0; i < 300; i++) grid.push([1792000000000 + i * STEP, 1162, 1117]);

check('the window is derived from the series, not fixed',
    rxdSnapWindow(grid), Math.round(STEP * 1.5));
check('and it comfortably clears half an interval',
    rxdSnapWindow(grid) > STEP / 2, true);
check('the old fixed tolerance did NOT clear half an interval',
    RXD_SNAP_MS > STEP / 2, false);

// Ask at the worst possible phase: exactly between two readings.
const worst = grid[10][0] + STEP / 2;
check('at the midpoint the old tolerance rejects an adjacent reading',
    rxdSnap(grid, worst, {}, RXD_SNAP_MS), null);
check('the new one returns it', rxdSnap(grid, worst, {}, rxdSnapWindow(grid))[1], 1162);

// Sweep every phase across one interval: nothing should ever be dropped.
let dropped = 0;
const win = rxdSnapWindow(grid);
for (let off = 0; off < STEP; off += 1000) {
    if (!rxdSnap(grid, grid[20][0] + off, {}, win)) dropped++;
}
check('no phase anywhere in the interval drops a reading', dropped, 0);

// But a real hole must still gap: drop four readings and ask in the middle.
const holed = grid.slice(0, 40).concat(grid.slice(45));
check('a genuine hole is still a gap',
    rxdSnap(holed, grid[42][0], {}, rxdSnapWindow(holed)), null);
check('the hole does not widen the window for everyone else',
    rxdSnapWindow(holed), Math.round(STEP * 1.5));

console.log('');
console.log('rxdPoolState: connecting is not disconnected');
// TEST-NET-1, as in test_stockpeer.py: a fixture address that is reserved for
// documentation and cannot belong to anyone's real pool.
const A = 'stratum+tcp://192.0.2.1:54321';
check('connected',
    rxdPoolState([{ addr: A, connect: 1 }, { addr: A, connect: -1 }]).text, 'Connected');
check('the live case from the reboot: one connecting, two never tried',
    rxdPoolState([{ addr: A, connect: 0 }, { addr: A, connect: -1 },
                  { addr: A, connect: -1 }]).text, 'Connecting');
check('and it is not painted red',
    rxdPoolState([{ addr: A, connect: 0 }]).cls, 'rxd-warmup-pill');
check('all slots given up is still Disconnected',
    rxdPoolState([{ addr: A, connect: -1 }, { addr: A, connect: -1 }]).text, 'Disconnected');
check('Disconnected stays red',
    rxdPoolState([{ addr: A, connect: -1 }]).cls, 'content2radiusRedcss');
check('connected wins over a second slot still dialling',
    rxdPoolState([{ addr: A, connect: 0 }, { addr: A, connect: 1 }]).text, 'Connected');
check('no pools configured at all',
    rxdPoolState([]).text, '--');
check('empty slots do not count as failures',
    rxdPoolState([{ addr: '', connect: -1 }, { addr: '', connect: -1 }]).text, '--');
check('missing payload', rxdPoolState(undefined).text, '--');
check('string connect values, as the JSON sometimes carries',
    rxdPoolState([{ addr: A, connect: '0' }]).text, 'Connecting');
check('the title names the pool being dialled',
    rxdPoolState([{ addr: A, connect: 0 }]).title,
    'Opening the connection to ' + A);

console.log('');
if (failures) {
    console.log(`${failures} failed`);
    process.exit(1);
}
console.log('all passed');
