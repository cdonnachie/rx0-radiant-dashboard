#!/usr/bin/env python
"""
Read the hash board's profile EEPROM. READ ONLY - this never drives a line high
and never writes to the device.

The board profile (voltage calibration, chip clock, chip count) lives in an
AT24C-style EEPROM at I2C address 0x57, one per board. It is not on /dev/i2c-*
(the SoC has two real I2C buses, and this is on neither): the miner bit-bangs
it over two GPIOs, which is what this reproduces.

Pin numbers come from the miner's own read routine (FUN_0014d404's last two
arguments), which passes them as 981/980 for board 1 - but SCL is 980 and SDA
is 981, the reverse of that argument order. The other orientation gets no ACK
at all. Boards 2 and 3 are SCL 982/984, SDA 983/985, and on a one-board RX0
neither answers.

Open-drain is emulated the way I2C requires: a line is pulled low by making it
an output driving 0, and released by making it an input so the bus pull-up
raises it. Nothing is ever driven high, so if another master is active the
worst case is a corrupt read, not a bus fight.

The miner owns these pins but only touches them for the EEPROM at startup and
for the two PCB temperature sensors every few minutes, so a read while it is
running does work - the risk is a collision corrupting one reading for one of
us, not a hang. Stop or SIGSTOP it if you need the read to be certain.

Note that restoring a pin by direction alone turns an output that was driving
high into one driving low. Nothing here has been seen parked high, so this
restores direction only; a caller that cares should save the value too.

Python 2.7 (that is what ships on the device).
"""

import sys
import time

GPIO_DIR = '/sys/class/gpio'
SETTLE = 0.0002          # 200us; sysfs writes are slower than this anyway
EEPROM_ADDR = 0x57
LENGTH = 0x31            # 49 bytes - what the miner reads


def _write(path, value):
    f = open(path, 'w')
    try:
        f.write(value)
    finally:
        f.close()


def export(pin):
    try:
        _write(GPIO_DIR + '/export', str(pin))
    except IOError:
        pass     # already exported, which is the normal case here


def release(pin):
    """Let the pull-up take the line high."""
    _write('%s/gpio%d/direction' % (GPIO_DIR, pin), 'in')
    time.sleep(SETTLE)


def pull_low(pin):
    """Drive the line low. 'low' sets direction and value in one write."""
    _write('%s/gpio%d/direction' % (GPIO_DIR, pin), 'low')
    time.sleep(SETTLE)


def read_pin(pin):
    f = open('%s/gpio%d/value' % (GPIO_DIR, pin))
    try:
        return int(f.read().strip())
    finally:
        f.close()


def direction_of(pin):
    f = open('%s/gpio%d/direction' % (GPIO_DIR, pin))
    try:
        return f.read().strip()
    finally:
        f.close()


class BitBangI2C(object):
    def __init__(self, scl, sda):
        self.scl, self.sda = scl, sda

    def start(self):
        release(self.sda)
        release(self.scl)
        pull_low(self.sda)
        pull_low(self.scl)

    def stop(self):
        pull_low(self.sda)
        release(self.scl)
        release(self.sda)

    def write_bit(self, bit):
        if bit:
            release(self.sda)
        else:
            pull_low(self.sda)
        release(self.scl)
        pull_low(self.scl)

    def read_bit(self):
        release(self.sda)
        release(self.scl)
        bit = read_pin(self.sda)
        pull_low(self.scl)
        return bit

    def write_byte(self, value):
        for i in range(8):
            self.write_bit((value >> (7 - i)) & 1)
        return self.read_bit() == 0          # True when the slave ACKed

    def read_byte(self, ack):
        value = 0
        for _ in range(8):
            value = (value << 1) | self.read_bit()
        self.write_bit(0 if ack else 1)
        return value


def read_eeprom(scl, sda, offset=0, length=LENGTH):
    bus = BitBangI2C(scl, sda)

    bus.start()
    if not bus.write_byte(EEPROM_ADDR << 1):
        bus.stop()
        return None, 'no ACK for the write address - wrong pins or no device'
    if not bus.write_byte(offset & 0xff):
        bus.stop()
        return None, 'no ACK for the offset byte'

    bus.start()                               # repeated start for the read
    if not bus.write_byte((EEPROM_ADDR << 1) | 1):
        bus.stop()
        return None, 'no ACK for the read address'

    data = bytearray()
    for i in range(length):
        data.append(bus.read_byte(ack=(i != length - 1)))
    bus.stop()
    return data, None


def main():
    # Board 1. These defaults used to be 981/980, copied from the argument
    # order in the binary, and a bare `python eeprom_read.py` therefore always
    # failed with "no ACK" - every real caller passes 980/981 explicitly.
    scl = int(sys.argv[1]) if len(sys.argv) > 1 else 980
    sda = int(sys.argv[2]) if len(sys.argv) > 2 else 981

    for pin in (scl, sda):
        export(pin)

    # Remember exactly how the miner left these lines, so they can be put back.
    before = dict((p, direction_of(p)) for p in (scl, sda))
    sys.stderr.write('pin state before: %r\n' % before)

    try:
        data, err = read_eeprom(scl, sda)
    finally:
        # Restore. 'low' is how an output-driving-0 was found; anything else
        # goes back to input.
        for pin in (scl, sda):
            if before[pin] == 'out':
                pull_low(pin)
            else:
                release(pin)
        sys.stderr.write('pin state after: %r\n' %
                         dict((p, direction_of(p)) for p in (scl, sda)))

    if err:
        sys.stderr.write('FAILED: %s\n' % err)
        return 1

    print(''.join('%02x' % b for b in data))
    return 0


if __name__ == '__main__':
    sys.exit(main())
