// Check rxdStripStockFanControls: the stock fan row goes away, but the form
// still carries everything the Mode save needs.
//
// The trap this guards is not cosmetic. machine_save_fansetting() serializes
// the WHOLE of #form1 and appends post=3, and the backend then builds
//
//     {"id":"sethw", "fan":{"control":%s, "ratio":%s}, "mode":"%s"}
//
// substituting ratio with %s straight from the form. So deleting the fanratio
// input - the obvious way to "remove the fan settings" - makes saving a work
// mode send `"ratio":` and produce malformed JSON. Hiding keeps the field.
//
// No jsdom or jQuery here, as in test_nav.js: $ is stubbed just far enough to
// model the handful of calls the function makes against the real machine.esp
// shape, because the logic is what matters.

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

// --- a model of the real machine.esp fragment -------------------------------
// <div class="machine_bottom">
//   <div class="top lan-trans">Hardware Configuration</div>
//   <div class="bottom">
//     <div> [fancontrol] [fanratio] </div><br/>
//     <div> [fanmode] </div>
//   </div>
// </div>
function build() {
    const node = (tag, cls) => ({
        tag, cls: new Set(cls ? cls.split(' ') : []),
        kids: [], parent: null, visible: true, text: null, data: {}
    });
    const add = (p, c) => { c.parent = p; p.kids.push(c); return c; };

    const section = node('div', 'machine_bottom');
    const head = add(section, node('div', 'top lan-trans'));
    head.text = 'Hardware Configuration';
    const bottom = add(section, node('div', 'bottom'));
    const fanRow = add(bottom, node('div'));
    const control = add(fanRow, node('input'));
    control.name = 'fancontrol';
    const ratio = add(fanRow, node('input'));
    ratio.name = 'fanratio';
    ratio.value = '25';
    const br = add(bottom, node('br'));
    const modeRow = add(bottom, node('div'));
    const mode = add(modeRow, node('select'));
    mode.name = 'fanmode';

    return { section, head, bottom, fanRow, control, ratio, br, modeRow, mode };
}

let dom;

function wrap(nodes) {
    const list = [].concat(nodes);
    const api = {
        length: list.length,
        // jQuery binds `this` to the raw element, not a wrapper, which is why
        // the function under test says $(this).
        each(fn) { list.forEach(n => fn.call(n)); return api; },
        hide() { list.forEach(n => { n.visible = false; }); return api; },
        removeClass(c) { list.forEach(n => n.cls.delete(c)); return api; },
        text(t) {
            if (t === undefined) return list.length ? list[0].text : '';
            list.forEach(n => { n.text = t; });
            return api;
        },
        first() { return wrap(list.slice(0, 1)); },
        find(sel) {
            const out = [];
            const walk = n => {
                n.kids.forEach(k => { if (matches(k, sel)) out.push(k); walk(k); });
            };
            list.forEach(walk);
            return wrap(out);
        },
        closest(sel) {
            const out = [];
            list.forEach(n => {
                for (let p = n.parent; p; p = p.parent) {
                    if (matches(p, sel)) { out.push(p); break; }
                }
            });
            return wrap(out);
        },
        next(sel) {
            const out = [];
            list.forEach(n => {
                if (!n.parent) return;
                const i = n.parent.kids.indexOf(n);
                const sib = n.parent.kids[i + 1];
                if (sib && matches(sib, sel)) out.push(sib);
            });
            return wrap(out);
        },
        data(k, v) {
            if (v === undefined) return list.length ? list[0].data[k] : undefined;
            list.forEach(n => { n.data[k] = v; });
            return api;
        }
    };
    return api;
}



function matches(n, sel) {
    if (!sel) return false;
    const m = /^input\[name=(\w+)\]$/.exec(sel);
    if (m) return n.tag === 'input' && n.name === m[1];
    if (sel.charAt(0) === '.') return n.cls.has(sel.slice(1));
    return n.tag === sel;
}

// The function falls back to `document` when called with no root.
global.document = { stub: true };

global.$ = function (arg) {
    if (arg && arg.tag) return wrap([arg]);
    return wrap([dom.section]);
};

eval(extract('rxdStripStockFanControls'));

let fail = 0;
function check(label, ok, detail) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
    if (!ok) fail++;
}

// --- first pass --------------------------------------------------------------
dom = build();
rxdStripStockFanControls();

check('the fan speed row is hidden', dom.fanRow.visible === false);
check('its trailing <br/> is hidden too', dom.br.visible === false);
check('the work mode row is left alone', dom.modeRow.visible === true);
check('the mode select survives', dom.mode.name === 'fanmode');

// The whole point: these must still be in the form for post=3.
check('fanratio is still present', dom.ratio.name === 'fanratio');
check('fanratio keeps its live value', dom.ratio.value === '25');
check('fancontrol is still present', dom.control.name === 'fancontrol');

check('heading relabelled', dom.head.text === 'Work Mode', dom.head.text);
check('lan-trans dropped so translate.js cannot undo it',
      dom.head.cls.has('lan-trans') === false);

// --- idempotence -------------------------------------------------------------
// The view is re-injected on every visit and the observer fires repeatedly, so
// a second pass over the same nodes must be a no-op rather than, say,
// relabelling an already-relabelled heading.
dom.head.text = 'Work Mode';
rxdStripStockFanControls();
check('second pass marks nothing new', dom.ratio.data.rxdStripped === true);
check('second pass leaves the heading alone', dom.head.text === 'Work Mode');

// --- a fresh fragment ---------------------------------------------------------
// Each newly injected copy must be stripped on its own.
const first = dom;
dom = build();
rxdStripStockFanControls();
check('a freshly injected view is stripped too', dom.fanRow.visible === false);
check('the earlier fragment is untouched by it', first.fanRow.visible === false);

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
