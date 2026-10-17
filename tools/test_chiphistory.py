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
# With the SoC die temperature, the 12th field added later. Both widths live in
# one log for as long as the older half takes to age out.
VALUES12 = VALUES + ' 60.41'


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
print('=== the SoC die temperature, and the mixed-width log it arrives in')
# The column was added to a file that already held two weeks of 11-field
# lines. A `!= 12` length check would have silently dropped all of them.
out = replay(['%d 1 %s' % (NOW - 900, VALUES),
              '%d 1 %s' % (NOW - 600, VALUES12),
              '%d 1 %s' % (NOW - 300, '%s -' % VALUES)])
check('all three samples survive the width change',
      len(out['timestamps']) == 3, out['timestamps'])
check('soc runs parallel to timestamps',
      len(out['soc']) == len(out['timestamps']), out['soc'])
check('an 11-field line reads as a gap, not a temperature',
      out['soc'][0] is None, out['soc'][0])
check('a 12-field line reads the value', out['soc'][1] == 60.41, out['soc'][1])
check("a '-' from an unreadable XADC is a gap too",
      out['soc'][2] is None, out['soc'][2])
check('the chip series are unaffected by the extra field',
      out['boards']['1']['tempAvg'] == [66.083] * 3,
      out['boards']['1']['tempAvg'])
check('and the pll series still ends at the 11th field, not the 12th',
      out['boards']['1']['pllMax'] == [775.0] * 3,
      out['boards']['1']['pllMax'])

print('')
print('=== soc is per machine, so a second board does not add a point')
out = replay(['%d 1 %s' % (NOW, VALUES12),
              '%d 2 %s' % (NOW, VALUES12)])
check('one timestamp', len(out['timestamps']) == 1, out['timestamps'])
check('one soc reading', out['soc'] == [60.41], out['soc'])

print('')
print('=== thinning keeps soc aligned with the timestamps it belongs to')
lines = ['%d 1 %s %d' % (NOW - (200 - i) * 300, VALUES, 50 + i)
         for i in range(200)]
out = replay(lines, points=50)
check('soc is thinned with the rest',
      len(out['soc']) == len(out['timestamps']), (len(out['soc']), len(out['timestamps'])))
check('and it is still ascending, so the pairing held',
      out['soc'] == sorted(out['soc']), out['soc'][:5])

print('')
print('=== a garbled 12th field degrades to a gap, it does not drop the sample')
out = replay(['%d 1 %s nonsense' % (NOW, VALUES)])
check('the sample is kept', len(out['timestamps']) == 1, out['timestamps'])
check('with soc as a gap', out['soc'] == [None], out['soc'])

print('')
print('=== soc_temp reads the real XADC on this machine')
live = b.soc_temp()
check('it returns a number, not None', live is not None, live)
check('and it is a plausible die temperature (20-95 C)',
      live is not None and 20 < live < 95, live)
check('the live summary carries it too',
      'soc' in b.summarise(b.query_miner(b.CHIP_COMMAND), b.board_profiles()))

print('')
print('=== which store a sample is written to')
# /run/media lives on tmpfs. If a card is pulled and the automounter leaves the
# directory behind, a path-exists check would "write to the card" and quietly
# fill RAM - in the same 122 MB tmpfs the firmware upgrade runs inside. So the
# selection turns on it being a MOUNTPOINT, and this is that regression.
media = tempfile.mkdtemp(prefix='rxd_media_')
os.mkdir(os.path.join(media, 'mmcblk0p1'))
keep_media, keep_mount = b.SD_MEDIA, b._is_mount
b.SD_MEDIA = media
try:
    b._is_mount = lambda path: False
    check('a leftover directory that is NOT a mount is ignored',
          b.sd_log_dir() is None, b.sd_log_dir())
    check('so samples still go to NAND', b.chip_log_target() == b.CHIP_LOG)

    b._is_mount = lambda path: True
    check('a real mount is used', b.sd_log_dir(),
          os.path.join(media, 'mmcblk0p1'))
    check('and samples go to the card',
          b.chip_log_target(),
          os.path.join(media, 'mmcblk0p1', b.SD_LOG_NAME))

    b.SD_MEDIA = '/no/such/path'
    check('a missing /run/media is not an error', b.sd_log_dir() is None)
finally:
    b.SD_MEDIA, b._is_mount = keep_media, keep_mount

print('')
print('=== history is the UNION of NAND and the card')
# Reading either store alone would blank a day of charts: once when the card
# goes in, and again if it is taken out. sd_log_dir's own selection is covered
# above; here the two stores are named directly, which keeps the test about
# the merge.
nand = tempfile.mkdtemp(prefix='rxd_nand_')
nand_log = os.path.join(nand, 'nand.log')
card_log = os.path.join(nand, 'card.log')
# NAND holds the older samples, the card the newer - except the card is also
# given an EARLIER row, because a card moved between machines or reinserted
# after a spell out interleaves them. The old reader assigned indices in the
# order lines arrived, which a single append-only file made safe and two files
# do not.
NL = chr(10)
open(nand_log, 'w').write(
    NL.join(['%d 1 %s' % (NOW - 900, VALUES),
             '%d 1 %s' % (NOW - 600, VALUES), '']))
open(card_log, 'w').write(
    NL.join(['%d 1 %s' % (NOW - 300, VALUES12),
             '%d 1 %s' % (NOW - 750, VALUES12), '']))

keep_sources = b.chip_log_sources
b.chip_log_sources = lambda: [nand_log, card_log]
try:
    out = b.chip_history(24, 288)
    check('all four samples are present', len(out['timestamps']), 4)
    check('and in time order',
          out['timestamps'] == sorted(out['timestamps']), out['timestamps'])
    check('the earliest is the NAND one',
          out['timestamps'][0], (NOW - 900) * 1000)
    check('the latest is the card one',
          out['timestamps'][-1], (NOW - 300) * 1000)
    check('the card row that sorts earlier landed in the middle',
          out['timestamps'][1], (NOW - 750) * 1000)
    check('soc is present for the card rows and absent for the NAND ones',
          [v is not None for v in out['soc']], [False, True, False, True])
    check('series stay aligned across the merge', aligned(out))
    check('a window cutoff still applies across both stores',
          len(b.chip_history(1, 288)['timestamps']), 4)
finally:
    b.chip_log_sources = keep_sources

print('')
print('=== the same sample in both stores is kept once, richer line winning')
both_a = os.path.join(nand, 'both_a.log')
both_b = os.path.join(nand, 'both_b.log')
open(both_a, 'w').write('%d 1 %s' % (NOW, VALUES) + NL)     # 11 fields, no soc
open(both_b, 'w').write('%d 1 %s' % (NOW, VALUES12) + NL)   # 12 fields, with
keep_sources = b.chip_log_sources
b.chip_log_sources = lambda: [both_a, both_b]
try:
    out = b.chip_history(24, 288)
    check('one point, not two', len(out['timestamps']), 1)
    check('and the SoC reading survived', out['soc'], [60.41])
    # Reversed order must give the same answer, or the result depends on which
    # store happened to be listed first.
    b.chip_log_sources = lambda: [both_b, both_a]
    check('order of the stores does not change the result',
          b.chip_history(24, 288)['soc'], [60.41])
finally:
    b.chip_log_sources = keep_sources

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
      out == {'timestamps': [], 'boards': {}, 'soc': []}, out)

print('')
if fail:
    print('%d failed: %s' % (len(fail), ', '.join(fail)))
    sys.exit(1)
print('all passed')
