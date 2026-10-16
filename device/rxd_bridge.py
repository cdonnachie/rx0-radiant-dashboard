#!/usr/bin/env python
"""
Radiant chip-telemetry bridge for the IceRiver RX0.

The miner exposes per-chip temp/voltage/pll on a raw TCP command port, but a
browser cannot speak raw TCP and the compiled ESP controller only registers
user/userpanel (the device has no compiler, so no endpoint can be added there).
This serves that data over HTTP so the dashboard can chart it.

Endpoints:
  /chipinfo   per-chip temp/voltage/pll, summarised per board
  /history    hashrate, board temps and fan RPM parsed out of the miner's own
              logs - the only telemetry here that survives a reboot

Deliberately read-only. Exactly three commands are ever sent to the miner port,
all getters (getchipinfo, geteeprom, getshutdown), and a caller-supplied command
is never relayed, so this cannot be used to reach the setpool/setnet/sethw
writers on the same port. The log files it reads are opened read-only.

Python 2.7 (that is what ships on the device).
"""

import json
import os
import re
import socket
import ssl
import subprocess
import threading
import time
import SocketServer
import urllib2
import urlparse
from BaseHTTPServer import BaseHTTPRequestHandler, HTTPServer

MINER_HOST = '127.0.0.1'
MINER_PORT = 4111
LISTEN_PORT = 4112
SOCK_TIMEOUT = 4.0

# The dashboard is served on both 80 and 443, and a page loaded over HTTPS
# cannot call a plain-HTTP bridge - the browser blocks it as mixed content, and
# silently: on an iPhone the Protection row, the chip charts and the clock pill
# simply never appeared, while desktop over http:// was fine. So the same
# handler is served twice, plain on 4112 and TLS on 4113, reusing the web
# server's certificate. The dashboard picks the port to match its own protocol.
TLS_PORT = 4113
TLS_CERT = '/var/order/conf/webserver.crt'
TLS_KEY = '/var/order/conf/webserver.key'

# The only commands this bridge will ever issue. getshutdown reads as if it
# were an action; it is not - it reports the protection state machine, and was
# probed on a mining unit without disturbing it.
CHIP_COMMAND = '{"id":"getchipinfo"}'
EEPROM_COMMAND = '{"id":"geteeprom"}'
PROTECT_COMMAND = '{"id":"getshutdown"}'
HW_COMMAND = '{"id":"gethw"}'
FAN_COMMAND = '{"id":"fan"}'
# The live hashrate - the same number the stock home page shows as "5 mins
# Hashrate". Its avgpow field is the whole-session average and is deliberately
# NOT used here; see recent_hashrate.
POW_COMMAND = '{"id":"boardpow"}'

# Fallback board size only. getchipinfo returns a flat list of 36 chip slots
# with no board field, and 36 is the chassis maximum rather than what is
# fitted: this RX0 carries ONE board of 12 chips, slots 1-12 reporting and
# 13-36 padding. The real split comes from the EEPROM (see board_profiles);
# this constant is used only when that is unreadable.
CHIPS_PER_BOARD = 18

# Written by the miner itself: run.log is the current boot, his.log is the
# rolling 2 MiB history behind it.
RUN_LOG = '/var/order/run.log'
HIS_LOG = '/var/order/his.log'

# Parsing 2 MiB of log on this CPU is not free and the dashboard polls on a
# timer, so a built response is reused for this long.
HISTORY_TTL = 60.0
HISTORY_DEFAULT_HOURS = 24
HISTORY_MAX_HOURS = 24 * 30
HISTORY_DEFAULT_POINTS = 500
HISTORY_MAX_POINTS = 2000

_history_cache = {}

# --- Chip history -----------------------------------------------------------
#
# The board charts replay the miner's own logs, so every browser shows the same
# day of data. Chip temperature/voltage/clock had no such source: the dashboard
# accumulated them in localStorage, which is per-browser. Opening the dashboard
# in a second browser therefore showed three nearly empty charts beside a full
# day of board history - Chrome with hours of it, Edge with three minutes.
#
# The miner logs nothing per-chip, so the bridge records it. One line per
# sample, appended here and replayed through /chiphistory. The interval matches
# the miner's own 5-minute log cadence: it is the granularity the charts draw
# at, and 288 small appends a day is gentle on the jffs2 flash.
CHIP_LOG = '/var/order/rxd_chips.log'
CHIP_SAMPLE_SECONDS = 300
CHIP_LOG_MAX = 1024 * 1024      # ~2 weeks; halved in place when it trips

# --- Overclock, the only thing here that writes ------------------------------
#
# Everything else in this bridge is read-only by design. This one endpoint is
# not, so it is fenced off deliberately:
#
#   * It is off unless /var/order/conf/rxd_oc.enable exists, written at install
#     time only when asked for. A miner that was never meant to be overclocked
#     has no endpoint to find. (The old rxd_oc.token is still honoured as the
#     same flag, so an existing install keeps working.)
#   * There is no token. There was one, and it bought nothing: the device's own
#     web API sitting beside this one answers with no session at all - verified,
#     POST /user/machineconfig returns error:0 for an unauthenticated caller and
#     will change pools, reboot or reflash on request. A secret on this door and
#     none on that one is theatre, and the cost of it was typing a 24-character
#     hex string every time you wanted to try a clock.
#   * The value is bounded to OC_MIN..OC_MAX in 5 MHz steps, because the PLL
#     solver can only reach multiples of 5 and anything outside this window is
#     not something to discover by accident.
#   * It shells out to the existing eeprom_write.py rather than reimplementing
#     the bit-bang. That tool already refuses unless --expect matches the chip
#     exactly, writes only changed bytes and verifies by reading back.
#   * Every accepted change is written to OC_LOG with the caller's address, so
#     there is a record of what asked for what even though nothing was asked to
#     prove who it was.
#
# The sequence is the one used by hand all along: pause the miner (it owns the
# GPIOs), write, resume, reboot. The clock only takes effect on the reboot,
# because the miner reads the EEPROM at startup and ramps to it itself.
OC_MIN = 600
OC_MAX = 800
OC_STEP = 5
# First is the current name; the second is the old token file, kept as a flag so
# an install made before the token went away still has its Overclock page.
OC_FLAG_FILES = ('/var/order/conf/rxd_oc.enable',
                 '/var/order/conf/rxd_oc.token')
EEPROM_READ = '/var/order/eeprom_read.py'
EEPROM_WRITE = '/var/order/eeprom_write.py'
OC_LOG = '/var/log/rxdoc.log'
OC_SCL = 980
OC_SDA = 981

# --- Fan -------------------------------------------------------------------
#
# rxd_fanset.sh owns the fan; this only reads and writes its config file and
# asks init to restart it. Nothing here talks to the fan directly, so there is
# exactly one writer and no way for the two to disagree about the setpoint.
#
# No token here either - the stock web API already lets anything on the network
# set the fan ratio with no authentication at all, so a secret on this endpoint
# would be guarding a door that is open beside it. What does protect the
# hardware is the bounds below, enforced on the way in and not configurable:
# a minimum that is actually a minimum, and a target that cannot be set to a
# temperature the board should never be asked to sit at.
FAN_CONF = '/var/order/conf/rxd_fan.conf'
FAN_SERVICE = '/etc/init.d/rxdfan'
FAN_TARGET_MIN = 40
FAN_TARGET_MAX = 85
FAN_FLOOR = 10            # the lowest 'minimum fan' anyone may configure

# --- Expected hashrate ------------------------------------------------------
#
# getcorestate reports the hash cores behind each chip - 12 per chip, 144 on
# this one-board RX0 - which is enough to say what the silicon *should* be
# producing at a given clock, and so to show the shortfall the way a Bitaxe
# does ("1.15 Th/s, expected 1.224").
#
# It reports 36 chips whatever is fitted, though: three boards' worth of slots,
# every core in all of them reading alive, including the 24 chips this machine
# does not have. Only the chips getchipinfo lists are real. See core_count.
#
# HASHES_PER_CORE_CYCLE is INFERRED, not documented. Anchored at 700 MHz
# (295 GH/s, 144 cores) it comes out at 2.93, and 3.0 is taken as the intended
# figure. 700 is not this board's fastest clock - 775 is - but it is the closest
# to clean scaling, which is what the constant should reflect. Treat the resulting
# percentage as a relative measure across clocks on one board, which is what
# it is good for; do not read a few percent either side of 100 as meaningful,
# and expect it to be wrong on a model with a different core design. It is
# settable in rxd_fan.conf's sibling below so a different board can correct it
# without a firmware rebuild.
CORE_COMMAND = '{"id":"getcorestate"}'
EXPECTED_CONF = '/var/order/conf/rxd_expected.conf'
HASHES_PER_CORE_CYCLE = 3.0

# --- Swarm ------------------------------------------------------------------
#
# One dashboard showing every RX0 on the network. The fan-out happens HERE, in
# the bridge, not in the browser - each miner fetches its peers and serves one
# aggregated answer, so the page only ever talks to its own origin.
#
# Doing it the other way round, the way the Bitaxe swarm does, would walk back
# into two bugs this project has already fixed: every miner would need CORS
# headers for every other, and an HTTPS dashboard calling a plain-HTTP peer is
# blocked as mixed content *silently* - the failure that left the iPhone with
# no chip charts and no clock pill while desktop over http:// looked perfect.
PEERS_CONF = '/var/order/conf/rxd_peers.conf'
SWARM_TIMEOUT = 4.0       # per peer; a sleeping miner must not stall the page
SWARM_MAX_PEERS = 32
SCAN_TIMEOUT = 0.4        # per host, during a subnet scan
SCAN_WORKERS = 24


# Every command this bridge may send. All getters, no setters: the fan ratio is
# written by rxd_fanset.sh and the clock by eeprom_write.py, so nothing here can
# reach sethw/setpool/setnet on the same port even if a caller asks it to.
ALLOWED_COMMANDS = (
    CHIP_COMMAND,       # per-chip temp/voltage/pll
    EEPROM_COMMAND,     # board profile
    PROTECT_COMMAND,    # protection state machine
    CORE_COMMAND,       # hash cores per chip, for the expected-hashrate figure
    HW_COMMAND,         # current fan ratio
    FAN_COMMAND,        # current fan rpm
    POW_COMMAND,        # live hashrate, for Output
)


def query_miner(command):
    """Send one of the allowed getters and return the raw reply."""
    if command not in ALLOWED_COMMANDS:
        raise ValueError('refusing to send an unlisted command')

    s = socket.create_connection((MINER_HOST, MINER_PORT), timeout=SOCK_TIMEOUT)
    try:
        s.sendall(command + '\n')
        s.settimeout(SOCK_TIMEOUT)
        chunks = []
        while True:
            d = s.recv(65536)
            if not d:
                break
            chunks.append(d)
            # Response is a single JSON object; stop once it parses.
            buf = ''.join(chunks)
            if buf.rstrip().endswith('}'):
                try:
                    json.loads(buf)
                    break
                except ValueError:
                    pass
        return ''.join(chunks)
    finally:
        try:
            s.close()
        except Exception:
            pass


def board_profiles():
    """Per-board {chipcount, power, pll} as the EEPROM has it.

    This is the only place the miner says how many boards are actually fitted
    and how many chips each one carries - getchipinfo pads to 36 slots either
    way. Best effort: an unreachable or malformed reply gives an empty list and
    the caller falls back to slicing by CHIPS_PER_BOARD.
    """
    try:
        ret = json.loads(query_miner(EEPROM_COMMAND)).get('ret', {})
    except Exception:
        return []

    profiles = []
    for i in (1, 2, 3):
        count = ret.get('chipcount%d' % i, 0)
        if not count:
            continue
        profiles.append({
            'board': i,
            'chipcount': count,
            'power': ret.get('power%d' % i, 0),
            'pll': ret.get('pll%d' % i, 0),
        })
    return profiles


def protection():
    """The miner's thermal/power protection state, or None if unreadable.

    Every counter in here reads 0 on a healthy miner, so the useful signal is
    simply whether any of them is non-zero: that means the miner is counting
    toward shutting itself down. The field names are the miner's own and are
    documented nowhere - they are passed through exactly as given, and the only
    thing interpreted here is "non-zero", so nothing claims a meaning that
    cannot be backed up.
    """
    try:
        doc = json.loads(query_miner(PROTECT_COMMAND))
    except Exception:
        return None

    ret = doc.get('ret', {})
    tripped = dict((k, v) for k, v in ret.items() if k != 'code' and v)
    avgtemp = {}
    for i in (1, 2, 3):
        value = doc.get('avgtemp%d' % i, 0)
        if value:
            avgtemp[str(i)] = value

    return {'clear': not tripped, 'tripped': tripped, 'avgtemp': avgtemp}


def split_boards(active, profiles):
    """Group reporting chips into [(board number, chips, profile)].

    Chips are handed out in slot order, as many as each board claims, so a
    second board numbered from slot 19 lands in the right bucket even though
    nothing in getchipinfo says which board a slot belongs to. If the EEPROM
    is unreadable, or its counts do not add up to what reported (a chip that
    has dropped out, say), fall back to fixed-size slices and drop any board
    that has nothing in it rather than charting a flat zero series.
    """
    chips = sorted(active, key=lambda c: c.get('no', 0))

    if profiles and sum(p['chipcount'] for p in profiles) == len(chips):
        out = []
        i = 0
        for p in profiles:
            out.append((p['board'], chips[i:i + p['chipcount']], p))
            i += p['chipcount']
        return out

    highest = max([c.get('no', 0) for c in chips] or [0])
    count = max(1, (highest + CHIPS_PER_BOARD - 1) // CHIPS_PER_BOARD)
    out = []
    for b in range(count):
        lo, hi = b * CHIPS_PER_BOARD + 1, (b + 1) * CHIPS_PER_BOARD
        subset = [c for c in chips if lo <= c.get('no', 0) <= hi]
        if subset:
            out.append((b + 1, subset, None))
    return out


def summarise(raw, profiles):
    """Reduce the 36 chip slots to min/avg/max, ignoring inactive ones.

    Unfitted slots report 0 for everything; averaging them in would drag every
    series toward zero.
    """
    doc = json.loads(raw)
    chips = doc.get('ret', {}).get('chips', [])
    active = [c for c in chips if c.get('pll') or c.get('temp') or c.get('voltage')]

    def stat(subset, key, scale=1.0):
        vals = [c.get(key, 0) * scale for c in subset if c.get(key)]
        if not vals:
            return {'min': 0, 'avg': 0, 'max': 0}
        return {
            'min': round(min(vals), 3),
            'avg': round(sum(vals) / float(len(vals)), 3),
            'max': round(max(vals), 3),
        }

    boards = []
    for number, subset, profile in split_boards(active, profiles):
        board = {
            'board': number,
            'chipcount': len(subset),
            'temp': stat(subset, 'temp'),
            'voltage': stat(subset, 'voltage', 1000.0),
            'pll': stat(subset, 'pll'),
        }
        if profile:
            # What the board is configured for, next to what it is doing: the
            # stock UI shows a frequency the chips are not actually running at.
            board['configured'] = {
                'chipcount': profile['chipcount'],
                'pll': profile['pll'],
                'power': profile['power'],
            }
        boards.append(board)

    return {
        'chipcount': len(active),
        'temp': stat(active, 'temp'),
        # volts -> millivolts, to match how the brand UI shows them
        'voltage': stat(active, 'voltage', 1000.0),
        'pll': stat(active, 'pll'),
        'boards': boards,
        'chips': [
            {'no': c.get('no'), 'temp': c.get('temp'),
             'voltage': round(c.get('voltage', 0) * 1000.0, 1),
             'pll': c.get('pll')}
            for c in active
        ],
    }


# --- history ---------------------------------------------------------------
#
# Everything above is a point-in-time reading that resets when the miner
# restarts. The miner's own log is the only record that outlives a reboot, so
# the series the dashboard cannot rebuild for itself are parsed back out of it.
#
# The lines of interest (tab separated, device clock, which runs UTC):
#   2026-10-13 22:03:02   30 mins Hashrate 269G
#   2026-10-13 22:03:02   HashBoard 1 30 mins Hashrate 270.23G
#   2026-10-13 22:03:05   Fan Speed 5498 5587.
#   2026-10-13 22:36:42   HashBoard 1 || chip 8 || MAX temp 60C
#   2026-10-13 22:36:42   HashBoard 1 || PCB temp1 || temp 63C

TS_RE = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s')
HASH_RE = re.compile(r'(?:HashBoard\s+(\d+)\s+)?\d+\s+mins?\s+Hashrate\s+([\d.]+)\s*([KMGTP])?',
                     re.I)
FAN_RE = re.compile(r'Fan\s+speed\s+(\d+)\s+(\d+)', re.I)
CHIPTEMP_RE = re.compile(r'HashBoard\s+(\d+).*chip\s+\d+.*MAX\s+temp\s+(-?\d+)', re.I)
PCBTEMP_RE = re.compile(r'HashBoard\s+(\d+).*PCB\s+temp(\d).*temp\s+(-?\d+)', re.I)

# Everything is reported in GH/s to match the rest of the dashboard.
SCALE = {'K': 1e-6, 'M': 1e-3, 'G': 1.0, 'T': 1e3, 'P': 1e6}


def _epoch(stamp):
    """'2026-10-13 22:03:02' -> epoch seconds.

    time.strptime is pure Python and this runs per interesting log line, where
    it dominated the parse; the format is fixed, so the fields are picked out
    directly and handed to C mktime instead.
    """
    return time.mktime((int(stamp[0:4]), int(stamp[5:7]), int(stamp[8:10]),
                        int(stamp[11:13]), int(stamp[14:16]), int(stamp[17:19]),
                        0, 1, -1))


def _log_lines(path):
    """The file's lines, or nothing if it is missing/unreadable."""
    try:
        f = open(path, 'rb')
    except IOError:
        return []
    try:
        return f.read().splitlines()
    finally:
        f.close()


def parse_logs(cutoff):
    """Pull the charted series out of both logs, newest cutoff onward.

    his.log holds what rolled over from previous boots and run.log the current
    one, so they are read in that order; timestamps are sorted afterwards
    because the two can overlap by a line or two around a restart.
    """
    total = {}        # epoch -> GH/s, whole miner
    boards = {}       # board -> {'hashrate'|'chiptemp'|'pcbtemp1'|'pcbtemp2': {epoch: value}}
    fans = {}         # epoch -> [fan1, fan2]

    def board_series(number, name):
        b = boards.setdefault(str(number), {})
        return b.setdefault(name, {})

    # Both files are chronological, so each is walked backwards and abandoned
    # at the first line older than the window: a one-day window out of a
    # fortnight of log then touches a fraction of the lines. The cheap
    # substring test comes before anything else because most of what is in
    # here is kernel boot spew with no timestamp at all.
    for path in (RUN_LOG, HIS_LOG):
        for line in reversed(_log_lines(path)):
            if 'Hashrate' in line:
                kind = 'hash'
            elif 'Fan' in line or 'fan' in line:
                kind = 'fan'
            elif 'temp' in line or 'Temp' in line:
                kind = 'temp'
            else:
                continue

            m = TS_RE.match(line)
            if not m:
                continue
            try:
                when = _epoch(m.group(1))
            except ValueError:
                continue
            if when < cutoff:
                break
            rest = line[m.end():]

            if kind == 'hash':
                h = HASH_RE.search(rest)
                if h:
                    value = round(float(h.group(2)) * SCALE.get((h.group(3) or 'G').upper(), 1.0), 3)
                    if h.group(1):
                        board_series(h.group(1), 'hashrate')[when] = value
                    else:
                        total[when] = value

            elif kind == 'fan':
                f = FAN_RE.search(rest)
                if f:
                    fans[when] = [int(f.group(1)), int(f.group(2))]

            else:
                c = CHIPTEMP_RE.search(rest)
                if c:
                    board_series(c.group(1), 'chiptemp')[when] = int(c.group(2))
                    continue
                p = PCBTEMP_RE.search(rest)
                if p:
                    board_series(p.group(1), 'pcbtemp' + p.group(2))[when] = int(p.group(3))

    return total, boards, fans


def _thin(items, limit):
    """Even spread of at most `limit` items, newest always kept.

    Thinning by stride rather than taking the tail, so a 30-day window still
    shows its whole shape instead of only its last hour.
    """
    if not limit or len(items) <= limit:
        return items
    step = len(items) / float(limit)
    thinned = [items[int(i * step)] for i in range(limit)]
    if thinned[-1] is not items[-1]:
        thinned[-1] = items[-1]
    return thinned


def _points(mapping, limit):
    """{epoch: value} -> [[epoch ms, value], ...], thinned to `limit` points."""
    return [[int(t * 1000), v] for t, v in _thin(sorted(mapping.items()), limit)]


def history(hours, points):
    key = (hours, points)
    cached = _history_cache.get(key)
    if cached and cached[0] > time.time():
        return cached[1]

    cutoff = time.time() - hours * 3600
    total, boards, fans = parse_logs(cutoff)

    payload = {
        'hours': hours,
        'units': {
            'hashrate': 'GH/s',
            'temp': 'C',
            'fan': 'RPM',
            't': 'epoch milliseconds, device clock (UTC)',
        },
        'source': [p for p in (HIS_LOG, RUN_LOG) if os.path.exists(p)],
        'hashrate': _points(total, points),
        'fans': [[int(t * 1000), v[0], v[1]]
                 for t, v in _thin(sorted(fans.items()), points)],
        'boards': dict(
            (number, dict((name, _points(values, points)) for name, values in series.items()))
            for number, series in boards.items()
        ),
    }

    _history_cache[key] = (time.time() + HISTORY_TTL, payload)
    return payload


def _int_arg(query, name, default, low, high):
    try:
        value = int(query.get(name, [default])[0])
    except (ValueError, TypeError):
        return default
    return max(low, min(high, value))


def chip_sample_line(payload):
    """One board per line: epoch board t_min t_avg t_max v_* p_*, space separated.

    Plain text rather than JSON so a line is ~60 bytes and the file can be
    trimmed by dropping whole lines without parsing it.
    """
    out = []
    stamp = int(time.time())
    for board in payload.get('boards', []):
        temp, volt, pll = board.get('temp', {}), board.get('voltage', {}), board.get('pll', {})
        out.append('%d %s %s %s %s %s %s %s %s %s %s' % (
            stamp, board.get('board'),
            temp.get('min', 0), temp.get('avg', 0), temp.get('max', 0),
            volt.get('min', 0), volt.get('avg', 0), volt.get('max', 0),
            pll.get('min', 0), pll.get('avg', 0), pll.get('max', 0)))
    return '\n'.join(out)


def trim_chip_log():
    """Keep the newest half when the file outgrows CHIP_LOG_MAX."""
    try:
        if os.path.getsize(CHIP_LOG) < CHIP_LOG_MAX:
            return
        with open(CHIP_LOG) as handle:
            lines = handle.readlines()
        with open(CHIP_LOG, 'w') as handle:
            handle.writelines(lines[len(lines) // 2:])
    except (IOError, OSError):
        pass


def record_chip_sample():
    try:
        payload = summarise(query_miner(CHIP_COMMAND), board_profiles())
    except Exception:
        return          # miner restarting; skip this sample rather than log junk
    line = chip_sample_line(payload)
    if not line:
        return
    try:
        with open(CHIP_LOG, 'a') as handle:
            handle.write(line + '\n')
    except IOError:
        return
    trim_chip_log()


def chip_sampler():
    """Background sampler. Never lets an error kill the thread - a missed
    sample is a gap in a chart; a dead thread is every future sample lost."""
    while True:
        try:
            record_chip_sample()
        except Exception:
            pass
        time.sleep(CHIP_SAMPLE_SECONDS)


def chip_history(hours, points):
    """Replay CHIP_LOG into the shape the dashboard's chip charts already use."""
    cutoff = time.time() - hours * 3600
    stamps = []
    boards = {}
    seen = set()

    try:
        handle = open(CHIP_LOG)
    except IOError:
        return {'timestamps': [], 'boards': {}}

    try:
        for raw in handle:
            bits = raw.split()
            if len(bits) != 11:
                continue
            try:
                when = int(bits[0])
            except ValueError:
                continue
            if when < cutoff:
                continue

            label = time.strftime('%H:%M', time.localtime(when))
            key = bits[1]
            if (when, key) in seen:
                continue
            seen.add((when, key))

            if label not in stamps:
                stamps.append(label)
            index = len(stamps) - 1

            series = boards.setdefault(key, {
                'tempMin': [], 'tempAvg': [], 'tempMax': [],
                'voltMin': [], 'voltAvg': [], 'voltMax': [],
                'pllMin': [], 'pllAvg': [], 'pllMax': [],
            })
            # A board that appears late is back-filled so every series stays
            # aligned with the shared timestamps list, same as the browser does.
            for name in series:
                while len(series[name]) < index:
                    series[name].append(0)

            values = [float(b) for b in bits[2:]]
            for name, value in zip(
                    ['tempMin', 'tempAvg', 'tempMax', 'voltMin', 'voltAvg',
                     'voltMax', 'pllMin', 'pllAvg', 'pllMax'], values):
                series[name].append(round(value, 3))
    finally:
        handle.close()

    for series in boards.values():
        for name in series:
            while len(series[name]) < len(stamps):
                series[name].append(0)

    if len(stamps) > points:
        keep = _thin(range(len(stamps)), points)
        stamps = [stamps[i] for i in keep]
        for series in boards.values():
            for name in series:
                series[name] = [series[name][i] for i in keep]

    return {'timestamps': stamps, 'boards': boards}


def oc_log(message):
    try:
        with open(OC_LOG, 'a') as handle:
            handle.write('%s  %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), message))
    except IOError:
        pass


def oc_enabled():
    """True when this miner was installed with overclocking turned on."""
    for path in OC_FLAG_FILES:
        if os.path.exists(path):
            return True
    return False


def current_clock():
    """Read the board EEPROM and return (mhz, hex_image). Miner must be paused."""
    out = subprocess.check_output(
        ['python', EEPROM_READ, str(OC_SCL), str(OC_SDA)],
        stderr=subprocess.PIPE).strip()
    image = out.split()[-1] if out else ''
    if len(image) < 8:
        raise RuntimeError('EEPROM read returned nothing usable')
    return int(image[4:8], 16), image


def miner_pid():
    out = subprocess.check_output(['pidof', 'iceriverminer']).strip()
    return out.split()[0] if out else None


def set_clock(mhz):
    """Pause the miner, rewrite the clock, resume, and reboot. Returns a note."""
    pid = miner_pid()
    if pid:
        subprocess.call(['kill', '-STOP', pid])
    try:
        before, image = current_clock()
        if before == mhz:
            return 'already set to %d MHz; nothing written, no reboot' % mhz
        subprocess.check_call(
            ['python', EEPROM_WRITE, '--mhz', str(mhz), '--expect', image],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        oc_log('clock %d -> %d MHz, rebooting' % (before, mhz))
    finally:
        # Resume even if the write failed - leaving the miner stopped would be
        # a far worse outcome than a clock that did not change.
        if pid:
            subprocess.call(['kill', '-CONT', pid])

    # Detached, and after the response has been flushed, so the browser gets an
    # answer instead of a dropped connection. /sbin/reboot is deliberate:
    # busybox reboot exits 0 and does nothing on this sysvinit box.
    subprocess.Popen(['sh', '-c', 'sleep 2; sync; /sbin/reboot'])
    return 'clock set to %d MHz; rebooting now' % mhz


# --- Config files -----------------------------------------------------------
#
# Same "key = value" shape rxd_fanset.sh already parses with sed, so the file
# stays readable and editable by hand over SSH. Anything unparseable is simply
# absent, and every caller supplies a default, so a half-written file degrades
# to stock behaviour instead of to an undefined fan speed.

def _conf_read(path):
    values = {}
    try:
        handle = open(path)
    except IOError:
        return values
    try:
        for line in handle:
            line = line.split('#', 1)[0].strip()
            if '=' not in line:
                continue
            key, _, value = line.partition('=')
            values[key.strip().lower()] = value.strip()
    finally:
        handle.close()
    return values


def _conf_int(values, key, default, low, high):
    try:
        number = int(values[key])
    except (KeyError, ValueError, TypeError):
        return default
    return default if number < low or number > high else number


def _conf_write(path, lines):
    """Write via a temporary file and rename, so an interrupted write cannot
    leave a half-parsed config behind. On jffs2 the rename is atomic, which
    matters here: the file that survives a power cut is the one the fan
    controller reads at the next boot."""
    tmp = path + '.tmp'
    handle = open(tmp, 'w')
    try:
        handle.write('\n'.join(lines) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        handle.close()
    os.rename(tmp, path)


# --- Fan --------------------------------------------------------------------

def fan_config():
    values = _conf_read(FAN_CONF)
    return {
        'mode': 'target' if values.get('mode') == 'target' else 'fixed',
        'ratio': _conf_int(values, 'ratio', 25, 0, 100),
        'target': _conf_int(values, 'target', 60, FAN_TARGET_MIN, FAN_TARGET_MAX),
        'minfan': _conf_int(values, 'minfan', 25, FAN_FLOOR, 100),
        'maxfan': _conf_int(values, 'maxfan', 100, FAN_FLOOR, 100),
    }


def write_fan_config(wanted):
    """Clamp, write, restart. Returns the configuration actually stored, which
    is not always the one asked for - the bounds win."""
    current = fan_config()
    mode = wanted.get('mode', current['mode'])
    if mode not in ('fixed', 'target'):
        raise ValueError("mode must be 'fixed' or 'target'")

    def bounded(key, low, high):
        if key not in wanted:
            return current[key]
        try:
            number = int(wanted[key])
        except (ValueError, TypeError):
            raise ValueError('%s must be a whole number' % key)
        return max(low, min(high, number))

    ratio = bounded('ratio', 0, 100)
    target = bounded('target', FAN_TARGET_MIN, FAN_TARGET_MAX)
    minfan = bounded('minfan', FAN_FLOOR, 100)
    maxfan = bounded('maxfan', FAN_FLOOR, 100)
    if minfan > maxfan:
        minfan = maxfan

    _conf_write(FAN_CONF, [
        '# Written by the Radiant dashboard. Safe to edit by hand.',
        'mode   = %s' % mode,
        'ratio  = %d' % ratio,
        'target = %d' % target,
        'minfan = %d' % minfan,
        'maxfan = %d' % maxfan,
    ])

    stored = {'mode': mode, 'ratio': ratio, 'target': target,
              'minfan': minfan, 'maxfan': maxfan}

    # The service reads its config once, at startup, so a restart is how a
    # change takes effect. It is also the only safe way to change mode: the
    # running loop holds the old setpoint in a shell variable.
    try:
        subprocess.call([FAN_SERVICE, 'restart'])
    except Exception:
        stored['warning'] = ('config written but the fan service could not be '
                             'restarted; it will pick this up at next boot')
    return stored


def _search_int(pattern, text):
    found = re.search(pattern, text)
    return int(found.group(1)) if found else None


def fan_state():
    """What the fan is doing right now, as opposed to what it was asked to do.
    Both are shown in the UI because they disagree whenever the miner has
    grabbed the fan back and the controller has not yet noticed."""
    state = {'ratio': None, 'rpm': None}
    try:
        state['ratio'] = _search_int(r'"getratio":\s*(\d+)', query_miner(HW_COMMAND))
    except Exception:
        pass
    try:
        state['rpm'] = _search_int(r'"fans":\s*\[(\d+)', query_miner(FAN_COMMAND))
    except Exception:
        pass
    return state


# --- Expected hashrate ------------------------------------------------------

def core_count(chip_nos=None):
    """Hash cores reporting alive, across the chips that actually exist.

    The fields are core0..core11 per chip and a live core reads 1, so this
    counts rather than assumes - a board with a dead core should show a lower
    expectation, not the same one.

    THE TRAP: getcorestate always reports 36 chip slots, three boards' worth,
    and marks every core in all of them alive - including the 24 chips a
    one-board RX0 does not have. Counting the lot gives 432 where the truth is
    144, which made the expected hashrate three times too large and Output read
    32% instead of 96%. So pass chip_nos, the chip numbers getchipinfo actually
    reports; without it this trusts getcorestate and will be wrong on any
    machine whose chassis is not full.
    """
    raw = query_miner(CORE_COMMAND)
    total = 0
    for block in raw.split('{"no":')[1:]:
        match = re.match(r'\s*(\d+)', block)
        if match is None:
            continue
        if chip_nos is not None and int(match.group(1)) not in chip_nos:
            continue
        total += len([value for value in re.findall(r'"core\d+":\s*(\d+)',
                                                    block)
                      if value != '0'])
    return total


def hashes_per_cycle():
    return float(_conf_read(EXPECTED_CONF).get('hashes_per_core_cycle')
                 or HASHES_PER_CORE_CYCLE)


def expected_hashrate(mhz, cores):
    """GH/s the silicon should produce at this clock, if every core retires work
    every cycle. See the constant's comment: the per-cycle figure is inferred
    from measurement, so treat this as a relative scale across clocks on one
    board rather than an absolute specification."""
    if not mhz or not cores:
        return None
    return hashes_per_cycle() * cores * mhz / 1000.0


def hashrate_value(text):
    """'320.23G' or '121G' -> GH/s as a float. None if it is not a rate."""
    found = re.match(r'\s*([\d.]+)\s*([GTMK]?)', str(text or ''))
    if not found:
        return None
    scale = {'K': 1e-6, 'M': 1e-3, '': 1.0, 'G': 1.0, 'T': 1e3}
    try:
        return float(found.group(1)) * scale.get(found.group(2).upper(), 1.0)
    except ValueError:
        return None


def live_hashrate():
    """The miner's real-time figure, which is what its own home page shows as
    "5 mins Hashrate". Returns None if the miner will not say."""
    try:
        reply = json.loads(query_miner(POW_COMMAND))
    except Exception:
        return None
    return hashrate_value((reply.get('ret') or {}).get('rtpow'))


def recent_hashrate():
    """The miner's own 30-minute figure, from the tail of its log.

    Only a fallback now. It is a TRAILING AVERAGE, so for the first half hour
    after a boot it is mostly made of the ramp: 17 minutes in, with the miner
    doing a steady 322 G, this read 156 and Output showed 46.5% of 335. That
    is arithmetically right and tells you nothing, because the numerator
    covers the last 30 minutes and the denominator is a steady-state figure.
    Compare like with like - prefer live_hashrate.

    The regex matches the per-HASHBOARD line rather than the miner-total one,
    which is why it reads ~2 G above the dashboard's "30 mins Hashrate" tile.
    """
    try:
        lines = _log_lines(RUN_LOG)
    except Exception:
        return None
    for line in reversed(lines[-400:]):
        if 'mins Hashrate' in line and 'HashBoard' in line:
            found = re.search(r'Hashrate\s+([\d.]+)G', line)
            if found:
                return float(found.group(1))
    return None


def performance():
    """Actual against expected, the shortfall a clock change is really buying
    or losing. Any part that cannot be read comes back None rather than
    guessed, because a wrong denominator here would be worse than no figure."""
    # Live first. The log figure is a 30-minute trailing average and comparing
    # it against a steady-state expectation reads as a fault during a ramp.
    actual = live_hashrate()
    window = 'live'
    if actual is None:
        actual = recent_hashrate()
        window = '30min' if actual is not None else None
    report = {'actual': actual, 'window': window, 'cores': None,
              'mhz': None, 'expected': None, 'percent': None,
              'hashesPerCoreCycle': hashes_per_cycle()}
    # The chips come first: their numbers are what tells core_count which of
    # getcorestate's 36 slots are real. Without them it counts three boards'
    # worth on a one-board machine. See core_count.
    chip_nos = None
    try:
        chips = summarise(query_miner(CHIP_COMMAND), board_profiles())
        report['mhz'] = chips.get('pll', {}).get('max')
        chip_nos = set(c['no'] for c in chips.get('chips', []) if 'no' in c)
    except Exception:
        pass
    try:
        report['cores'] = core_count(chip_nos or None)
    except Exception:
        pass

    report['expected'] = expected_hashrate(report['mhz'], report['cores'])
    if report['actual'] and report['expected']:
        report['percent'] = round(100.0 * report['actual'] / report['expected'], 1)
    return report


# --- Swarm ------------------------------------------------------------------

def peers():
    """One peer per line: an address, optionally followed by a label.

        10.0.0.42
        10.0.0.43  shed
    """
    found = []
    try:
        handle = open(PEERS_CONF)
    except IOError:
        return found
    try:
        for line in handle:
            line = line.split('#', 1)[0].strip()
            if not line:
                continue
            bits = line.split(None, 1)
            found.append({'host': bits[0],
                          'name': bits[1].strip() if len(bits) > 1 else bits[0]})
            if len(found) >= SWARM_MAX_PEERS:
                break
    finally:
        handle.close()
    return found


def write_peers(entries):
    lines = ['# One miner per line: address, then an optional name.']
    for entry in entries[:SWARM_MAX_PEERS]:
        host = str(entry.get('host', '')).strip()
        if not host or any(c.isspace() for c in host):
            continue
        name = str(entry.get('name', '')).strip()
        lines.append('%s  %s' % (host, name) if name else host)
    _conf_write(PEERS_CONF, lines)
    return peers()


def stock_panel(host):
    """The stock web UI's home-page payload for a miner at `host`.

    It answers with NO session - the stock API has no authentication at all -
    which is what lets a factory miner appear in the swarm before it has this
    firmware on it. Raises on any failure; callers decide what that means.
    """
    raw = urllib2.urlopen('http://%s/user/userpanel' % host,
                          'post=4', timeout=SWARM_TIMEOUT).read()
    data = json.loads(raw)
    return data.get('data', data)


def shares_from_panel(data):
    """Only a connected pool is counted - unused slots sit at connect:-1 with
    zeroes."""
    for pool in (data.get('pools') or []):
        if pool.get('connect') == 1:
            return {'accepted': int(pool.get('accepted') or 0),
                    'rejected': int(pool.get('rejected') or 0),
                    'pool': pool.get('addr')}
    return {'accepted': None, 'rejected': None, 'pool': None}


def local_shares():
    """Accepted and rejected, from the miner's own web API on this box."""
    try:
        return shares_from_panel(stock_panel('127.0.0.1'))
    except Exception:
        return {'accepted': None, 'rejected': None, 'pool': None}


def uptime_seconds():
    try:
        handle = open('/proc/uptime')
        try:
            return int(float(handle.read().split()[0]))
        finally:
            handle.close()
    except Exception:
        return None


def summary():
    """One compact row describing this miner. This is what peers fetch from each
    other, so it is deliberately small and every field is optional - a miner
    that is mid-reboot should still produce a row saying so, not an error."""
    # Live, not the 30-minute log average: a swarm of recently rebooted miners
    # would otherwise all read low for half an hour. See recent_hashrate.
    rate = live_hashrate()
    if rate is None:
        rate = recent_hashrate()
    row = {'name': socket.gethostname(), 'chips': None, 'mhz': None,
           'tempMax': None, 'tempAvg': None, 'boardTemp': None,
           'fanRatio': None, 'fanRpm': None, 'hashrate': rate,
           'stock': False,
           'uptime': uptime_seconds(), 'alive': False}
    try:
        chips = summarise(query_miner(CHIP_COMMAND), board_profiles())
        row['chips'] = chips.get('chipcount')
        row['mhz'] = chips.get('pll', {}).get('max')
        row['tempMax'] = chips.get('temp', {}).get('max')
        row['tempAvg'] = chips.get('temp', {}).get('avg')
        row['alive'] = bool(row['mhz'])
    except Exception:
        pass
    row.update(fan_state_as_row())
    row.update(local_shares())
    return row


def fan_state_as_row():
    state = fan_state()
    return {'fanRatio': state['ratio'], 'fanRpm': state['rpm']}


def stock_uptime(text):
    """The stock payload's runtime, 'DD:HH:MM:SS', as seconds."""
    parts = str(text or '').split(':')
    if len(parts) != 4:
        return None
    try:
        days, hours, mins, secs = [int(p) for p in parts]
    except ValueError:
        return None
    return ((days * 24 + hours) * 60 + mins) * 60 + secs


def stock_summary(host):
    """A swarm row for a peer that is NOT running this bridge.

    A factory miner can still be watched, because its web API needs no
    session. That matters when a new unit arrives: it shows up in the swarm
    as soon as it is on the network, which is also how you confirm you have
    found the right address before uploading anything to it.

    Only what the stock payload reports honestly is taken. `chips`, `mhz` and
    the chip temperatures are left None ON PURPOSE - the payload carries
    `chipnum` and `freq`, and on an RX0 both are wrong: 18 chips against 12
    fitted, and 875 MHz against a board really running 775. That is the same
    unreliability as getcorestate's 36 slots. A blank cell is better than a
    confident wrong number, and the clock especially so, since someone might
    act on it.

    intmp/outtmp are the two PCB sensors, not chip temperatures - on this
    miner they track `PCB temp1`/`PCB temp2` - so they populate boardTemp and
    leave tempMax alone.
    """
    data = stock_panel(host)
    boards = data.get('boards') or []

    rates = [hashrate_value(b.get('rtpow')) for b in boards]
    rates = [r for r in rates if r is not None]

    temps = []
    for board in boards:
        for key in ('intmp', 'outtmp'):
            value = board.get(key)
            if isinstance(value, (int, float)) and value > 0:
                temps.append(float(value))

    fans = [f for f in (data.get('fans') or []) if f]

    row = {'stock': True,
           'alive': bool(data.get('online')) and bool(data.get('powstate')),
           'hashrate': round(sum(rates), 2) if rates else None,
           'boardTemp': max(temps) if temps else None,
           'fanRpm': max(fans) if fans else None,
           'fanRatio': None,
           'chips': None, 'mhz': None, 'tempMax': None, 'tempAvg': None,
           'uptime': stock_uptime(data.get('runtime'))}
    row.update(shares_from_panel(data))
    return row


def _fetch_summary(peer, results, index):
    url = 'http://%s:%d/summary' % (peer['host'], LISTEN_PORT)
    row = {'host': peer['host'], 'name': peer['name'], 'alive': False,
           'stock': False}
    try:
        raw = urllib2.urlopen(url, timeout=SWARM_TIMEOUT).read()
        row.update(json.loads(raw))
        row['stock'] = False
    except Exception, ex:
        # Nothing on 4112. It may still be a stock miner rather than a dead
        # one, so ask its own web UI before giving up. If that fails too,
        # report the BRIDGE error - "connection refused on 4112" is the
        # useful message, not whatever the second attempt said.
        try:
            row.update(stock_summary(peer['host']))
        except Exception:
            row['error'] = str(ex)
    # The configured label wins over the peer's own hostname: it is what the
    # person typed, and it is how they will recognise the row.
    row['name'] = peer['name']
    row['host'] = peer['host']
    results[index] = row


def swarm():
    """Every configured peer, fetched in parallel. A dead miner costs
    SWARM_TIMEOUT once, not once per peer in series - with eight miners and a
    four second timeout, serial fetching would take half a minute and the page
    would look broken."""
    entries = peers()
    results = [None] * len(entries)
    threads = []
    for index, peer in enumerate(entries):
        thread = threading.Thread(target=_fetch_summary,
                                  args=(peer, results, index))
        thread.daemon = True
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join(SWARM_TIMEOUT + 1.0)

    rows = [row for row in results if row]
    total = sum(row.get('hashrate') or 0 for row in rows)
    return {'miners': rows,
            'count': len(rows),
            'alive': len([row for row in rows if row.get('alive')]),
            'hashrate': round(total, 2) if total else 0}


def _probe(host, found, lock):
    """Does this address answer like one of ours? /clock is the fingerprint:
    it is served only by this bridge and returns a tiny body, so a false
    positive would have to be another RX0 running this firmware."""
    try:
        raw = urllib2.urlopen('http://%s:%d/clock' % (host, LISTEN_PORT),
                              timeout=SCAN_TIMEOUT).read()
        data = json.loads(raw)
        if 'configured' in data and 'step' in data:
            lock.acquire()
            try:
                found.append(host)
            finally:
                lock.release()
    except Exception:
        pass


def scan(prefix):
    """Sweep one /24 for miners running this bridge. Deliberately a manual
    action rather than something that happens at boot: it is the user's network
    and the user's decision to probe 254 addresses on it."""
    if not re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}$', prefix or ''):
        raise ValueError('prefix must look like 10.0.0')

    found = []
    lock = threading.Lock()
    addresses = ['%s.%d' % (prefix, n) for n in range(1, 255)]

    while addresses:
        batch, addresses = addresses[:SCAN_WORKERS], addresses[SCAN_WORKERS:]
        threads = []
        for host in batch:
            thread = threading.Thread(target=_probe, args=(host, found, lock))
            thread.daemon = True
            thread.start()
            threads.append(thread)
        for thread in threads:
            thread.join(SCAN_TIMEOUT + 0.5)

    known = set(peer['host'] for peer in peers())
    return {'found': sorted(found),
            'new': sorted(host for host in found if host not in known)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _send(self, code, payload):
        body = json.dumps(payload)
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        # The dashboard is served from port 80; this bridge is on another
        # port, so it is a cross-origin fetch.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = urlparse.urlparse(self.path)
        path = parts.path.rstrip('/')
        query = urlparse.parse_qs(parts.query)

        if path in ('/chipinfo', ''):
            try:
                payload = summarise(query_miner(CHIP_COMMAND), board_profiles())
                # Protection is a separate query and a nice-to-have: if it
                # fails the chip data still goes out, with protection null.
                payload['protection'] = protection()
                self._send(200, payload)
            except Exception, ex:
                self._send(503, {'error': str(ex)})
            return

        if path == '/history':
            hours = _int_arg(query, 'hours', HISTORY_DEFAULT_HOURS, 1, HISTORY_MAX_HOURS)
            points = _int_arg(query, 'points', HISTORY_DEFAULT_POINTS, 10, HISTORY_MAX_POINTS)
            try:
                self._send(200, history(hours, points))
            except Exception, ex:
                self._send(503, {'error': str(ex)})
            return

        if path == '/chiphistory':
            hours = _int_arg(query, 'hours', HISTORY_DEFAULT_HOURS, 1, HISTORY_MAX_HOURS)
            points = _int_arg(query, 'points', HISTORY_DEFAULT_POINTS, 10, HISTORY_MAX_POINTS)
            try:
                self._send(200, chip_history(hours, points))
            except Exception, ex:
                self._send(503, {'error': str(ex)})
            return

        if path == '/clock':
            # Read-only: what the EEPROM holds and what the chips report.
            try:
                chips = summarise(query_miner(CHIP_COMMAND), board_profiles())
                boards = chips.get('boards', [])
                configured = None
                if boards and boards[0].get('configured'):
                    configured = boards[0]['configured'].get('pll')
                self._send(200, {
                    # What the chips are actually running, and what the EEPROM
                    # is set to. They differ while a change awaits its reboot.
                    'live': chips.get('pll', {}).get('max') or None,
                    'configured': configured,
                    'min': OC_MIN, 'max': OC_MAX, 'step': OC_STEP,
                    'enabled': oc_enabled(),
                })
            except Exception, ex:
                self._send(503, {'error': str(ex)})
            return

        if path == '/fan':
            # Configured setpoint and live state together. They differ while
            # the miner has taken the fan back, which is worth seeing.
            try:
                payload = fan_config()
                payload['live'] = fan_state()
                payload['limits'] = {'targetMin': FAN_TARGET_MIN,
                                     'targetMax': FAN_TARGET_MAX,
                                     'floor': FAN_FLOOR}
                self._send(200, payload)
            except Exception, ex:
                self._send(503, {'error': str(ex)})
            return

        if path == '/performance':
            try:
                self._send(200, performance())
            except Exception, ex:
                self._send(503, {'error': str(ex)})
            return

        if path == '/summary':
            # What peers fetch from each other. Never fails outright: a miner
            # that is mid-reboot should still return a row saying it is down.
            try:
                self._send(200, summary())
            except Exception, ex:
                self._send(200, {'alive': False, 'error': str(ex)})
            return

        if path == '/swarm':
            try:
                self._send(200, swarm())
            except Exception, ex:
                self._send(503, {'error': str(ex)})
            return

        if path == '/peers':
            try:
                self._send(200, {'peers': peers(), 'max': SWARM_MAX_PEERS})
            except Exception, ex:
                self._send(503, {'error': str(ex)})
            return

        self._send(404, {'error': 'not found'})

    def _body(self):
        length = int(self.headers.getheader('Content-Length') or 0)
        return json.loads(self.rfile.read(length)) if length else {}

    def _json_post(self):
        """True when this really is a JSON POST. See _own_origin below: without
        this check a form or text/plain body would reach the writers with no
        preflight at all, and the browser rule would protect nothing."""
        ctype = (self.headers.getheader('Content-Type') or '').split(';')[0]
        return ctype.strip().lower() == 'application/json'

    def _own_origin(self):
        """Is this browser call coming from a page the miner itself served?

        Neither writer here takes a token, so for a browser the last thing
        between a random web page you happen to have open and this miner's
        clock is the preflight. Allow the miner's own hostname and nothing
        else. The dashboard is on port 80/443 while this bridge is on 4112, so
        it is cross-origin too and still needs the headers - but it matches.

        This is a browser rule only. Anything on the LAN can still call these
        endpoints directly, exactly as it can the stock web API, which answers
        with no session at all. Keeping the miner off the open internet is the
        control that matters; this just removes the drive-by."""
        origin = self.headers.getheader('Origin')
        if not origin:
            return False
        host = urlparse.urlparse(origin).hostname
        # '//' so urlparse reads it as an authority - it strips the port and
        # the brackets round an IPv6 literal, which splitting on ':' does not.
        mine = urlparse.urlparse('//' + (self.headers.getheader('Host') or '')).hostname
        return bool(host) and host == mine

    def do_POST(self):
        path = urlparse.urlparse(self.path).path.rstrip('/')

        # Every writer is JSON-only, deliberately: a form or text/plain body is
        # a "simple request" that a browser sends with no preflight, which
        # would route straight round _own_origin. See _json_post.
        if not self._json_post():
            self._send(415, {'error': 'send application/json'})
            return

        if path == '/setfan':
            # See the FAN_* constants. The bounds are the protection,
            # and write_fan_config clamps rather than refuses so a slider that
            # overshoots still produces a sane machine.
            try:
                body = self._body()
            except (ValueError, TypeError):
                self._send(400, {'error': 'malformed request'})
                return
            try:
                self._send(200, {'ok': True, 'fan': write_fan_config(body)})
            except ValueError, ex:
                self._send(400, {'error': str(ex)})
            except Exception, ex:
                self._send(500, {'error': str(ex)})
            return

        if path == '/peers':
            try:
                body = self._body()
            except (ValueError, TypeError):
                self._send(400, {'error': 'malformed request'})
                return
            entries = body.get('peers')
            if not isinstance(entries, list):
                self._send(400, {'error': 'peers must be a list'})
                return
            try:
                self._send(200, {'ok': True, 'peers': write_peers(entries)})
            except Exception, ex:
                self._send(500, {'error': str(ex)})
            return

        if path == '/scan':
            try:
                body = self._body()
            except (ValueError, TypeError):
                self._send(400, {'error': 'malformed request'})
                return
            try:
                self._send(200, scan(str(body.get('prefix', ''))))
            except ValueError, ex:
                self._send(400, {'error': str(ex)})
            except Exception, ex:
                self._send(500, {'error': str(ex)})
            return

        if path != '/setclock':
            self._send(404, {'error': 'not found'})
            return

        if not oc_enabled():
            self._send(503, {'error': 'overclocking is not enabled on this miner'})
            return

        try:
            length = int(self.headers.getheader('Content-Length') or 0)
            body = json.loads(self.rfile.read(length)) if length else {}
        except (ValueError, TypeError):
            self._send(400, {'error': 'malformed request'})
            return

        try:
            mhz = int(body.get('mhz'))
        except (ValueError, TypeError):
            self._send(400, {'error': 'mhz must be a number'})
            return

        if mhz < OC_MIN or mhz > OC_MAX or mhz % OC_STEP:
            self._send(400, {'error': 'mhz must be %d-%d in steps of %d'
                                      % (OC_MIN, OC_MAX, OC_STEP)})
            return

        # Nothing had to prove who it was, so at least record where it came
        # from, before the write rather than after - a reboot follows it.
        oc_log('/setclock %d MHz from %s' % (mhz, self.client_address[0]))
        try:
            note = set_clock(mhz)
        except Exception, ex:
            oc_log('FAILED setting %d MHz: %s' % (mhz, ex))
            self._send(500, {'error': str(ex)})
            return

        self._send(200, {'ok': True, 'mhz': mhz, 'message': note})

    def do_OPTIONS(self):
        # A preflight only ever precedes a write here, so this is the one place
        # worth being strict: a page from anywhere but this miner is refused
        # the permission and the POST never leaves the browser.
        origin = self.headers.getheader('Origin')
        if not self._own_origin():
            self.send_response(403)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the device's syslog quiet


class Server(SocketServer.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve_tls():
    """TLS copy of the same handler. Missing or unreadable certs are not fatal:
    the plain listener still serves, so http:// clients keep working."""
    if not (os.path.exists(TLS_CERT) and os.path.exists(TLS_KEY)):
        return None
    try:
        server = Server(('0.0.0.0', TLS_PORT), Handler)
        server.socket = ssl.wrap_socket(
            server.socket, certfile=TLS_CERT, keyfile=TLS_KEY, server_side=True)
    except Exception:
        return None
    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()
    return server


if __name__ == '__main__':
    serve_tls()
    sampler = threading.Thread(target=chip_sampler)
    sampler.daemon = True
    sampler.start()
    Server(('0.0.0.0', LISTEN_PORT), Handler).serve_forever()
