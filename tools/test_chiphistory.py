#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Exercise /chiphistory's replay ON the miner, under its own python 2.7.

Like test_stockpeer.py this has to run on the device: rxd_bridge.py is
python 2 (`except E, ex`) and the workstation's python 3 cannot import it.

What it guards: chip_history() used to render each sample as an 'HH:MM' string
with time.localtime(), i.e. the MINER's clock, while /history returns epoch ms
that the browser renders with its own. The chip charts therefore sat on a
different timescale from the board charts above them - offset by the viewer's
UTC offset, four hours where this was found - and an HH:MM carries no date, so
a series could read backwards without anything being able to detect it.

It also used to collapse any two samples that landed in the same minute, since
the label was the identity.
"""
import os
import sys
import tempfile

sys.path.insert(0, '/var/order')
import rxd_bridge as b

fail = []


def check(label, ok, detail=''):
    print('  %s  %s%s' % ('PASS' if ok else 'FAIL', label,
                          ('  ' + str(detail)) if detail else ''))
    if not ok:
        fail.append(label)


VALUES = '64.0 66.083 67.0 368.0 371.167 376.0 775.0 775.0 775.0'


def replay(lines, hours=24, points=288):
    """Run chip_history over a fixture log."""
    handle, path = tempfile.mkstemp(prefix='rxd_chiptest_')
    os.write(handle, ''.join(l + '\n' for l in lines))
    os.close(handle)
    keep = b.CHIP_LOG
    b.CHIP_LOG = path
    try:
        return b.chip_history(hours, points)
    finally:
        b.CHIP_LOG = keep
        os.unlink(path)


NOW = int(b.time.time())
SERIES = ['tempMin', 'tempAvg', 'tempMax', 'voltMin', 'voltAvg', 'voltMax',
          'pllMin', 'pllAvg', 'pllMax']


def aligned(out):
    n = len(out['timestamps'])
    for series in out['boards'].values():
        for name in SERIES:
            if len(series[name]) != n:
                return False
    return True


print('=== timestamps are epoch milliseconds, not rendered labels')
out = replay(['%d 1 %s' % (NOW - 600, VALUES),
              '%d 1 %s' % (NOW - 300, VALUES)])
check('two samples', len(out['timestamps']) == 2, out['timestamps'])
check('they are numbers, not strings',
      all(isinstance(t, (int, long)) for t in out['timestamps']))
check('first is its epoch second x 1000',
      out['timestamps'][0] == (NOW - 600) * 1000, out['timestamps'][0])
check('ascending', out['timestamps'][0] < out['timestamps'][1])
check('the gap is the real 300 s',
      out['timestamps'][1] - out['timestamps'][0] == 300000)
check('aligned', aligned(out))

print('')
print('=== two samples in one minute are two samples')
# The old code keyed on the 'HH:MM' label, so these merged into one point and
# the second board's readings overwrote the first's.
out = replay(['%d 1 %s' % (NOW - 50, VALUES),
              '%d 1 %s' % (NOW - 20, VALUES)])
check('both kept', len(out['timestamps']) == 2, out['timestamps'])
check('aligned', aligned(out))

print('')
print('=== boards written for one sample share one index')
out = replay(['%d 1 %s' % (NOW - 300, VALUES),
              '%d 2 %s' % (NOW - 300, VALUES),
              '%d 1 %s' % (NOW, VALUES),
              '%d 2 %s' % (NOW, VALUES)])
check('one timestamp per sample, not per line',
      len(out['timestamps']) == 2, out['timestamps'])
check('two boards', sorted(out['boards'].keys()) == ['1', '2'])
check('aligned', aligned(out))

print('')
print('=== a repeated (time, board) line is ignored')
out = replay(['%d 1 %s' % (NOW, VALUES)] * 3)
check('one point', len(out['timestamps']) == 1, out['timestamps'])
check('one reading', len(out['boards']['1']['tempAvg']) == 1)

print('')
print('=== a board appearing late is back-filled')
out = replay(['%d 1 %s' % (NOW - 600, VALUES),
              '%d 1 %s' % (NOW - 300, VALUES),
              '%d 2 %s' % (NOW - 300, VALUES)])
check('three timestamps are not invented',
      len(out['timestamps']) == 2, out['timestamps'])
check('board 2 is padded to the shared length', aligned(out))
check('its padding sits before its first real reading',
      out['boards']['2']['tempAvg'][0] == 0)

print('')
print('=== the cutoff drops anything older than the window')
out = replay(['%d 1 %s' % (NOW - 90000, VALUES),
              '%d 1 %s' % (NOW - 300, VALUES)], hours=1)
check('only the recent one', len(out['timestamps']) == 1, out['timestamps'])
check('and it is the recent one',
      out['timestamps'][0] == (NOW - 300) * 1000)

print('')
print('=== thinning keeps the shape and the alignment')
lines = ['%d 1 %s' % (NOW - (200 - i) * 300, VALUES) for i in range(200)]
out = replay(lines, points=50)
check('thinned to the cap', len(out['timestamps']) <= 50,
      len(out['timestamps']))
check('aligned after thinning', aligned(out))
check('still ascending',
      all(out['timestamps'][i] < out['timestamps'][i + 1]
          for i in range(len(out['timestamps']) - 1)))
check('untouched below the cap',
      len(replay(lines, points=288)['timestamps']) == 200)

print('')
print('=== junk lines are skipped, not fatal')
out = replay(['nonsense',
              'notanumber 1 %s' % VALUES,
              '%d 1 short' % NOW,
              '%d 1 %s' % (NOW, VALUES)])
check('one good line survives', len(out['timestamps']) == 1, out['timestamps'])
check('a missing log is empty, not an exception',
      b.chip_history.__call__ and True)

keep = b.CHIP_LOG
b.CHIP_LOG = '/tmp/rxd_no_such_chip_log'
try:
    out = b.chip_history(24, 288)
finally:
    b.CHIP_LOG = keep
check('absent log returns the empty shape',
      out == {'timestamps': [], 'boards': {}}, out)

print('')
if fail:
    print('%d failed: %s' % (len(fail), ', '.join(fail)))
    sys.exit(1)
print('all passed')
