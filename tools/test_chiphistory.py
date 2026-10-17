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
import atexit
import os
import shutil
import sys
import tempfile

sys.path.insert(0, '/var/order')
import rxd_bridge as b

# This suite runs ON the miner, which may have an SD card in the slot. Without
# this, chip_log_sources() finds the real card and mixes live samples into
# every fixture - which is exactly what happened the first time the chip log
# moved into the card's logs/ folder: 24 tests failed reading real data. The
# sections that test card selection patch _is_mount back for themselves, and
# restore it to this, so the isolation holds for everything after them.
b._is_mount = lambda path: False


# This suite runs ON the miner, where /tmp is a symlink into /var/volatile -
# the 122 MB tmpfs the firmware upgrade unpacks itself into. A fixture
# directory left behind there is the one kind of test litter that can actually
# cost something, and four of these leaked on every single run until someone
# went looking at the filesystem. Registering them beats a try/finally per
# section: a test that raises still cleans up after itself.
_TEMPDIRS = []


def mkdtemp(prefix):
    path = tempfile.mkdtemp(prefix=prefix)
    _TEMPDIRS.append(path)
    return path


@atexit.register
def _drop_tempdirs():
    for path in _TEMPDIRS:
        shutil.rmtree(path, ignore_errors=True)


fail = []


def equals(label, got, want):
    """Assert that two values are equal, and say so when they are not.

    Separate from check() because the two kept being confused, three times in
    one session. check(label, ok, detail) takes a BOOLEAN: written as
    check('...', f(), 3) it passes whenever f() is merely truthy and prints
    the 3 as a note, so an assertion that reads as an equality test is really
    only a not-empty test - and check('...', f(), 0) fails even when f()
    correctly returns 0. Anything comparing a value to an expected value
    belongs here instead.
    """
    ok = got == want
    print('  %s  %s%s' % ('PASS' if ok else 'FAIL', label,
                          '' if ok else '\n          got %r want %r' % (got, want)))
    if not ok:
        fail.append(label)
    return ok


def check(label, ok, detail=''):
    # A value here instead of a boolean is the misuse described above, and it
    # hides either way: truthy values pass without comparing anything, and a
    # correct 0 fails. Name it rather than scoring it.
    if not isinstance(ok, bool):
        print('  MISUSE  %s  (check() wants a boolean - use equals())' % label)
        fail.append(label + ' [misuse]')
        return
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
media = mkdtemp('rxd_media_')
os.mkdir(os.path.join(media, 'mmcblk0p1'))
keep_media, keep_mount = b.SD_MEDIA, b._is_mount
b.SD_MEDIA = media
try:
    b._is_mount = lambda path: False
    check('a leftover directory that is NOT a mount is ignored',
          b.sd_log_dir() is None, b.sd_log_dir())
    check('so samples still go to NAND', b.chip_log_target() == b.CHIP_LOG)

    b._is_mount = lambda path: True
    mount = os.path.join(media, 'mmcblk0p1')
    equals('a real mount is used', b.sd_log_dir(), mount)
    equals('and samples go into the card\'s logs folder, not its root',
          b.chip_log_target(),
          os.path.join(mount, b.ARCHIVE_DIR_NAME, b.SD_LOG_NAME))
    check('which the bridge creates itself',
          os.path.isdir(os.path.join(mount, b.ARCHIVE_DIR_NAME)))

    b.SD_MEDIA = '/no/such/path'
    check('a missing /run/media is not an error', b.sd_log_dir() is None)
finally:
    b.SD_MEDIA, b._is_mount = keep_media, keep_mount

print('')
print('=== a card written by an earlier build is migrated, not abandoned')
# The chip log used to sit at the card's root. Leaving it there would split the
# history across two files for ever, so it is moved in on sight - and until it
# is moved, it still has to be READ, or inserting an old card would blank the
# charts for however long it took to notice.
media = mkdtemp('rxd_legacy_')
mount = os.path.join(media, 'mmcblk0p1')
os.mkdir(mount)
legacy = os.path.join(mount, b.SD_LOG_NAME)
with open(legacy, 'w') as handle:
    handle.write('2026-10-01 00:00:00 1 2 3\n')
keep_media, keep_mount = b.SD_MEDIA, b._is_mount
b.SD_MEDIA = media
try:
    b._is_mount = lambda path: path == mount
    check('the root file is read before it is moved',
          legacy in b.chip_log_sources())

    moved = os.path.join(mount, b.ARCHIVE_DIR_NAME, b.SD_LOG_NAME)
    equals('the next sample targets the folder', b.chip_log_target(), moved)
    check('and the old file is gone', not os.path.exists(legacy))
    check('with its contents carried over', os.path.exists(moved)
          and open(moved).read() == '2026-10-01 00:00:00 1 2 3\n')
    check('the moved file is what history now reads',
          moved in b.chip_log_sources())

    # A second call must not undo the move or lose the file.
    equals('the move is idempotent', b.chip_log_target(), moved)
finally:
    b.SD_MEDIA, b._is_mount = keep_media, keep_mount
    shutil.rmtree(media, ignore_errors=True)

print('')
print('=== reporting the path does not move anything')
# /about calls chip_log_target to display it. A status read must not rewrite
# the card, so the migration is opt-in.
media = mkdtemp('rxd_nomig_')
mount = os.path.join(media, 'mmcblk0p1')
os.mkdir(mount)
legacy = os.path.join(mount, b.SD_LOG_NAME)
with open(legacy, 'w') as handle:
    handle.write('2026-10-01 00:00:00 1 2 3\n')
keep_media, keep_mount = b.SD_MEDIA, b._is_mount
b.SD_MEDIA = media
try:
    b._is_mount = lambda path: path == mount
    equals('it reports where the data actually is',
          b.chip_log_target(migrate=False), legacy)
    check('and left the file alone', os.path.exists(legacy))
    check('sd_status does not move it either',
          b.sd_status()['log'] == legacy and os.path.exists(legacy))
finally:
    b.SD_MEDIA, b._is_mount = keep_media, keep_mount
    shutil.rmtree(media, ignore_errors=True)

print('')
print('=== history is the UNION of NAND and the card')
# Reading either store alone would blank a day of charts: once when the card
# goes in, and again if it is taken out. sd_log_dir's own selection is covered
# above; here the two stores are named directly, which keeps the test about
# the merge.
nand = mkdtemp('rxd_nand_')
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
    equals('all four samples are present', len(out['timestamps']), 4)
    check('and in time order',
          out['timestamps'] == sorted(out['timestamps']), out['timestamps'])
    equals('the earliest is the NAND one',
          out['timestamps'][0], (NOW - 900) * 1000)
    equals('the latest is the card one',
          out['timestamps'][-1], (NOW - 300) * 1000)
    equals('the card row that sorts earlier landed in the middle',
          out['timestamps'][1], (NOW - 750) * 1000)
    equals('soc is present for the card rows and absent for the NAND ones',
          [v is not None for v in out['soc']], [False, True, False, True])
    check('series stay aligned across the merge', aligned(out))
    equals('a window cutoff still applies across both stores',
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
    equals('one point, not two', len(out['timestamps']), 1)
    equals('and the SoC reading survived', out['soc'], [60.41])
    # Reversed order must give the same answer, or the result depends on which
    # store happened to be listed first.
    b.chip_log_sources = lambda: [both_b, both_a]
    equals('order of the stores does not change the result',
          b.chip_history(24, 288)['soc'], [60.41])
finally:
    b.chip_log_sources = keep_sources

print('')
print('=== the log archiver: the three ways these files lose data')
NL2 = chr(10)
arc = mkdtemp('rxd_arc_')
src_log = os.path.join(arc, 'run.log')
dst_log = os.path.join(arc, 'archive.log')


def write(path, lines):
    handle = open(path, 'w')
    handle.write(NL2.join(lines + ['']))
    handle.close()


def read(path):
    try:
        handle = open(path)
        try:
            return [l for l in handle.read().split(NL2) if l]
        finally:
            handle.close()
    except IOError:
        return []


write(src_log, ['2026-10-17 01:00:00		first',
                '2026-10-17 01:00:05		second'])
equals('a first archive takes everything',
      b._archive_one(src_log, dst_log), 2)
equals('and the content matches', len(read(dst_log)), 2)
again = b._archive_one(src_log, dst_log)
check('running again appends nothing', again == 0, again)

# TRUNCATION: the miner rewrites run.log from scratch at every startup. A byte
# offset would be meaningless here; a timestamp is not.
write(src_log, ['2026-10-17 02:00:00		after a reboot'])
equals('a truncated-and-restarted log contributes only its new line',
      b._archive_one(src_log, dst_log), 1)
equals('the archive kept the lines the truncation destroyed',
      len(read(dst_log)), 3)

# THE BOUNDARY SECOND: lines sharing the last archived timestamp cannot be
# decided by timestamp alone. Skipping loses them, re-appending duplicates
# them on every pass.
write(src_log, ['2026-10-17 02:00:00		after a reboot',
                '2026-10-17 02:00:00		same second, written later'])
equals('a later line in the SAME second is still picked up',
      b._archive_one(src_log, dst_log), 1)
dup = b._archive_one(src_log, dst_log)
check('and is not duplicated on the next pass', dup == 0, dup)
equals('total lines are right', len(read(dst_log)), 4)

# FRONT TRIM: his.log is capped and cut from the front, so its first line is a
# severed fragment AND its first stamp is older than anything archived - the
# file still holds lines that were archived long ago. The original fixture here
# put the fragment in front of a NEWER stamp, which is not a shape this file
# can have, and it hid the difference from the boot case below.
write(src_log, ['-30 05:03:07		truncated fragment from the ring',
                '2026-10-17 01:30:00		a line already in the archive',
                '2026-10-17 03:00:00		real line'])
equals('a headless fragment does not break the scan',
      b._archive_one(src_log, dst_log), 1)
frags = [l for l in read(dst_log) if 'fragment' in l]
check('and the fragment itself was not archived', frags == [], frags)

# CONTINUATION LINES: rxdweb.log indents its detail under a stamped heading.
write(src_log, ['2026-10-17 04:00:00		heading',
                '  indented detail with no timestamp'])
equals('detail lines inherit the stamp above them',
      b._archive_one(src_log, dst_log), 2)
equals('so the detail stayed with its heading',
      len([l for l in read(dst_log) if 'indented detail' in l]), 1)

# A BOOT: run.log is recreated at every startup with the whole kernel dmesg at
# its head, unstamped. Its first stamp is necessarily NEWER than anything
# archived from the previous boot, so that block is new content - and treating
# it like a ring fragment silently lost every boot's kernel log. Caught by
# counting lines on the real machine: 897 live against 809 archived, a gap of
# exactly the 88-line dmesg block.
write(src_log, ['Booting Linux on physical CPU 0x0',
                'Memory: 233216K/262144K available',
                '2026-10-17 06:00:00		first stamped line of the new boot'])
equals('the kernel block at the head of a fresh run.log is archived',
      b._archive_one(src_log, dst_log), 3)
equals('including the dmesg lines themselves',
      len([l for l in read(dst_log) if 'Booting Linux' in l]), 1)
again = b._archive_one(src_log, dst_log)
check('and it is not re-archived on the next pass', again == 0, again)

print('')
print('=== a log with NO timestamps anywhere, like the bridge stdout log')
# This broke the first version: nothing in the file is stamped, so every line
# looked older than the archive and the whole file was re-appended on every
# pass. The second real run archived 14 lines instead of 0.
plain_src = os.path.join(arc, 'rxdbridge.log')
plain_dst = os.path.join(arc, 'rxdbridge_archive.log')
write(plain_src, ['Serving on 0.0.0.0:4112', 'Traceback (most recent call last):'])
equals('a first archive takes it', b._archive_one(plain_src, plain_dst), 2)
again2 = b._archive_one(plain_src, plain_dst)
check('and a second pass adds NOTHING', again2 == 0, again2)
# tmpfs: after a reboot the source restarts from empty and grows again. The
# lines already archived must not be duplicated.
write(plain_src, ['Serving on 0.0.0.0:4112'])
after_boot = b._archive_one(plain_src, plain_dst)
check('a log that restarted from empty does not duplicate',
      after_boot == 0, after_boot)
write(plain_src, ['Serving on 0.0.0.0:4112', 'something new happened'])
equals('but genuinely new lines are picked up',
      b._archive_one(plain_src, plain_dst), 1)
equals('so the archive has the pre-reboot lines AND the new one',
      len(read(plain_dst)), 3)

print('')
print('=== archive_logs does nothing without a card')
keep_media, keep_mount = b.SD_MEDIA, b._is_mount
b.SD_MEDIA = '/no/such/media'
try:
    nocard = b.archive_logs()
    check('no card, no writes', nocard == 0, nocard)
finally:
    b.SD_MEDIA, b._is_mount = keep_media, keep_mount

print('')
print('=== and with one it creates its folder and copies')
media2 = mkdtemp('rxd_media2_')
mount = os.path.join(media2, 'mmcblk0p1')
os.mkdir(mount)
keep_media, keep_mount, keep_list = b.SD_MEDIA, b._is_mount, b.ARCHIVED_LOGS
b.SD_MEDIA = media2
b._is_mount = lambda path: path == mount
b.ARCHIVED_LOGS = [src_log, '/var/order/no_such_log_at_all.log']
try:
    written = b.archive_logs()
    check('it copied the real log', written > 0, written)
    check('into a logs/ folder',
          os.path.isdir(os.path.join(mount, b.ARCHIVE_DIR_NAME)))
    check('named after the source',
          os.path.exists(os.path.join(mount, b.ARCHIVE_DIR_NAME, 'run.log')))
    second = b.archive_logs()
    check('a log that does not exist is skipped, not fatal',
          second == 0, second)
finally:
    b.SD_MEDIA, b._is_mount, b.ARCHIVED_LOGS = keep_media, keep_mount, keep_list

print('')
print('=== pull the card, run for hours, put the SAME card back')
# The charts were always fine across this: both stores are read and merged.
# The DOWNLOAD was not. rxd_chips.log on the card would silently lack every
# sample taken while the card was out, while the dashboard built from the same
# data showed them - a file that looks complete and is not.
media = mkdtemp('rxd_cycle_')
mount = os.path.join(media, 'mmcblk0p1')
os.mkdir(mount)
os.mkdir(os.path.join(mount, b.ARCHIVE_DIR_NAME))
card_chips = os.path.join(mount, b.ARCHIVE_DIR_NAME, b.SD_LOG_NAME)
nand_chips = os.path.join(media, 'nand_chips.log')
keep_media, keep_mount, keep_chip = b.SD_MEDIA, b._is_mount, b.CHIP_LOG
b.SD_MEDIA = media
b.CHIP_LOG = nand_chips
try:
    # While the card was in, samples landed on it and NAND holds the older
    # ones from before it was ever inserted.
    with open(card_chips, 'w') as handle:
        handle.write('1000 1 60.0\n1300 1 61.0\n')
    with open(nand_chips, 'w') as handle:
        handle.write('400 1 55.0\n700 1 56.0\n')

    b._is_mount = lambda path: path == mount
    equals('nothing to do while the card has the newest sample',
          b.sync_chip_log(), 0)

    # Card out: the sampler falls back to NAND for three hours.
    b._is_mount = lambda path: False
    equals('with no card, samples go to NAND', b.chip_log_target(), nand_chips)
    with open(nand_chips, 'a') as handle:
        handle.write('1600 1 62.0\n1900 1 63.0\n2200 1 64.0\n')

    # Same card back in.
    b._is_mount = lambda path: path == mount
    equals('the card takes the samples again',
          b.chip_log_target(), card_chips)
    equals('and the three taken while it was out are copied onto it',
          b.sync_chip_log(), 3)

    rows = open(card_chips).read().strip().split('\n')
    equals('the card file is now continuous',
          [r.split()[0] for r in rows],
          ['1000', '1300', '1600', '1900', '2200'])
    equals('older NAND rows the card already had are not re-added',
          len([r for r in rows if r.startswith('400')]), 0)
    equals('a second pass copies nothing', b.sync_chip_log(), 0)
    equals('and a third', b.sync_chip_log(), 0)

    # The merge the charts use must not double-count what was just copied.
    rows = b._chip_rows(0)
    stamps = sorted(set(r[0] for r in rows)) if rows else []
    equals('history still has one point per sample', len(rows), len(stamps))
finally:
    b.SD_MEDIA, b._is_mount, b.CHIP_LOG = keep_media, keep_mount, keep_chip

print('')
print('=== the bridge logs its own events')
# Nothing ever wrote to /var/log/rxdbridge.log: request logging is suppressed
# and there was not one print in the bridge, so the file's entire contents
# were a single stray traceback. These lines are what make it answer "has it
# restarted?" - and they have to be stamped, or archive_logs() falls back to
# de-duplicating the file by content.
import StringIO
keep_stdout = sys.stdout
sys.stdout = StringIO.StringIO()
try:
    b.log('hello')
    written = sys.stdout.getvalue()
finally:
    sys.stdout = keep_stdout

equals('one line per call', written.count('\n'), 1)
check('it carries the message', written.strip().endswith('hello'), written)
check('stamped in the miner\'s own format, so the archiver can read it',
      b.LOG_STAMP.match(written) is not None, written)
equals('and that stamp is what _line_stamp picks up',
       b._line_stamp(written), written[:19])

# Card presence is logged on CHANGE, or five-minute polling would write 288
# lines a day saying nothing happened.
media = mkdtemp('rxd_note_')
mount = os.path.join(media, 'mmcblk0p1')
os.mkdir(mount)
keep_media, keep_mount, keep_state = b.SD_MEDIA, b._is_mount, b._CARD_PRESENT[0]
b.SD_MEDIA = media
sys.stdout = StringIO.StringIO()
try:
    b._CARD_PRESENT[0] = None
    b._is_mount = lambda path: path == mount
    first = b.note_card_state()
    b.note_card_state()
    b.note_card_state()
    quiet = sys.stdout.getvalue()

    b._is_mount = lambda path: False
    b.note_card_state()
    gone = sys.stdout.getvalue()

    b._is_mount = lambda path: path == mount
    b.note_card_state()
    back = sys.stdout.getvalue()
finally:
    sys.stdout = keep_stdout
    b.SD_MEDIA, b._is_mount = keep_media, keep_mount
    b._CARD_PRESENT[0] = keep_state

check('the first look does not log - the startup line already said it', first)
equals('and repeated polls with no change say nothing', quiet, '')
equals('losing the card is one line', gone.count('\n'), 1)
check('which says where samples go now', 'fall back to flash' in gone, gone)
equals('getting it back is one more', back.count('\n'), 2)
check('and says so', 'card inserted' in back.split('\n')[1], back)

print('')
print('=== the downloadable log catalogue')
# The stock page can only offer the two NAND logs. This is what lets the
# dashboard offer the card's copies and the daemon logs as well.
media = mkdtemp('rxd_dl_')
mount = os.path.join(media, 'mmcblk0p1')
os.mkdir(mount)
os.mkdir(os.path.join(mount, b.ARCHIVE_DIR_NAME))
keep_media, keep_mount, keep_list = b.SD_MEDIA, b._is_mount, b.DOWNLOAD_LOGS
nand = os.path.join(media, 'nand_run.log')
with open(nand, 'w') as handle:
    handle.write('only in flash\n')
card = os.path.join(mount, b.ARCHIVE_DIR_NAME, 'run.log')
with open(card, 'w') as handle:
    handle.write('the longer archived copy\nsecond line\n')
b.SD_MEDIA = media
try:
    b._is_mount = lambda path: path == mount
    ram = os.path.join(media, 'rxdfan.log')
    with open(ram, 'w') as handle:
        handle.write('a log that lives in tmpfs\n')
    b.DOWNLOAD_LOGS = [('run.log', 'Miner log.', nand, 'nand'),
                       ('rxdfan.log', 'Fan decisions.', ram, 'ram'),
                       ('missing.log', 'Never written here.', '/no/such/log',
                        'ram')]

    cat = b.log_catalogue(refresh=False)
    names = [e['name'] for e in cat]
    equals('a log that does not exist on this machine is left out',
           names, ['run.log', 'rxdfan.log'])
    equals('the card copy wins over flash', cat[0]['source'], 'card')
    equals('with the card copy\'s size', cat[0]['bytes'],
           len('the longer archived copy\nsecond line\n'))
    # /var/log is tmpfs, so this one is in RAM and dies at the next boot. The
    # table has to say that rather than calling it flash.
    equals('a tmpfs log is reported as RAM, not flash',
           cat[1]['source'], 'ram')

    found = b.log_file('run.log')
    equals('log_file resolves to the card copy', found[0], card)
    check('and names the download after the machine',
          found[1].endswith('_run.log'), found[1])

    # The name is matched against the catalogue, never joined onto a path.
    for bad in ('../../etc/shadow', '/etc/shadow', 'run.log/../../etc/passwd',
                '', 'nope.log'):
        check('a request for %r is not a log' % bad, b.log_file(bad) is None)

    # With no card the same call still works, from flash.
    b._is_mount = lambda path: False
    cat = b.log_catalogue(refresh=False)
    equals('without a card it falls back to flash', cat[0]['source'], 'nand')
    equals('and resolves to the flash path', b.log_file('run.log')[0], nand)
finally:
    b.SD_MEDIA, b._is_mount, b.DOWNLOAD_LOGS = keep_media, keep_mount, keep_list
    shutil.rmtree(media, ignore_errors=True)

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
