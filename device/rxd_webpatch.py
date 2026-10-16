#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Apply the Radiant dashboard to an unpacked IceRiver web root.

Everything the dashboard needs is a text change to plain files: a hook
appended to base.js, a stock bug fixed in index.js, the stock stylesheets
recoloured, and two assets copied in. None of it needs the firmware package
to be rebuilt.

That matters twice over. Repacking a *_bg.bgz needs IceRiver's container
passphrase, which cannot be published; patching the unpacked tree needs
nothing but file access. And a miner patched this way keeps its stock package
untouched, so there is nothing to restore and a firmware update cannot be
half-overwritten - the patch simply reapplies at the next boot.

Two callers, deliberately sharing this one module so the two paths cannot
drift apart:

  * tools/build_custom_bgz.py - applies it to a decrypted package, offline.
  * device/rxdweb            - applies it to /var/volatile/tmp/bg at boot,
                               on the miner, with no passphrase involved.

So this file is written in the subset of Python that 2.7 and 3.x both accept:
the miner ships 2.7.15 and the build host runs 3.x. No f-strings, no pathlib.

Every step is idempotent and checks a marker first, because the boot-time
caller may well run over a tree a previous boot already patched.
"""

import io
import os
import shutil
import sys

# Where the miner unpacks *_bg.bgz at boot. Contains appweb.conf and web/.
DEFAULT_ROOT = '/var/volatile/tmp/bg'
# Where the installer keeps our copies, on jffs2 so they survive a reboot.
DEFAULT_ASSETS = '/var/order/web'

# Light stock value -> Radiant equivalent. Button text stays white (it sits on
# a saturated blue), so `color: white` is deliberately not remapped.
CSS_SUBS = [
    ('background-color: white', 'background-color: #16161A'),
    ('background-color: #e2e2e7', 'background-color: #25252C'),
    ('background-color: #F7F7F7', 'background-color: #1C1C22'),
    ('background-color: #f6f1f7', 'background-color: #1C1C22'),
    ('background-color: #337ab7', 'background-color: #00A8DE'),
    ('border-color: #337ab7', 'border-color: #00A8DE'),
    ('border: 1px solid #e2e2e7', 'border: 1px solid #35353E'),
    ('color:black', 'color:#9A9AA5'),
    ('color: black', 'color: #9A9AA5'),
    ('color: #838587', 'color: #9A9AA5'),
    ('background: #bfc0c3', 'background: #000000'),
    ('color:#337ab7', 'color:#00A8DE'),
    ('color: #337ab7', 'color: #00A8DE'),
    # Toggle switch on Mining Settings: darken the track, keep the knob light
    # (#eeeeee is the thumb and must stay bright to read as raised).
    ('background: #d5d5d5', 'background: #35353E'),
    ('background: #e2e2e2', 'background: #25252C'),
    ('background: #76d26b', 'background: #00A8DE'),
    ('border: 1px solid #ddd', 'border: 1px solid #35353E'),
    ('box-shadow: 0 0 2px #ddd', 'box-shadow: 0 0 2px #000'),
    # Loading overlay: azure is a bright wash across the dark UI.
    ('background-color: azure', 'background-color: rgba(0, 0, 0, 0.72)'),
    ('background-color: rgba(180, 160, 120, .2)',
     'background-color: rgba(0, 242, 242, 0.12)'),
    ('linear-gradient(135deg, #00BFFF 25%,#43be48 0,#43be48 50%,#00BFFF 0,'
     '#00BFFF 75%, #43be48 0)',
     'linear-gradient(135deg, #00F2F2 25%,#00A8DE 0,#00A8DE 50%,#00F2F2 0,'
     '#00F2F2 75%, #00A8DE 0)'),
    # Active log tab. Runs after the gradient rule above, which also contains
    # #43be48 but in a form this pattern does not match.
    ('background-color: #43be48', 'background-color: #00A8DE'),
]

# content2/content3 ship inconsistent insets - content3 has no top margin at
# all. Align both to content4's geometry so every home-page panel shares one
# edge. index.css only.
LAYOUT_SUBS = [
    ('.right .content2{\n    padding: 10px;\n    margin-top: 10px;\n}',
     '.right .content2{\n    padding: 10px;\n    width: 97.6%;\n'
     '    margin: 10px 20px 0px 20px;\n}'),
    ('.right .content3{\n    padding: 10px;\n\tmargin: 0px 0px 0px 10px;\n}',
     '.right .content3{\n    padding: 10px;\n    width: 97.6%;\n'
     '    margin: 10px 20px 0px 20px;\n}'),
]

CSS_TARGETS = ['index.css', 'machine.css', 'ip.css', 'system.css',
               'fir.css', 'log.css']

# Appended to base.js. The marker _rxdContent3Hooked is what makes it
# idempotent.
BASE_JS_HOOK = '''

// index.esp ships no viewport meta and can't be edited (ESP recompile fails
// on the device), so inject it here. base.js is loaded from <head>, so this
// runs before the body lays out and mobile browsers honour it.
//
// The theme stylesheet goes in here too, NOT in the ready() handler below.
// Appended on ready it arrives after the DOM has been parsed and painted, so
// the page renders in IceRiver's stock styling and then visibly re-skins
// itself - a flash of the old UI on every single load. Added here it is an
// ordinary render-blocking stylesheet found during head parsing, so the very
// first paint is already themed.
(function(){
\tvar head = document.head || document.documentElement;

\tif(!document.querySelector('meta[name="viewport"]')){
\t\tvar m = document.createElement('meta');
\t\tm.name = 'viewport';
\t\tm.content = 'width=device-width, initial-scale=1';
\t\thead.appendChild(m);
\t}

\tif(!document.getElementById('rxd-theme')){
\t\tvar l = document.createElement('link');
\t\tl.id = 'rxd-theme';
\t\tl.rel = 'stylesheet';
\t\tl.type = 'text/css';
\t\tl.href = '/css/radiant.css?v=__RXD_BUILD__';
\t\thead.appendChild(l);
\t}
})();

$(document).ready(function(){
\t// content3 runs inside getlist2's success callback, ahead of loaded().
\t// Anything thrown here would strand the loading overlay, so our additions
\t// are isolated and can never break the stock chain.
\tvar _origContent3 = window.content3;
\twindow.content3 = function(data){
\t\t_origContent3(data);
\t\ttry {
\t\t\tif(window.rxdRecordData) rxdRecordData(data);
\t\t} catch(e) { if(window.console) console.error('rxd record:', e); }
\t\ttry {
\t\t\t// Every refresh, not on the per-minute recording cadence: stock
\t\t\t// content2 has just rewritten the hashrate tile and the status pill,
\t\t\t// and through the post-restart window both need relabelling again.
\t\t\tif(window.rxdRenderWarmup) rxdRenderWarmup(data);
\t\t} catch(e) { if(window.console) console.error('rxd warmup:', e); }
\t\tsetTimeout(function(){
\t\t\ttry {
\t\t\t\tif(window.rxdUpdateCharts) rxdUpdateCharts();
\t\t\t} catch(e) { if(window.console) console.error('rxd charts:', e); }
\t\t\ttry {
\t\t\t\t// Re-render from cached chip data on every stock refresh, same as
\t\t\t\t// rxdUpdateCharts above. The chip bridge itself is only polled on
\t\t\t\t// its own 60s timer, but this call does no fetch - it just rebuilds
\t\t\t\t// #rxd-chip-row, which this same content3 replace just wiped out.
\t\t\t\tif(window.rxdUpdateChipCharts) rxdUpdateChipCharts();
\t\t\t} catch(e) { if(window.console) console.error('rxd chip charts:', e); }
\t\t}, 100);
\t};
\twindow._rxdContent3Hooked = true;

\t// __RXD_BUILD__ changes every build so a new firmware never serves stale
\t// assets from cache (stock files get their buster from index.esp).
\t// Only the dashboard script loads here - the stylesheet is injected during
\t// head parsing above, because behaviour can arrive late but styling cannot.
\t$.getScript("/js/radiant_dashboard.js?v=__RXD_BUILD__");
});'''

ASSETS = [
    ('css', 'radiant.css'),
    ('js', 'radiant_dashboard.js'),
    # login.esp cannot be modified (ESP recompile fails on the device), so the
    # themed login page ships as a full replacement of login.css.
    ('css', 'login.css'),
]


def read(path):
    handle = io.open(path, 'r', encoding='utf-8')
    try:
        return handle.read()
    finally:
        handle.close()


def write(path, text):
    handle = io.open(path, 'w', encoding='utf-8')
    try:
        handle.write(text)
    finally:
        handle.close()


def patch_index_js(web, log):
    """Stock bug: getlist2() calls loading(1) before the in-flight guard, so
    an overlapping refresh returns early and the loading bar never hides."""
    path = os.path.join(web, 'js', 'index.js')
    if not os.path.exists(path):
        log('index.js missing, skipped')
        return False
    content = read(path)
    if 'function getlist2(){\n\tloading(1);' not in content:
        log('index.js already patched or restructured')
        return False
    content = content.replace('function getlist2(){\n\tloading(1);',
                              'function getlist2(){', 1)
    content = content.replace('\tpreviousRequest = $.ajax({',
                              '\tloading(1);\n\tpreviousRequest = $.ajax({', 1)
    write(path, content)
    log('index.js: loading(1) moved after the in-flight guard')
    return True


def patch_css(web, log):
    changed = 0
    for name in CSS_TARGETS:
        path = os.path.join(web, 'css', name)
        if not os.path.exists(path):
            continue
        content = read(path)
        count = 0
        for old, new in CSS_SUBS:
            if old in content:
                count += content.count(old)
                content = content.replace(old, new)
        layout = 0
        if name == 'index.css':
            for old, new in LAYOUT_SUBS:
                if old in content:
                    content = content.replace(old, new)
                    layout += 1
        if count or layout:
            write(path, content)
            changed += 1
            log('%s: %d substitutions%s'
                % (name, count, (' + %d layout' % layout) if layout else ''))
    return changed


def patch_base_js(web, build_id, log):
    path = os.path.join(web, 'js', 'base.js')
    if not os.path.exists(path):
        log('base.js missing - NOT patched, the dashboard will not load')
        return False
    content = read(path)
    if '_rxdContent3Hooked' in content:
        log('base.js already hooked')
        return False
    write(path, content + BASE_JS_HOOK.replace('__RXD_BUILD__', build_id))
    log('base.js: dashboard hook added (build %s)' % build_id)
    return True


def install_assets(web, assets, log):
    """Copy our own files in. Unlike the patches these are overwritten every
    time, so an upgraded asset reaches a tree an earlier boot already
    patched."""
    count = 0
    for kind, name in ASSETS:
        src = os.path.join(assets, kind, name)
        if not os.path.exists(src):
            log('asset missing, skipped: %s' % src)
            continue
        shutil.copyfile(src, os.path.join(web, kind, name))
        count += 1
    log('copied %d assets' % count)
    return count


def patch_web_root(root=DEFAULT_ROOT, assets=DEFAULT_ASSETS, build_id=None,
                   log=None):
    """Apply everything to an unpacked tree. `root` holds appweb.conf and web/.

    HTTPS is deliberately NOT handled here. It needs a ListenSecure directive
    in appweb.conf, and appweb reads that once at startup - so patching it
    after boot would do nothing until the server restarted. The offline
    package build handles HTTPS; the boot-time path does not claim to.
    """
    if log is None:
        def log(message):
            sys.stdout.write('  %s\n' % message)

    web = os.path.join(root, 'web')
    if not os.path.isdir(web):
        raise RuntimeError('no web/ under %s' % root)

    if build_id is None:
        # Changes whenever our assets change, so browsers do not serve a
        # stale dashboard out of cache.
        try:
            build_id = str(int(os.path.getmtime(
                os.path.join(assets, 'js', 'radiant_dashboard.js'))))
        except Exception:
            build_id = '0'

    install_assets(web, assets, log)
    patch_index_js(web, log)
    patch_css(web, log)
    patch_base_js(web, build_id, log)
    return True


def main(argv):
    root = argv[1] if len(argv) > 1 else DEFAULT_ROOT
    assets = argv[2] if len(argv) > 2 else DEFAULT_ASSETS
    patch_web_root(root, assets)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
