#!/usr/bin/env python
"""
Set the hash board's chip clock by editing its profile EEPROM.

The clock the miner ramps to lives at offset 0x02-0x03 of the board EEPROM as
big-endian MHz, and offset 0x30 is an XOR checksum of everything before it.
Changing the clock therefore means writing the frequency bytes AND fixing the
checksum - two or three bytes, nothing else.

Doing it here rather than over SPI means the miner's own startup code performs
the actual clock programming: its ramp, its framing, its calibration. Nothing
takes the SPI bus away from a running miner.

Interlocks, because this writes to the only copy of the board's identity:
  * --expect must match the EEPROM's current contents exactly, so a surprise
    (wrong board, wrong pins, an image that already changed) aborts untouched.
  * Only the offsets implied by --mhz are written. Voltage (0x00-0x01) and chip
    count (0x04-0x05) are never touched.
  * Every byte is read back and verified before the script reports success.

The miner must be stopped or SIGSTOPped first - it owns these pins.

Usage:
  python eeprom_write.py --mhz 700 --expect <98-hex-chars> [--scl 980] [--sda 981]
  python eeprom_write.py --restore <98-hex-chars> --expect <98-hex-chars>

Python 2.7 (that is what ships on the device).
"""

import os
import sys
import time

# Import the reader from wherever this script itself lives - these two belong
# in /var/order (jffs2), not /var/volatile/tmp, which is tmpfs and empties on
# every reboot. Losing the restore tool right after a reboot is exactly when
# it is needed.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eeprom_read import (BitBangI2C, EEPROM_ADDR, LENGTH, export, read_eeprom,
                         direction_of, pull_low, release)

WRITE_CYCLE = 0.02        # AT24C tWR is ~5ms; 20ms is unhurried
PLL_OFFSET = 0x02         # big-endian MHz
CSUM_OFFSET = 0x30        # XOR of 0x00..0x2f


def checksum(body):
    value = 0
    for b in body:
        value ^= b
    return value


def write_byte_at(bus, offset, value):
    bus.start()
    if not bus.write_byte(EEPROM_ADDR << 1):
        bus.stop()
        return 'no ACK for write address'
    if not bus.write_byte(offset & 0xff):
        bus.stop()
        return 'no ACK for offset 0x%02x' % offset
    if not bus.write_byte(value & 0xff):
        bus.stop()
        return 'no ACK for data byte'
    bus.stop()

    # The chip is busy writing and NACKs everything until it is done; poll
    # rather than guessing, with the sleep as a backstop.
    time.sleep(WRITE_CYCLE)
    for _ in range(50):
        bus.start()
        acked = bus.write_byte(EEPROM_ADDR << 1)
        bus.stop()
        if acked:
            return None
        time.sleep(0.005)
    return 'chip still busy after write'


def main():
    args = sys.argv[1:]
    def opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default

    scl = int(opt('--scl', '980'))
    sda = int(opt('--sda', '981'))
    expect = opt('--expect')
    mhz = opt('--mhz')
    restore = opt('--restore')

    if not expect or (not mhz and not restore):
        sys.stderr.write(__doc__)
        return 2

    for pin in (scl, sda):
        export(pin)
    before = dict((p, direction_of(p)) for p in (scl, sda))

    try:
        current, err = read_eeprom(scl, sda)
        if err:
            sys.stderr.write('read failed: %s\n' % err)
            return 1
        current_hex = ''.join('%02x' % b for b in current)

        if current_hex != expect.lower():
            sys.stderr.write('ABORT - EEPROM does not match --expect\n')
            sys.stderr.write('  on chip: %s\n  expected: %s\n' % (current_hex, expect.lower()))
            return 1

        if restore:
            target = bytearray.fromhex(restore)
        else:
            target = bytearray(current)
            value = int(mhz)
            if value < 100 or value > 1500:
                sys.stderr.write('refusing %d MHz - outside 100-1500\n' % value)
                return 1
            target[PLL_OFFSET] = (value >> 8) & 0xff
            target[PLL_OFFSET + 1] = value & 0xff
            target[CSUM_OFFSET] = checksum(target[:CSUM_OFFSET])

        changes = [(i, current[i], target[i]) for i in range(LENGTH) if current[i] != target[i]]
        if not changes:
            print('nothing to do - EEPROM already holds the requested value')
            return 0

        for off, old, new in changes:
            sys.stderr.write('offset 0x%02x: %02x -> %02x\n' % (off, old, new))

        bus = BitBangI2C(scl, sda)
        for off, _, new in changes:
            err = write_byte_at(bus, off, new)
            if err:
                sys.stderr.write('WRITE FAILED at 0x%02x: %s\n' % (off, err))
                return 1

        after, err = read_eeprom(scl, sda)
        if err:
            sys.stderr.write('verify read failed: %s\n' % err)
            return 1
        after_hex = ''.join('%02x' % b for b in after)
        print(after_hex)
        if after_hex != ''.join('%02x' % b for b in target):
            sys.stderr.write('VERIFY MISMATCH - the chip did not take the write\n')
            return 1
        sys.stderr.write('verified: PLL now %d MHz, checksum %02x\n' %
                         (after[PLL_OFFSET] * 256 + after[PLL_OFFSET + 1], after[CSUM_OFFSET]))
        return 0
    finally:
        for pin in (scl, sda):
            if before[pin] == 'out':
                pull_low(pin)
            else:
                release(pin)


if __name__ == '__main__':
    sys.exit(main())
