#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Exercise the stock-peer fallback ON the miner, under its own python 2.7.

This has to run on the device: rxd_bridge.py is python 2 (`except E, ex`), so
it cannot even be imported by the python 3 on the workstation.

The miner is a convenient test subject because it serves BOTH interfaces - our
bridge on 4112 and the stock web API on 80 - so stock_summary() can be pointed
at a real device rather than a fixture, while _fetch_summary() against the
same address must still prefer the bridge.
"""
import sys, time

sys.path.insert(0, '/var/order')
import rxd_bridge as b

HOST = '127.0.0.1'
fail = []


def check(label, ok, detail=''):
    print('  %s  %s%s' % ('PASS' if ok else 'FAIL', label,
                          ('  ' + str(detail)) if detail else ''))
    if not ok:
        fail.append(label)


print('=== hashrate_value')
for text, want in [('320.23G', 320.23), ('121G', 121.0), ('1.5T', 1500.0),
                   ('', None), (None, None), ('abc', None)]:
    got = b.hashrate_value(text)
    ok = (got is None and want is None) or (
        got is not None and want is not None and abs(got - want) < 0.001)
    check('%-10r -> %s' % (text, want), ok, got)

print('')
print('=== stock_uptime')
for text, want in [('00:00:24:35', 1475), ('01:02:03:04', 93784),
                   ('bad', None), ('', None), ('1:2:3', None)]:
    check('%-14r -> %s' % (text, want), b.stock_uptime(text) == want,
          b.stock_uptime(text))

print('')
print('=== stock_panel answers without a session')
try:
    data = b.stock_panel(HOST)
    check('got a payload', isinstance(data, dict))
    check('has boards', bool(data.get('boards')))
except Exception, ex:
    check('stock_panel', False, ex)
    data = {}

print('')
print('=== VERSION is a release string, and /about reports it')
import re as _re
check('VERSION is semver-shaped',
      bool(_re.match(r'^\d+\.\d+\.\d+$', b.VERSION)), b.VERSION)
_about = b.about()
check('/about carries it', _about.get('version') == b.VERSION,
      _about.get('version'))
# The two coexist on purpose: a hand-typed version can go stale, an mtime
# cannot. Losing the mtime would remove the only check on a forgotten bump.
check('/about still carries bridgeInstalledMs alongside it',
      _about.get('bridgeInstalledMs') is not None,
      _about.get('bridgeInstalledMs'))

print('')
print('=== the loopback panel has its own timeout, not the per-peer one')
# Raising SWARM_TIMEOUT instead would have been the easy fix and the wrong one:
# /swarm joins every peer thread for SWARM_TIMEOUT + 1.0, so a bigger per-peer
# budget makes the swarm page slower for everyone to rescue one local call.
check('PANEL_TIMEOUT is larger than the per-peer budget',
      b.PANEL_TIMEOUT > b.SWARM_TIMEOUT,
      '%s vs %s' % (b.PANEL_TIMEOUT, b.SWARM_TIMEOUT))
check('PANEL_TTL is shorter than the page refresh, so a tick is never stale',
      b.PANEL_TTL < 10.0, b.PANEL_TTL)
check('stock_panel still defaults to the per-peer budget for real peers',
      b.stock_panel.func_defaults == (b.SWARM_TIMEOUT,),
      b.stock_panel.func_defaults)

print('')
print('=== local_panel deduplicates and does not cache failures')
real_panel = b.stock_panel
calls = []


def reset_cache():
    b._panel_cache[0] = 0.0
    b._panel_cache[1] = None


def counting(host, timeout=None):
    calls.append((host, timeout))
    return {'pools': [{'connect': 1, 'accepted': 7, 'rejected': 0,
                       'addr': 'stub', 'user': 'w.rx0', 'no': 1}],
            'runtime': '00:00:01:00'}


def boom(host, timeout=None):
    calls.append((host, timeout))
    raise IOError('timed out')


try:
    reset_cache()
    b.stock_panel = counting
    first = b.local_panel()
    second = b.local_panel()
    check('two calls inside the TTL cost one appweb fetch', len(calls) == 1,
          '%d fetches' % len(calls))
    check('both callers get the same payload', first is second)
    check('it asks loopback, with the panel budget',
          calls[0] == ('127.0.0.1', b.PANEL_TIMEOUT), calls[0])

    # The reason this matters: /pool and /summary both want the counts, and
    # before the cache each paid for its own 1.3-2.9 s round trip.
    del calls[:]
    b._panel_cache[0] = time.time() - 1.0      # expire it, keep the payload
    b.local_panel()
    check('an expired entry is refetched', len(calls) == 1, '%d fetches' % len(calls))

    del calls[:]
    reset_cache()
    b.stock_panel = boom
    raised = False
    try:
        b.local_panel()
    except IOError:
        raised = True
    check('a failing fetch propagates rather than returning junk', raised)
    check('and nothing was cached', b._panel_cache[1] is None)

    # A cached failure would be the worst outcome: /pool would keep answering
    # 503 for the whole TTL after appweb had already recovered.
    del calls[:]
    b.stock_panel = counting
    b.local_panel()
    check('the next caller after a failure re-asks immediately', len(calls) == 1,
          '%d fetches' % len(calls))

    # local_shares swallows errors by contract - /summary must still produce a
    # row for a miner whose appweb is wedged - so check it survives the raise.
    reset_cache()
    b.stock_panel = boom
    shares = b.local_shares()
    check('local_shares degrades to None rather than 0 when the panel fails',
          shares.get('accepted') is None and shares.get('rejected') is None,
          shares)
finally:
    b.stock_panel = real_panel
    reset_cache()

print('')
print('=== sync_clock: best effort, never fatal, never leaks descriptors')
real_call = b.subprocess.call
attempts = []


def fake_call(argv, **kw):
    attempts.append((argv, kw))
    # Succeed only on the second server, to prove it falls through.
    return 0 if argv[-1] == b.TIME_SERVERS[1] else 1


def exploding_call(argv, **kw):
    attempts.append((argv, kw))
    raise OSError('no such binary')


try:
    check('there is more than one time server to try', len(b.TIME_SERVERS) > 1,
          b.TIME_SERVERS)

    del attempts[:]
    b.subprocess.call = fake_call
    ok = b.sync_clock()
    check('returns True once a server answers', ok is True)
    check('tried servers in order until one worked', len(attempts) == 2,
          [a[0][-1] for a in attempts])
    check('invoked busybox rdate -s', attempts[0][0][:3] == ['busybox', 'rdate', '-s'],
          attempts[0][0])
    # The whole reason the dashboard went down on 2026-10-20 was an inherited
    # descriptor, so this is checked on every spawn now, not just the fan one.
    check('close_fds=True, so no descriptor is inherited',
          attempts[0][1].get('close_fds') is True, attempts[0][1])

    del attempts[:]

    def refusing_call(argv, **kw):
        attempts.append((argv, kw))
        return 1

    b.subprocess.call = refusing_call
    check('returns False when nothing answers', b.sync_clock() is False)
    check('and it tried every server before giving up',
          len(attempts) == len(b.TIME_SERVERS),
          '%d attempts for %d servers' % (len(attempts), len(b.TIME_SERVERS)))

    del attempts[:]
    b.subprocess.call = exploding_call
    raised = False
    try:
        result = b.sync_clock()
    except Exception:
        raised = True
        result = None
    check('a missing busybox raises nothing', not raised)
    check('and reports failure rather than claiming success', result is False)
finally:
    b.subprocess.call = real_call

print('')
print('=== stock_summary against a real miner')
row = b.stock_summary(HOST)
for k in ('stock', 'alive', 'hashrate', 'boardTemp', 'fanRpm', 'uptime',
          'accepted', 'rejected', 'chips', 'mhz', 'tempMax'):
    print('    %-10s %r' % (k, row.get(k)))
check('marked stock', row.get('stock') is True)
check('alive', row.get('alive') is True)
check('hashrate is a sane number',
      isinstance(row.get('hashrate'), float) and row['hashrate'] > 0)
check('boardTemp populated from intmp/outtmp',
      isinstance(row.get('boardTemp'), float) and row['boardTemp'] > 0)
check('uptime parsed', isinstance(row.get('uptime'), int)
      and row['uptime'] > 0)
# The whole point: these are junk in the stock payload and must not be shown.
check('chips withheld (payload says 18, truth is 12)', row.get('chips') is None)
check('mhz withheld (payload says 875, truth is 775)', row.get('mhz') is None)
check('tempMax withheld (intmp is a PCB sensor, not a chip)',
      row.get('tempMax') is None)
check('fanRatio withheld (not in the stock payload)',
      row.get('fanRatio') is None)

print('')
print('=== _fetch_summary prefers the bridge when one is there')
results = [None]
b._fetch_summary({'host': HOST, 'name': 'self'}, results, 0)
row = results[0]
print('    stock=%r alive=%r mhz=%r chips=%r hashrate=%r'
      % (row.get('stock'), row.get('alive'), row.get('mhz'),
         row.get('chips'), row.get('hashrate')))
check('not flagged stock', row.get('stock') is False)
check('has the chip detail only the bridge can give', row.get('mhz') is not None)
check('name/host come from the peer entry',
      row.get('name') == 'self' and row.get('host') == HOST)

print('')
print('=== _fetch_summary falls back when 4112 refuses')
real_port = b.LISTEN_PORT
b.LISTEN_PORT = 4119          # nothing listens here
try:
    results = [None]
    b._fetch_summary({'host': HOST, 'name': 'pretend-stock'}, results, 0)
    row = results[0]
    print('    stock=%r alive=%r hashrate=%r mhz=%r error=%r'
          % (row.get('stock'), row.get('alive'), row.get('hashrate'),
             row.get('mhz'), row.get('error')))
    check('flagged stock', row.get('stock') is True)
    check('still reports a hashrate', row.get('hashrate') > 0)
    check('clock stays blank', row.get('mhz') is None)
    check('no error, because the fallback worked',
          row.get('error') is None)
    check('label preserved', row.get('name') == 'pretend-stock')
finally:
    b.LISTEN_PORT = real_port

print('')
print('=== a genuinely dead peer still reports the BRIDGE error')
# 192.0.2.1 is TEST-NET-1, reserved and unroutable. NOT 127.0.0.9: the whole
# of 127.0.0.0/8 is loopback, so that reaches this very bridge and the "dead"
# peer answers alive.
results = [None]
b._fetch_summary({'host': '192.0.2.1', 'name': 'ghost'}, results, 0)
row = results[0]
print('    alive=%r stock=%r error=%r'
      % (row.get('alive'), row.get('stock'), (row.get('error') or '')[:60]))
check('not alive', not row.get('alive'))
check('carries an error', bool(row.get('error')))

print('')
print('FAILED: %d' % len(fail) if fail else 'all passed')
sys.exit(1 if fail else 0)
