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
import sys

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
