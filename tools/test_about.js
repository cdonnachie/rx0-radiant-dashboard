// The About page renderer.
//
// It exists because the charts are the wrong shape for two kinds of fact: ones
// that never change, and ones that should never change. The Zynq's internal
// rails are the second kind - ten consecutive XADC samples of VCCINT spanned
// 10 mV of converter noise and nothing the operator controls moves them, so a
// trace would plot the ADC and teach you to ignore the dashboard.
//
// What is actually worth testing here is that the page degrades honestly. It
// reads a diagnostic endpoint whose every field can be absent - an unreadable
// sysfs node, a miner that would not answer, a model whose EEPROM lists no
// boards - and a page that prints "undefined V" or silently drops a failed
// rail is worse than one that says nothing. So: missing fields vanish, a rail
// outside its band is marked, and nothing user-supplied reaches the HTML
// unescaped.
//
// No jsdom or jQuery, as in test_fanstrip.js: $ is stubbed to capture the one
// html() call, and the pure builders are exercised directly.

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

let painted = '';
global.$ = function () {
    return { html(h) { painted = h; return this; } };
};

eval(extract('rxdFanEscape'));
eval(extract('rxdAboutRow'));
eval(extract('rxdAboutUptime'));
eval(extract('rxdAboutStamp'));
eval(extract('rxdAboutStore'));
eval(extract('rxdAboutSdRow'));
eval(extract('rxdRenderAbout'));

let fail = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
        (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

console.log('rxdAboutRow: a value that is not there prints no row at all');
check('null', rxdAboutRow('Kernel', null), '');
check('undefined', rxdAboutRow('Kernel', undefined), '');
check('empty string', rxdAboutRow('Kernel', ''), '');
// 0 is a real value - a board at 0 MHz is worth seeing, not hiding.
check('zero is a value, not an absence',
    rxdAboutRow('Clock', 0).indexOf('>0<') > 0, true);
check('a value renders as a row',
    rxdAboutRow('Kernel', 'Linux 4.19'),
    '<tr><th>Kernel</th><td>Linux 4.19</td></tr>');
check('a note is appended, quieter',
    rxdAboutRow('Clock', '775 MHz', 'EEPROM setting'),
    '<tr><th>Clock</th><td>775 MHz <span class="rxd-about-note">EEPROM setting</span></td></tr>');

console.log('');
console.log('rxdAboutUptime: whatever /proc/uptime gave us');
check('minutes only', rxdAboutUptime(600), '10m');
check('hours and minutes', rxdAboutUptime(3660), '1h 1m');
check('days too', rxdAboutUptime(90000), '1d 1h 0m');
check('zero is zero minutes, not blank', rxdAboutUptime(0), '0m');
check('a missing reading is null, so the row disappears',
    rxdAboutUptime(null), null);
check('a string from a malformed /proc read is not formatted',
    rxdAboutUptime('nonsense'), null);

console.log('');
console.log('rxdAboutStamp: the miner is on UTC, the reader is not');
// The bug being prevented: the bridge used to render this itself, on a miner
// whose clock is UTC, so the page showed a time four hours from the reader's
// with nothing saying so - the same mistake that put the chip charts on a
// different timescale from the board charts.
const stamped = rxdAboutStamp(Date.UTC(2026, 9, 17, 0, 51));
check('it formats to a date and time', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamped), true);
// Compared against the same instant through the platform's own clock, so this
// holds in any timezone the suite runs in.
const expect = new Date(Date.UTC(2026, 9, 17, 0, 51));
const pad = (n) => ('0' + n).slice(-2);
check('and it is the VIEWER’s local time, not the miner’s UTC',
    stamped,
    expect.getFullYear() + '-' + pad(expect.getMonth() + 1) + '-' + pad(expect.getDate()) +
    ' ' + pad(expect.getHours()) + ':' + pad(expect.getMinutes()));
check('a legacy bridge’s own string passes through untouched',
    rxdAboutStamp('2026-10-17 00:51'), '2026-10-17 00:51');
check('nothing at all is null, so the row disappears',
    rxdAboutStamp(undefined), null);

console.log('');
console.log('rxdAboutStore');
check('megabytes for the NAND and tmpfs figures',
    rxdAboutStore({ free: 56.4, total: 110 }), '56.4 MB free of 110 MB');
// A 32 GB card in megabytes reads "31983.9 MB free of 31984.0 MB" - digits
// that look like precision and are not.
check('gigabytes once the volume is big enough to deserve them',
    rxdAboutStore({ free: 31983.9, total: 31984.0 }), '31.2 GB free of 31.2 GB');
check('the boundary stays in MB just below 1 GB',
    rxdAboutStore({ free: 500, total: 1023 }), '500 MB free of 1023 MB');
check('and flips at 1024', rxdAboutStore({ free: 512, total: 1024 }),
    '0.5 GB free of 1.0 GB');
check('an unreadable filesystem is null', rxdAboutStore(null), null);
check('a partial reading is null rather than "undefined MB"',
    rxdAboutStore({ free: 5 }), null);

console.log('');
console.log('the whole page, from a payload shaped like the live one');
rxdRenderAbout({
    hardware: [{ label: 'SoC', value: 'Xilinx Zynq XC7Z010', source: 'chip package marking' }],
    model: 'IceRiver RX0 (Radiant / SHA512-256d)',
    firmware: 'ICM168_08_02_1806_10107',
    kernel: 'Linux ICERIVER 4.19.0-xilinx-v2019.2',
    uptimeSeconds: 2249,
    sshPort: 54188,
    bridgeInstalledMs: Date.UTC(2026, 9, 17, 0, 51),
    boards: [{ board: 1, chipcount: 12, pll: 775, volts: 2.0 }],
    fan: { mode: 'target', target: '65', minfan: '25', maxfan: '100' },
    socTemp: 63.8,
    rails: [
        { key: 'vccint', label: 'VCCINT', volts: 0.992, nominal: 1.0, band: 0.05, ok: true },
        { key: 'vccoddr', label: 'VCCO_DDR', volts: 1.62, nominal: 1.5, band: 0.05, ok: false }
    ],
    storage: { root: { free: 56.4, total: 110 }, volatile: { free: 107.1, total: 122.4 } },
    sd: { card: 'SU64G', mount: '/run/media/mmcblk0p1', free: 31983.9, total: 31984.0,
          log: '/run/media/mmcblk0p1/rxd_chips.log' },
    overclockEnabled: true
});

const has = (s) => painted.indexOf(s) >= 0;
check('the hardware fact and where it came from',
    has('Xilinx Zynq XC7Z010') && has('chip package marking'), true);
// These five rows were read off photographs, which is a different kind of
// claim from every live reading below them. The page has to say so, or a
// reader reasonably assumes the firmware reported it.
check('the page says the hardware rows are not from the miner',
    has('Read off photographs of the board'), true);

// The reported problem: the provenance note said "the rows above" while the
// table above it held live readings too - Firmware, Uptime, SSH. The note is
// only true if it sits under a table containing NOTHING but the photographed
// rows, so the ordering is the assertion.
const at = (s) => painted.indexOf(s);
check('Hardware is its own section', at('<h4>Hardware</h4>') >= 0, true);
check('System is its own section', at('<h4>System</h4>') >= 0, true);
check('the note falls after the hardware table',
    at('Read off photographs') > at('<h4>Hardware</h4>'), true);
check('and before the System rows, so "else on this page" is true',
    at('Read off photographs') < at('<h4>System</h4>'), true);
check('no live reading sits inside the hardware table',
    at('Firmware') > at('<h4>System</h4>'), true);
check('nor does uptime', at('Uptime') > at('<h4>System</h4>'), true);
check('the model is a System row, not a photographed one',
    at('Model') > at('<h4>System</h4>'), true);
check('a mounted card names itself and shows its space',
    has('SU64G') && has('31.2 GB free of 31.2 GB'), true);
check('and where it is mounted', has('/run/media/mmcblk0p1'), true);
check('history is reported as going to the card, uncapped',
    has('on the card, uncapped'), true);

// The three card states, which is the whole reason this row exists.
const sdRow = (sd) => rxdAboutSdRow(sd);
check('an empty slot says so', sdRow({ card: null, mount: null }).indexOf('empty') > 0, true);
// The trap: present, enumerated, and unmountable because the kernel has no
// exFAT or NTFS. Calling this "empty" sends you hunting a hardware fault.
const stuck = sdRow({ card: 'SU64G', mount: null });
check('a card that cannot be mounted is NOT reported as empty',
    stuck.indexOf('empty') < 0, true);
check('it names the card and says what is wrong',
    stuck.indexOf('SU64G') > 0 && stuck.indexOf('not mountable') > 0, true);
check('and says what would fix it',
    stuck.indexOf('FAT32 or ext4') > 0, true);
check('a missing sd object does not throw',
    (() => { rxdAboutSdRow(undefined); return 'ok'; })(), 'ok');

check('the install time is labelled local, so no one reads it as miner time',
    has('local time'), true);
check('and it is not the raw epoch', painted.indexOf('1792', at('Bridge installed')) < 0, true);
check('firmware version', has('ICM168_08_02_1806_10107'), true);
check('uptime is formatted, not raw seconds',
    has('37m') && !has('2249'), true);
check('the board clock', has('775 MHz'), true);
check('board voltage is labelled a setting, not a measurement',
    has('EEPROM setting, not measured'), true);
check('target mode shows the target and the fan range',
    has('65 °C') && has('25-100%'), true);
check('the SoC die temperature, tied back to the chart it draws on',
    has('63.8 °C') && has('ambient trace on the chip chart'), true);
check('an in-band rail is marked in band', has('>in band<'), true);
check('an OUT OF BAND rail is called out', has('>OUT OF BAND<'), true);
check('and it uses the fault class, not the caution one',
    has('rxd-about-bad'), true);
check('the rail nominal and tolerance are shown in mV',
    has('nominal 1.50 ±50 mV'), true);
check('VREFP is explained as the self-check it is',
    has('self-check on every XADC reading'), true);
check('tmpfs headroom, with what an upload needs',
    has('107.1 MB free of 122.4 MB') && has('~40 MB'), true);
check('the overclock state is a row like any other',
    has('Overclock page') && has('>enabled<'), true);

// The bug this catches: the overclock row used to be appended AFTER the
// table's closing tag, so it was a <tr> with no table around it. Browsers
// discard a stray row's structure, which rendered as "Overclock pageenabled"
// with the label and value run together - and every substring assertion above
// still passed, because the text was all present. Structure needs a
// structural check.
function rowsOutsideTable(html) {
    const tokens = html.match(/<table[^>]*>|<\/table>|<tr>/g) || [];
    let depth = 0, stray = 0;
    tokens.forEach(t => {
        if (t === '</table>') depth--;
        else if (t === '<tr>') { if (depth <= 0) stray++; }
        else depth++;
    });
    return stray;
}
// Prove the detector can fail, or asserting 0 proves nothing.
check('the detector flags the exact shape the bug had',
    rowsOutsideTable('<table><tr>ok</tr></table><tr><th>Overclock page</th></tr>'), 1);
check('and does not flag a well-formed page',
    rowsOutsideTable('<table class="x"><tr>a</tr><tr>b</tr></table>'), 0);
check('no table row is emitted outside a table', rowsOutsideTable(painted), 0);
check('and every table that opens is closed',
    (painted.match(/<table/g) || []).length,
    (painted.match(/<\/table>/g) || []).length);

console.log('');
console.log('a payload where almost everything failed to read');
// Every reader in about() returns None or [] on error, so this is a real
// response, not a hypothetical one.
rxdRenderAbout({ hardware: [], rails: [], boards: [], fan: {},
                 firmware: null, kernel: null, uptimeSeconds: null, socTemp: null,
                 storage: {} });
check('it still renders the card', has('About this miner'), true);
check('no "null" leaks into the page', painted.indexOf('null') < 0, true);
check('no "undefined" either', painted.indexOf('undefined') < 0, true);
check('no NaN from a missing number', painted.indexOf('NaN') < 0, true);
check('empty sections are omitted, not drawn empty',
    painted.indexOf('Hash board') < 0 && painted.indexOf('Cooling') < 0, true);
check('an empty payload object does not throw',
    (() => { rxdRenderAbout({}); return 'ok'; })(), 'ok');
check('no payload at all does not throw',
    (() => { rxdRenderAbout(undefined); return 'ok'; })(), 'ok');

console.log('');
console.log('storage readable but the slot empty - the row must still appear');
rxdRenderAbout({
    storage: { root: { free: 56.4, total: 110 }, volatile: { free: 107.1, total: 122.4 } },
    sd: { card: null, mount: null, log: '/var/order/rxd_chips.log' },
    hardware: [], rails: [], boards: [], fan: {}
});
check('the Storage section renders', has('<h4>Storage</h4>'), true);
check('and says the slot is empty', has('empty'), true);
check('history is reported as staying on NAND, with the cap named',
    has('/var/order/rxd_chips.log') && has('capped at ~2 weeks'), true);
check('no stray row outside a table in this shape either',
    rowsOutsideTable(painted), 0);

console.log('');
console.log('nothing from the device reaches the page unescaped');
// The firmware string is a filename off the miner's own filesystem, and the
// fan config is a file anyone with SSH can edit by hand.
rxdRenderAbout({
    firmware: '<img src=x onerror=alert(1)>',
    fan: { mode: 'fixed', ratio: '"><script>alert(1)</script>' },
    hardware: [{ label: '<b>L</b>', value: '<b>V</b>', source: '<b>S</b>' }],
    rails: [], boards: [], storage: {}
});
check('no live script tag survives', painted.indexOf('<script>') < 0, true);
check('no live img tag survives', painted.indexOf('<img') < 0, true);
check('it was escaped rather than stripped', has('&lt;img'), true);
check('a label is escaped too', has('&lt;b&gt;L&lt;/b&gt;'), true);

console.log('');
if (fail) {
    console.log(`${fail} failed`);
    process.exit(1);
}
console.log('all passed');
