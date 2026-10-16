// The swarm row's two-line miner cell.
//
// The second line exists to say which address a NAMED miner sits at. When no
// name was given the first line already IS the address, and printing it again
// renders the address twice, stacked, which reads like two different fields
// rather than one fallback - the obvious guess being that one of them is a
// DNS name. It is not; it is the same string.
//
// Also pins the blank-cell rule for stock peers, which is the other thing in
// this row that looks like a bug and is not: the stock payload's chip count
// and clock are wrong on an RX0 (18 chips against 12, 875 MHz against 775), so
// the bridge sends null and the cell stays "--".

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

eval(extract('rxdFanEscape'));
eval(extract('rxdSwarmUptime'));
eval(extract('rxdSwarmRow'));

let failures = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
        (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}
// How many times the host string appears in the FIRST cell - the miner cell,
// which runs from the opening <td> to the first </td>. The Remove button at
// the far end of the row carries the host too, so counting the whole row
// would always be one too many.
function hostCount(html, host) {
    const open = html.indexOf('<td>');
    const cell = html.slice(open, html.indexOf('</td>', open));
    return cell.split(host).length - 1;
}

const HOST = '192.0.2.7';
const base = { host: HOST, alive: true, hashrate: 310, chips: 12, mhz: 790,
    tempMax: 66, fanRatio: 25, fanRpm: 1206, accepted: 80, uptime: 960 };

console.log('an unnamed miner shows its address once, not twice');
const anon = rxdSwarmRow(base);
check('address appears exactly once in the miner cell', hostCount(anon, HOST), 1);
check('no second-line element at all', anon.indexOf('rxd-swarm-host'), -1);

console.log('');
console.log('a named miner keeps the address underneath');
const named = rxdSwarmRow(Object.assign({}, base, { name: 'shed-1' }));
check('the name is shown', named.indexOf('shed-1') > -1, true);
check('the address is shown too', hostCount(named, HOST), 1);
check('and it is on the second line', named.indexOf('rxd-swarm-host') > -1, true);

console.log('');
console.log('a name that is just the address is not worth repeating');
const sameName = rxdSwarmRow(Object.assign({}, base, { name: HOST }));
check('still only once', hostCount(sameName, HOST), 1);
check('no second line', sameName.indexOf('rxd-swarm-host'), -1);

console.log('');
console.log('the rest of the row is untouched');
check('alive dot', anon.indexOf('rxd-swarm-up') > -1, true);
check('a dead peer gets the other dot',
    rxdSwarmRow(Object.assign({}, base, { alive: false })).indexOf('rxd-swarm-down') > -1, true);
check('hashrate cell', anon.indexOf('<td>310 GH/s</td>') > -1, true);
check('shares with no rejects show the accepted count alone',
    anon.indexOf('<td>80</td>') > -1, true);
check('rejects are appended when there are any',
    rxdSwarmRow(Object.assign({}, base, { rejected: 3 })).indexOf('<td>80 / 3</td>') > -1, true);
check('Remove still carries the host, not the name',
    named.indexOf('data-host="' + HOST + '"') > -1, true);

console.log('');
console.log('every row offers a rename, carrying the current name');
check('unnamed rows have the button', anon.indexOf('rxd-swarm-rename') > -1, true);
check('and it starts empty, so the field is not prefilled with the address',
    anon.indexOf('class="rxd-swarm-rename" data-host="' + HOST + '" data-name=""') > -1,
    true);
check('a named row carries the name to edit',
    named.indexOf('data-name="shed-1"') > -1, true);
check('a name with a quote cannot break out of the attribute',
    rxdSwarmRow(Object.assign({}, base, { name: 'a" onclick="x' }))
        .indexOf('onclick="x'), -1);

console.log('');
console.log('stock peers: junk fields stay blank rather than lying');
const stock = rxdSwarmRow(Object.assign({}, base,
    { stock: true, chips: null, mhz: null }));
check('tagged as stock', stock.indexOf('>stock</span>') > -1, true);
check('chips blank', stock.indexOf('<td>--</td>') > -1, true);
check('no clock claimed', stock.indexOf('MHz') , -1);
check('hashrate is still reported', stock.indexOf('<td>310 GH/s</td>') > -1, true);

console.log('');
console.log('a hostile name cannot inject markup');
const evil = rxdSwarmRow(Object.assign({}, base, { name: '<img src=x onerror=1>' }));
check('escaped', evil.indexOf('<img') , -1);

console.log('');
if (failures) {
    console.log(`${failures} failed`);
    process.exit(1);
}
console.log('all passed');
