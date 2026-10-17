// The Log Download table.
//
// The stock tab offers exactly two files and both come from internal flash:
// its backend copies /var/order/{run,his}.log into the web root and links to
// the copies. So it cannot show run.log for any boot but this one, cannot show
// the four daemon logs that tmpfs destroys at every reboot, and cannot show the
// chip log the charts are drawn from. This table is what makes those reachable.
//
// What is worth testing is that it fails quietly and tells the truth about
// WHERE a file came from. "SD card" versus "Internal flash" is the only column
// that matters in a bad moment: it is the difference between a log that
// survived the reboot you are investigating and one that did not. A table that
// quietly labelled a flash copy as the card's would send someone looking for
// history that was never written.
//
// No jsdom or jQuery, as in test_about.js: the pure builders are exercised
// directly.

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

// The URL constants are built from location at load time; the table only needs
// them to be strings.
global.RXD_LOGFILE_URL = 'http://miner:4112/logfile?name=';
const RXD_LOG_MARK = 'rxd-log-table';
global.RXD_LOG_MARK = RXD_LOG_MARK;

eval(extract('rxdFanEscape'));
eval(extract('rxdAboutStamp'));
eval(extract('rxdLogSize'));
eval(extract('rxdLogStore'));
eval(extract('rxdLogRow'));
eval(extract('rxdRenderLogs'));

let fail = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
        (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

console.log('rxdLogSize: a size a person can read at a glance');
check('bytes stay bytes', rxdLogSize(900), '900 B');
check('KB once it is worth it', rxdLogSize(2048), '2.0 KB');
check('MB for the big ones', rxdLogSize(2130405), '2.03 MB');
check('zero is a size, not a gap', rxdLogSize(0), '0 B');
check('a missing size is a dash', rxdLogSize(undefined), '-');
check('so is a nonsense one', rxdLogSize(-5), '-');
check('a string size is not formatted as a number', rxdLogSize('900'), '-');

console.log('');
console.log('rxdLogRow: where the file actually lives');
const card = rxdLogRow({ name: 'his.log', label: 'Miner history.',
                         source: 'card', bytes: 2130405, modified: 1792234814000 });
check('the card is named as the card', card.indexOf('SD card') > -1, true);
check('and not as flash', card.indexOf('Internal flash'), -1);
check('the name is the download link',
      card.indexOf('href="http://miner:4112/logfile?name=his.log" download') > -1,
      true);
check('the size is rendered', card.indexOf('2.03 MB') > -1, true);

const flash = rxdLogRow({ name: 'run.log', label: 'Miner log.',
                          source: 'nand', bytes: 100, modified: 1792234814000 });
check('anything not the card reads as flash',
      flash.indexOf('Internal flash') > -1, true);
check('and never claims the card', flash.indexOf('SD card'), -1);

// THREE stores, not two. /var/log is a symlink into /var/volatile, which is
// tmpfs: those four logs are in RAM and are gone at the next boot. Calling
// them "internal flash" is wrong about the one thing this column answers.
check('a tmpfs log says so', rxdLogStore('ram'), 'RAM, until reboot');
check('and does not claim flash', rxdLogStore('ram').indexOf('flash'), -1);
check('jffs2 is flash', rxdLogStore('nand'), 'Internal flash');
check('the card is the card', rxdLogStore('card'), 'SD card');

// An unknown source must not silently read as "SD card" - that is the
// mislabelling that would send someone hunting for history that is not there.
const odd = rxdLogRow({ name: 'x.log', source: 'elsewhere', bytes: 1 });
check('an unrecognised source falls back to flash, not the card',
      odd.indexOf('SD card'), -1);

check('a row with no name is dropped', rxdLogRow({ source: 'card' }), '');
check('so is nothing at all', rxdLogRow(null), '');
check('a missing timestamp prints a dash, not "null"',
      rxdLogRow({ name: 'a.log', source: 'card', bytes: 1 }).indexOf('<td>-</td>') > -1,
      true);

console.log('');
console.log('rxdLogRow: nothing from the bridge reaches the HTML unescaped');
const nasty = rxdLogRow({ name: '<img src=x onerror=alert(1)>',
                          label: '</td><script>alert(2)</script>',
                          source: 'card', bytes: 1, modified: 1 });
check('the name is escaped', nasty.indexOf('<img'), -1);
check('the label is escaped', nasty.indexOf('<script>'), -1);
check('and the escaped text is still there',
      nasty.indexOf('&lt;img') > -1, true);

console.log('');
console.log('rxdRenderLogs: an empty answer paints nothing');
check('no logs, no table', rxdRenderLogs({ logs: [] }), '');
check('no payload, no table', rxdRenderLogs(null), '');
check('logs that all fail to render produce no table',
      rxdRenderLogs({ logs: [null, {}] }), '');

console.log('');
console.log('rxdRenderLogs: the note tells you what you are looking at');
const withCard = rxdRenderLogs({ card: true, logs: [
    { name: 'run.log', source: 'card', bytes: 10, modified: 1 }] });
check('it is marked so it can be found and replaced',
      withCard.indexOf(RXD_LOG_MARK) > -1, true);
check('with a card, the note says these go back further',
      withCard.indexOf('go back further') > -1, true);
check('and mentions the two stock links above it',
      withCard.indexOf('the two above') > -1, true);

const noCard = rxdRenderLogs({ card: false, logs: [
    { name: 'run.log', source: 'nand', bytes: 10, modified: 1 }] });
check('with no card, it says so plainly',
      noCard.indexOf('No SD card is mounted') > -1, true);
check('and admits it covers this boot only',
      noCard.indexOf('this boot only') > -1, true);
check('it does not promise history it does not have',
      noCard.indexOf('go back further'), -1);

console.log('');
console.log('the markup only asks for classes that are actually styled');
// This is why the table first rendered with no cell padding at all, running
// "Stored on" into "Size": it asked for .rxd-about-table, which does not
// exist. The About page's rules are scoped to .rxd-about.
const css = fs.readFileSync(
    path.join(__dirname, '..', 'webui', 'css', 'radiant.css'), 'utf8');
const sample = rxdRenderLogs({ card: true, logs: [
    { name: 'run.log', label: 'Miner log.', source: 'card',
      bytes: 54061, modified: 1792235364000 }] });
const classes = (sample.match(/class="([^"]+)"/g) || [])
    .map(s => s.slice(7, -1).split(/\s+/)).reduce((a, b) => a.concat(b), []);
for (const name of classes) {
    check(`.${name} is defined in radiant.css`,
          css.indexOf('.' + name) > -1, true);
}
check('the table itself is styled through the marker',
      css.indexOf('.' + RXD_LOG_MARK + ' table') > -1, true);
check('its cells get padding', /\.rxd-log-table th,\s*\n\s*\.rxd-log-table td \{[^}]*padding/.test(css), true);

console.log('');
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
