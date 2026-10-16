// Check rxdNavSelect: exactly one of our three nav items may be current.
//
// The reported bug was that going Swarm -> Fan left BOTH highlighted, because
// the old code cleared the highlight pairwise and Fan's handler only knew
// about Overclock. There is no jsdom or jQuery here, so $ is stubbed narrowly:
// it understands the two selector shapes this function uses and records class
// changes against a map of item -> set of classes. That is enough to test the
// logic, which is where the bug was - not the DOM.

const fs = require('fs');

const path = require('path');
// Relative to this file, so the suite runs from any checkout.
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

const ITEMS = ['rxdOcMenu', 'rxdFanMenu', 'rxdSwarmMenu'];
let state = {};
function reset() { ITEMS.forEach(k => { state[k] = new Set(); }); }
reset();

// Minimal jQuery: a selector is one or more comma-separated ".left .thing".
global.$ = function (selector) {
    const names = selector.split(',')
        .map(s => s.trim().split(/\s+/).pop().replace(/^\./, ''))
        .filter(n => ITEMS.indexOf(n) >= 0);
    return {
        removeClass(c) { names.forEach(n => state[n].delete(c)); return this; },
        addClass(c) { names.forEach(n => state[n].add(c)); return this; }
    };
};

eval((src.match(/^var RXD_NAV_ITEMS = .*$/m) || [])[0]);
eval(extract('rxdNavSelect'));

const ACTIVE = 'menucssStatus';
const current = () => ITEMS.filter(n => state[n].has(ACTIVE));

let fail = 0;
function check(label, ok, detail) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
    if (!ok) fail++;
}

// The selector constant must name all three, or the clear silently misses one.
ITEMS.forEach(n => check('RXD_NAV_ITEMS covers ' + n,
                         RXD_NAV_ITEMS.indexOf(n) >= 0));

rxdNavSelect('rxdOcMenu');
check('Overclock alone after selecting it',
      JSON.stringify(current()) === JSON.stringify(['rxdOcMenu']), current());

// The reported bug, in order: Swarm then Fan.
rxdNavSelect('rxdSwarmMenu');
check('Swarm alone after selecting it',
      JSON.stringify(current()) === JSON.stringify(['rxdSwarmMenu']), current());
rxdNavSelect('rxdFanMenu');
check('Swarm -> Fan leaves ONLY Fan (the reported bug)',
      JSON.stringify(current()) === JSON.stringify(['rxdFanMenu']), current());

// Every other ordering, so no pair is special again.
for (const from of ITEMS) {
    for (const to of ITEMS) {
        rxdNavSelect(from);
        rxdNavSelect(to);
        check(from + ' -> ' + to + ' leaves only ' + to,
              JSON.stringify(current()) === JSON.stringify([to]), current());
    }
}

// A stock page clears all of ours.
rxdNavSelect('rxdSwarmMenu');
rxdNavSelect(null);
check('null clears every one of ours', current().length === 0, current());

// Idempotent: selecting the current page twice must not leave it doubled or
// cleared.
rxdNavSelect('rxdFanMenu');
rxdNavSelect('rxdFanMenu');
check('selecting the same page twice is stable',
      JSON.stringify(current()) === JSON.stringify(['rxdFanMenu']), current());

process.exit(fail ? 1 : 0);
