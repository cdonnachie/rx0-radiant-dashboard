// The panels added to the bridge's own page: Fan, Clock, Logs, Swarm, About.
//
// Four behaviours are pinned here, each because getting it wrong produces a
// page that looks right and is not:
//
//   * The Clock tab must not exist on a miner without overclocking enabled.
//     The bridge answers 503 to /setclock there, and a control that cannot
//     work is worse than no control - this one reboots the machine.
//   * The fan form must report what the device STORED, not what was typed.
//     write_fan_config clamps instead of refusing, so a silent accept would
//     leave the page showing a setting the miner is not running.
//   * zip() must drop nulls rather than plotting them. /chiphistory answers in
//     parallel arrays with holes where a sample is missing, and a null read as
//     zero is a temperature chart that dives to the axis.
//   * A subnet scan must not edit the peer list by itself.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'device', 'web', 'app.js');
const src = fs.readFileSync(SRC, 'utf8');
const HTML = fs.readFileSync(
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

let failures = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
        (ok ? '' : `   got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

console.log('=== every page in PAGES has a section to show');
// This catches the one-line mistake the PAGES array invites: adding an entry
// and forgetting the markup, which gives a nav tab that switches to nothing.
// The regex also picks up the 'clock' entry spliced in at runtime.
const pageIds = [...new Set(
    [...src.matchAll(/\{ id: '([a-z]+)', label:/g)].map(m => m[1]))];
pageIds.forEach(id => {
    check(`page-${id} exists in index.html`,
        HTML.includes(`id="page-${id}"`), true);
});
check('clock is one of them', pageIds.includes('clock'), true);

console.log('');
console.log('=== the Clock page appears only where overclocking is enabled');
const maybeAdd = extract('maybeAddClockPage');
// Stub just enough for the function: a PAGES array, a nav builder and a
// re-show. The logic is the subject here, not the DOM.
// The function reads and writes a module-level `clockPageAdded`, so it has to
// be evaluated inside a scope that owns that variable. Building the scope as
// one source blob and handing back an API is the only way to let the closure
// keep working the way it does in the page.
function runGate(about, startPages, calls) {
    const build = new Function(`
        var PAGES = arguments[0];
        var navBuilds = 0;
        var clockPageAdded = false;
        var currentPage = { id: 'overview' };
        function buildNav() { navBuilds++; }
        function showPage() {}
        function showClock() {}
        ${maybeAdd}
        return {
            run: maybeAddClockPage,
            ids: function() { return PAGES.map(function(p) { return p.id; }); },
            navBuilds: function() { return navBuilds; }
        };
    `);
    const api = build(startPages.slice());
    (calls || [about]).forEach(a => api.run(a));
    return { ids: api.ids(), navBuilds: api.navBuilds() };
}

const base = [{ id: 'overview' }, { id: 'fan' }, { id: 'about' }];
check('not added when overclocking is off',
    runGate({ overclockEnabled: false }, base).ids, ['overview', 'fan', 'about']);
check('not added when /about failed entirely',
    runGate(null, base).ids, ['overview', 'fan', 'about']);
check('added before About when enabled',
    runGate({ overclockEnabled: true }, base).ids,
    ['overview', 'fan', 'clock', 'about']);
// /about is fetched every ten seconds, so this runs every ten seconds. Adding
// the tab once per tick would give a nav that grows forever.
const repeated = runGate(null, base, [
    { overclockEnabled: true }, { overclockEnabled: true }, { overclockEnabled: true }
]);
check('ten ticks later it is still added exactly once',
    repeated.ids, ['overview', 'fan', 'clock', 'about']);
check('and the nav was rebuilt only once', repeated.navBuilds, 1);

console.log('');
console.log('=== zip drops holes rather than plotting them as zero');
const zip = new Function('return ' + extract('zip').replace('function zip', 'function'))();
check('pairs up normally', zip([1, 2], [10, 20]), [[1, 10], [2, 20]]);
check('a null sample is dropped, not zeroed',
    zip([1, 2, 3], [10, null, 30]), [[1, 10], [3, 30]]);
check('undefined too', zip([1, 2], [10, undefined]), [[1, 10]]);
check('zero is a real reading and survives', zip([1], [0]), [[1, 0]]);
check('ragged arrays stop at the shorter one', zip([1, 2, 3], [10]), [[1, 10]]);
check('missing arrays are empty, not an error', zip(null, null), []);

console.log('');
console.log('=== the fan form reports what the device stored');
// The diff the submit handler builds. Reproduced rather than extracted,
// because it lives inside a promise chain - the rule is what matters.
function changed(asked, stored) {
    return ['mode', 'ratio', 'target', 'minfan', 'maxfan']
        .filter(k => String(asked[k]) !== String(stored[k]))
        .map(k => `${k} ${asked[k]} → ${stored[k]}`);
}
const asked = { mode: 'target', ratio: 25, target: 70, minfan: 25, maxfan: 100 };
check('nothing to say when the device agreed',
    changed(asked, asked), []);
check('a clamped duty is named',
    changed({ ...asked, ratio: 200 }, { ...asked, ratio: 100 }),
    ['ratio 200 → 100']);
check('a clamped target is named',
    changed({ ...asked, target: 10 }, { ...asked, target: 40 }),
    ['target 10 → 40']);
check('several at once',
    changed({ ...asked, minfan: 0, maxfan: 200 },
            { ...asked, minfan: 10, maxfan: 100 }),
    ['minfan 0 → 10', 'maxfan 200 → 100']);
// The device echoes strings for some fields and numbers for others, and a
// type difference is not a change the user did anything about.
check('25 and "25" are not a change',
    changed({ ...asked, ratio: 25 }, { ...asked, ratio: '25' }), []);

console.log('');
console.log('=== a subnet scan reports, it does not join miners to the swarm');
const scanSrc = extract('scanSubnet');
check('scan never POSTs to /peers', scanSrc.includes("'/peers'"), false);
check('scan never assigns peerList', /peerList\s*=/.test(scanSrc), false);
check('scan does say to add them by hand',
    scanSrc.includes('add the ones you want'), true);

console.log('');
console.log('=== a renamed peer cannot corrupt rxd_peers.conf');
// The conf is "<host>  <name>", read back with split(None, 1). So spaces are
// fine, but '#' starts a comment and a newline would inject a line.
const tidyName = new Function('return ' + extract('tidyPeerName')
    .replace('function tidyPeerName', 'function'))();
check('an ordinary name is kept', tidyName('shed miner'), 'shed miner');
check('spaces survive, because split(None, 1) keeps them',
    tidyName('RX0 number two'), 'RX0 number two');
check('a hash is removed, not left to truncate the name',
    tidyName('shed #2'), 'shed 2');
check('a newline cannot inject a second peer line',
    tidyName('evil\n10.0.0.99 pwned'), 'evil 10.0.0.99 pwned');
check('a carriage return either', tidyName('a\r\nb'), 'a b');
check('tabs and other control characters collapse', tidyName('a\tb'), 'a b');
check('runs of space collapse to one', tidyName('a    b'), 'a b');
check('surrounding space is trimmed', tidyName('  shed  '), 'shed');
check('empty stays empty - it means "show the address"', tidyName(''), '');
check('null does not throw', tidyName(null), '');

console.log('');
console.log('=== the scan prefix is normalised before the device sees it');
// Found by using it: the bridge wants exactly three octets and answers
// "prefix must look like 10.0.0" to anything else, and typing the trailing dot
// after the third octet is the natural thing to do.
const tidy = new Function('return ' + extract('tidyPrefix')
    .replace('function tidyPrefix', 'function'))();
check('a trailing dot is removed', tidy('10.0.0.'), '10.0.0');
check('several are', tidy('10.0.0..'), '10.0.0');
check('surrounding space too', tidy('  192.168.1.  '), '192.168.1');
check('a clean prefix is untouched', tidy('10.0.0'), '10.0.0');
check('empty stays empty', tidy(''), '');
check('null does not throw', tidy(null), '');

const dflt = new Function('location', 'return ' + extract('defaultPrefix')
    .replace('function defaultPrefix', 'function') + '()');
check('the /24 is taken from the host the page loaded over',
    dflt({ hostname: '10.0.0.212' }), '10.0.0');
check('a hostname gives nothing rather than a guess',
    dflt({ hostname: 'miner.local' }), '');

console.log('');
console.log('=== the clock control is two-step and never uses a modal dialog');
const submitClock = extract('submitClock');
check('arms before writing', submitClock.includes('if (!clockArmed)'), true);
check('the armed button says it reboots',
    submitClock.includes('REBOOTS the miner'), true);
check('refuses a no-op change',
    submitClock.includes('already set to'), true);
// A modal blocks the page and, with the browser extension driving it, the
// whole session. The confirmation is in the button instead.
check('no confirm() anywhere in the page',
    /[^.\w]confirm\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false);

console.log('');
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
