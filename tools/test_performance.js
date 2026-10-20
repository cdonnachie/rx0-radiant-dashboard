// The Output pill, and the one way it can mislead.
//
// `percent` is actual over expected, and expected scales with the clock. On a
// board whose hashrate has plateaued, LOWERING the clock therefore raises the
// percentage while the machine does less work. We watched exactly that on a
// second RX0: 101.1% at 650 MHz and 95.7% at 675 for the same ~282 GH/s. Anyone
// reading the pill alone would have taken the slower setting for the better one.
//
// So this pins the thing that makes it readable: the absolute GH/s and the
// clock it was measured at sit BESIDE the pill, not behind its tooltip, and the
// averaging window is named because rtpow is a five-minute trailing average
// rather than an instantaneous figure.

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

// The window table is a top-level var, not a function.
const table = src.match(/var RXD_PERF_WINDOWS = \{[^}]*\};/);
if (!table) throw new Error('no RXD_PERF_WINDOWS');
eval(table[0]);
eval(extract('rxdPerfSummary'));
eval(extract('rxdPerfTitle'));

let failures = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
        (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

// Real readings, not invented ones. This board's own, and the second RX0's.
const ours = { actual: 323, percent: 96.5, mhz: 775, expected: 334.8,
    cores: 144, hashesPerCoreCycle: 3, window: '5min', windowSeconds: 300 };
const at650 = { actual: 284, percent: 101.1, mhz: 650, expected: 280.8,
    cores: 144, hashesPerCoreCycle: 3, window: '5min', windowSeconds: 300 };
const at675 = { actual: 279, percent: 95.7, mhz: 675, expected: 291.6,
    cores: 144, hashesPerCoreCycle: 3, window: '5min', windowSeconds: 300 };
const at700 = { actual: 248, percent: 82.0, mhz: 700, expected: 302.4,
    cores: 144, hashesPerCoreCycle: 3, window: '5min', windowSeconds: 300 };

console.log('the line beside the pill carries what the pill cannot');
check('the absolute figure is there', /\b323 GH\/s\b/.test(rxdPerfSummary(ours)), true);
check('so is the clock it was measured at', /\b775 MHz\b/.test(rxdPerfSummary(ours)), true);
check('and the averaging window', /5 min avg/.test(rxdPerfSummary(ours)), true);
check('the whole line', rxdPerfSummary(ours), '323 GH/s at 775 MHz · 5 min avg');

console.log('');
console.log('the trap: a lower clock scores better while doing less work');
check('650 really does outscore 675 on the pill', at650.percent > at675.percent, true);
check('though the hashrates are a wash', Math.abs(at650.actual - at675.actual) < 6, true);
// Which is only safe to show because both lines name their clock.
check('650 names its clock', /650 MHz/.test(rxdPerfSummary(at650)), true);
check('675 names its clock', /675 MHz/.test(rxdPerfSummary(at675)), true);
check('and each carries its own GH/s',
    [rxdPerfSummary(at650).slice(0, 10), rxdPerfSummary(at675).slice(0, 10)],
    ['284 GH/s a', '279 GH/s a']);

console.log('');
console.log('a failing clock drops both numbers together - the rejection signal');
check('the percentage falls', at700.percent < at675.percent, true);
check('and so does the hashrate', at700.actual < at675.actual, true);
check('which the line shows', rxdPerfSummary(at700),
    '248 GH/s at 700 MHz · 5 min avg');

console.log('');
console.log('the tooltip warns about the scaling instead of denying it');
const title = rxdPerfTitle(ours);
check('it says expected scales with the clock', /scales with the clock/.test(title), true);
check('it sends you to the GH/s to choose', /GH\/s beside it/.test(title), true);
check('it admits the constant is inferred', /inferred from measurement/.test(title), true);
// The old wording claimed the figure was a datasheet-grade constant that made
// the percentage comparable between miners. Measuring 101.1% disproved it.
check('it no longer calls the constant fixed firmware',
    /fixed firmware constant/.test(title), false);
check('nor promises comparability between miners',
    /comparable between miners/.test(title), false);
check('it still explains dead cores', /Dead cores/.test(title), true);

console.log('');
console.log('nothing to say is said as nothing, not as a wrong number');
check('no payload at all', rxdPerfSummary(null), '');
check('a payload with no percentage', rxdPerfSummary(
    { actual: null, percent: null, mhz: null, window: null }), '');
check('and the tooltip says why', rxdPerfTitle(null), 'Not enough information yet');

console.log('');
console.log('an unknown window is omitted rather than guessed');
const odd = Object.assign({}, ours, { window: 'hourly' });
check('no averaging claim is made', /avg/.test(rxdPerfSummary(odd)), false);
check('but the reading survives', rxdPerfSummary(odd), '323 GH/s at 775 MHz');
const noClock = Object.assign({}, ours, { mhz: null });
check('a missing clock drops its phrase', rxdPerfSummary(noClock),
    '323 GH/s · 5 min avg');

console.log('');
console.log('the window table matches the bridge');
const bridge = fs.readFileSync(
    path.join(__dirname, '..', 'device', 'rxd_bridge.py'), 'utf8');
const pyTable = bridge.match(/HASHRATE_WINDOWS = \{([^}]*)\}/);
check('the bridge defines one', pyTable !== null, true);
const pyKeys = (pyTable ? pyTable[1].match(/'([^']+)'/g) || [] : [])
    .map(s => s.replace(/'/g, ''));
check('and every label it can send has wording here',
    pyKeys.filter(k => !(k in RXD_PERF_WINDOWS)), []);

console.log('');
console.log('the 30-minute tile is marked only while its window is filling');
// The miner's 30-minute average refills linearly from zero after a restart, so
// a bare reading at 12 minutes understates by 12/30 and looks like slow
// silicon. These are the three edges of the predicate that decides the mark.
eval(extract('rxdRuntimeSeconds'));
const halfHour = src.match(/var RXD_HALFHOUR_SECONDS = [^;]*;/);
check('the threshold is defined', halfHour !== null, true);
eval(halfHour[0]);
const filling = r => {
    const e = rxdRuntimeSeconds(r);
    return e > 0 && e < RXD_HALFHOUR_SECONDS;
};
check('thirty minutes is 1800 s', RXD_HALFHOUR_SECONDS, 1800);
check('the reported 12m04s is still filling', filling('00:00:12:04'), true);
check('one second short still is', filling('00:00:29:59'), true);
check('exactly thirty minutes is not', filling('00:00:30:00'), false);
check('nor is a long run', filling('00:03:14:00'), false);
// 0 means "unparseable", not "just booted" - marking then would be a guess.
check('unparseable uptime is not marked', filling('nonsense'), false);
check('nor is a missing one', filling(undefined), false);

console.log('');
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
