#!/bin/sh
#
# Hold the fan where it should be, for as long as the miner runs.
#
# Two modes, both resident:
#
#   fixed   - hold one ratio, forever. What this script has always done.
#   target  - hold a chip TEMPERATURE, by moving the ratio.
#
# The miner's fan ratio is process state, not configuration: nothing on the
# filesystem holds it, and every boot comes back at 0, which is the stock
# auto mode. Auto is bang-bang - fans off until the board heats up, then full
# speed, around 13 cycles a day, swinging chip temperature by ~8 C.
#
# Both modes exist because a fixed ratio is only correct for one ambient. 25%
# in a cool room is a different operating point from 25% in a warm one, which
# makes every long comparison quietly dependent on the weather. Target mode
# holds the thing you actually care about and lets the ratio move.
#
# Setting the ratio once is not enough - the miner takes the fan back a few
# minutes after boot - so this stays resident and puts it back whenever that
# happens. See the comment above the watch loop for the measurements.
#
# Config lives in /var/order/conf/rxd_fan.conf (jffs2, survives updates):
#
#   ratio  = 25        fixed mode: the ratio to hold
#   mode   = fixed     'fixed' or 'target'
#   target = 60        target mode: chip temperature in C
#   minfan = 25        target mode: never go below this ratio
#   maxfan = 100       target mode: never go above this ratio
#
# mode defaults to fixed, so a config written before target mode existed keeps
# behaving exactly as it did. Change it there and either reboot or restart the
# service - no rebuild.
#
# The write itself is the same request the stock Mining Settings page makes,
# with the same fields; it is just made again, and again.

CONF=/var/order/conf/rxd_fan.conf
LOG=/var/log/rxdfan.log
MINER_PORT=4111
DEFAULT_RATIO=25
POLL=60          # seconds between checks, once the miner is up

# --- control constants, target mode ----------------------------------------
#
# These are deliberately sluggish. The failure we are replacing is an
# oscillation, so a controller that chases its own tail would be no better
# than the stock curve it exists to avoid. The board's thermal time constant
# is minutes, which is why POLL is 60s and not 5s: polling faster does not
# make the board respond faster, it only feeds measurement noise into the
# loop and produces ratio chatter.
GAIN=2           # percent of ratio per degree of error
DEADBAND=2       # degrees: inside this, do not touch the ratio at all
MAX_UP=10        # largest single step upward (getting hotter)
MAX_DOWN=3       # largest single step downward (getting cooler)
PANIC_MARGIN=15  # degrees over target that means stop being clever
FAIL_LIMIT=5     # consecutive failed temperature reads before failing safe
FAILSAFE=60      # ratio to hold when the temperature is unknown

# Up fast, down slow, on purpose. Running three degrees cooler than asked
# costs a little fan noise. Running ten degrees hotter than asked costs
# silicon, and the recovery takes minutes because the heat is already in the
# heatsink by the time the sensor shows it.
#
# Simulated against a first-order thermal model before it was ever allowed near
# the hardware, which is where these numbers come from. Behaviour to expect:
#
#   bare unit, 95C unaided, target 60   settles in ~15 polls at 67% fan
#   same board, target 75               settles in ~23 polls at 37% fan
#   chassis fan fitted, target 60       settles in ~6 polls at 53% fan
#   ambient steps up 10C mid-run        recovers in ~12 polls, no overshoot
#
# None of them oscillate, which is the only property that actually matters -
# an oscillating controller would be the stock curve with extra steps. The
# cost of that is settling measured in tens of minutes, and a cold start can
# undershoot the target by ~10C on the way down because MAX_DOWN deliberately
# unwinds a panic slowly. Undershoot is cold, and cold is free.

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG"
}

# --- configuration ----------------------------------------------------------
#
# Every value is read through this, which returns nothing unless the value is
# present AND is a plain integer. Callers then fall back to their default, so
# a corrupt or half-written config degrades to the old fixed behaviour rather
# than to an unbounded fan setting.
conf_int() {
    [ -f "$CONF" ] || return 0
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\([0-9]\{1,3\}\).*/\1/p" "$CONF" | head -1
}

in_range() {   # value lo hi
    [ -n "$1" ] && [ "$1" -ge "$2" ] && [ "$1" -le "$3" ] 2>/dev/null
}

MODE=fixed
if [ -f "$CONF" ]; then
    VALUE=$(sed -n 's/^[[:space:]]*mode[[:space:]]*=[[:space:]]*\([a-z]*\).*/\1/p' "$CONF" | head -1)
    [ "$VALUE" = "target" ] && MODE=target
else
    log "no $CONF, using default ratio $DEFAULT_RATIO"
fi

RATIO=$(conf_int ratio)
in_range "$RATIO" 0 100 || {
    [ -f "$CONF" ] && [ -n "$RATIO" ] && log "ignoring unusable ratio in $CONF"
    RATIO=$DEFAULT_RATIO
}

TARGET=$(conf_int target)
MINFAN=$(conf_int minfan)
MAXFAN=$(conf_int maxfan)
in_range "$TARGET" 30 90  || TARGET=60
in_range "$MINFAN" 0 100  || MINFAN=25
in_range "$MAXFAN" 0 100  || MAXFAN=100
[ "$MINFAN" -gt "$MAXFAN" ] && MINFAN=$MAXFAN

# In target mode the ratio is an output, not a setting. Start from the
# configured fixed ratio (a reasonable guess at the answer) but clamp it into
# the allowed band so the first write is already legal.
if [ "$MODE" = target ]; then
    [ "$RATIO" -lt "$MINFAN" ] && RATIO=$MINFAN
    [ "$RATIO" -gt "$MAXFAN" ] && RATIO=$MAXFAN
fi

# The miner opens its command port a good while after init runs, and it will
# not accept a hardware setting before the boards are calibrated. Wait for it
# rather than firing into a closed socket.
i=0
while [ $i -lt 60 ]; do
    if python -c "import socket,sys
try:
    s=socket.create_connection(('127.0.0.1',$MINER_PORT),timeout=3)
    s.sendall('{\"id\":\"gethw\"}\n')
    sys.exit(0 if s.recv(512) else 1)
except Exception:
    sys.exit(1)" 2>/dev/null; then
        break
    fi
    i=$((i + 1))
    sleep 5
done

if [ $i -ge 60 ]; then
    log "miner command port never answered; fan ratio left at stock"
    exit 1
fi

# An open command port is NOT permission to write to it. The port answers
# while the chips are still in their initial work test, and a sethw landing in
# that window makes the test fail: the miner logs "The miner failed the initial
# test", reports zero chips and does not hash until the next reboot.
#
# This was self-inflicted and measured on 2026-10-14. An earlier version of
# this script started writing as soon as the port answered, and took out two
# consecutive boots that way (a clock that had run fine minutes earlier failed
# twice with this running, then came up first try with the service disabled).
# It was briefly mistaken for the chips being unstable at that clock.
#
# So wait for proof the board is past the test and actually working: chips
# reporting a live PLL. There is deliberately no timeout. If the board never
# comes up there is nothing to set a fan speed for, and the one thing this
# script must never do is poke the miner while it is failing to start.
wait_for_chips() {
    python -c "import socket, re, time
while True:
    try:
        s = socket.create_connection(('127.0.0.1', $MINER_PORT), timeout=8)
        s.sendall('{\"id\":\"getchipinfo\"}\n')
        body = s.recv(65536)
        s.close()
        if [p for p in re.findall(r'\"pll\":\s*(\d+)', body) if int(p) > 0]:
            break
    except Exception:
        pass
    time.sleep(10)" 2>/dev/null
}

log "command port open; waiting for the board to finish its initial test"
wait_for_chips
log "board is up and hashing; safe to set the fan"

# Setting this once at boot does not hold, and the miner takes it back LATER
# than a short check will notice. Measured on 2026-10-14:
#
#   boot +3 min   rpm 1162  ratio 25   <- our setting, in force
#   boot +4 min   rpm 1788  ratio 34   <- miner back on its own curve
#
# An earlier version of this script exited once the ratio read back correctly
# on two consecutive passes - about 60-90 seconds in - and so always declared
# success roughly two minutes before the revert it existed to prevent. The fan
# then spent the whole run on the stock auto curve (2190 rpm six hours in),
# while gethw kept reporting whatever ratio the miner had most recently
# computed for itself, which drifts upward as the board warms.
#
# So this does not stop watching. It polls for as long as the miner runs and
# re-applies whenever the ratio has moved off target. A correction is one tiny
# JSON exchange on a local socket; the poll in between is the same. Re-applying
# mid-run works and takes effect immediately (verified: ratio 34 -> 25, rpm
# 1788 -> 1162 within 20 seconds).
#
# control:true is required: the same ratio sent with control:false reads back
# as 100, the miner having kept control for itself.
read_ratio() {
    python -c "import socket, re
try:
    s = socket.create_connection(('127.0.0.1', $MINER_PORT), timeout=8)
    s.sendall('{\"id\":\"gethw\"}\n')
    m = re.search(r'\"getratio\":\s*(\d+)', s.recv(512))
    s.close()
    print(m.group(1) if m else 'x')
except Exception:
    print('x')" 2>/dev/null
}

apply_ratio() {
    python -c "import socket
s = socket.create_connection(('127.0.0.1', $MINER_PORT), timeout=8)
s.sendall('{\"id\":\"sethw\", \"fan\":{\"control\":true, \"ratio\":$RATIO}, \"mode\":\"normal\"}\n')
print(s.recv(512).strip())
s.close()" 2>&1
}

read_rpm() {
    python -c "import socket, re
try:
    s = socket.create_connection(('127.0.0.1', $MINER_PORT), timeout=8)
    s.sendall('{\"id\":\"fan\"}\n')
    m = re.search(r'\"fans\":\s*\[(\d+)', s.recv(512))
    s.close()
    print(m.group(1) if m else 'x')
except Exception:
    print('x')" 2>/dev/null
}

# Hottest chip, not the average. The average hides a single hot die, and the
# die that fails first is the hottest one. Chips with no PLL are skipped:
# a slot that is not running reports a temperature that means nothing, and on
# this 12-chip board slots 13-36 are padding that would otherwise drag a
# maximum around.
read_max_temp() {
    python -c "import socket, re
try:
    s = socket.create_connection(('127.0.0.1', $MINER_PORT), timeout=8)
    s.sendall('{\"id\":\"getchipinfo\"}\n')
    body = s.recv(65536)
    s.close()
    live = [int(t) for t, p in
            re.findall(r'\"temp\":\s*(-?\d+).*?\"pll\":\s*(\d+)', body)
            if int(p) > 0 and int(t) > 0]
    print(max(live) if live else 'x')
except Exception:
    print('x')" 2>/dev/null
}

# --- the controller ---------------------------------------------------------
#
# Adjusts RATIO - our setpoint - from the chip temperature. It deliberately
# does NOT look at what the miner currently has the fan set to: that number
# drifts because the miner keeps overwriting it, and feeding it back in would
# let the miner's own curve leak into ours. The watch loop below is what
# reconciles the two.
control() {
    TEMP=$(read_max_temp)

    if [ "$TEMP" = "x" ]; then
        tempfails=$((tempfails + 1))
        if [ "$tempfails" -ge "$FAIL_LIMIT" ]; then
            # Unknown temperature for several minutes. Hold a ratio that is
            # safe at any temperature rather than whatever we last computed -
            # the one thing we must not do is sit at the floor while the board
            # cooks because the sensor went quiet.
            SAFE=$FAILSAFE
            [ "$SAFE" -lt "$MINFAN" ] && SAFE=$MINFAN
            [ "$SAFE" -gt "$MAXFAN" ] && SAFE=$MAXFAN
            if [ "$RATIO" != "$SAFE" ]; then
                RATIO=$SAFE
                log "temperature unreadable for $tempfails polls; failing safe to ${RATIO}%"
            fi
        fi
        return
    fi
    tempfails=0

    ERROR=$((TEMP - TARGET))

    # Far too hot: skip the proportional response entirely and go to the top
    # of the allowed band. This is the one case where overshooting the fan is
    # unambiguously the right answer.
    if [ "$ERROR" -ge "$PANIC_MARGIN" ]; then
        if [ "$RATIO" != "$MAXFAN" ]; then
            RATIO=$MAXFAN
            log "chip max ${TEMP}C is ${ERROR}C over target; fan to ${RATIO}%"
        fi
        return
    fi

    # Close enough. Doing nothing here is what stops the loop hunting.
    if [ "$ERROR" -le "$DEADBAND" ] && [ "$ERROR" -ge "-$DEADBAND" ]; then
        return
    fi

    DELTA=$((ERROR * GAIN))
    [ "$DELTA" -gt "$MAX_UP" ] && DELTA=$MAX_UP
    [ "$DELTA" -lt "-$MAX_DOWN" ] && DELTA=-$MAX_DOWN

    NEW=$((RATIO + DELTA))
    [ "$NEW" -lt "$MINFAN" ] && NEW=$MINFAN
    [ "$NEW" -gt "$MAXFAN" ] && NEW=$MAXFAN
    [ "$NEW" = "$RATIO" ] && return

    RATIO=$NEW
}

# Log on transitions only. A line every $POLL seconds forever would otherwise
# fill /var/log with identical entries, and the interesting signal is how often
# the miner fights back, not each individual poll.
if [ "$MODE" = target ]; then
    log "watching; holding chips at ${TARGET}C with the fan between ${MINFAN}% and ${MAXFAN}%"
else
    log "watching; holding fan at ${RATIO}%"
fi

corrections=0
tempfails=0
last_state=""
last_ratio=$RATIO
saturated=""

while :; do
    if [ "$MODE" = target ]; then
        control

        # Apply our own change immediately rather than letting the watch loop
        # below notice it. That loop reports a mismatch as "the miner moved
        # the ratio", which would be exactly backwards here, and the log is
        # the only way to tell a controller that is working from one that is
        # fighting the miner every minute.
        if [ "$RATIO" != "$last_ratio" ]; then
            RESULT=$(apply_ratio)
            log "chip max ${TEMP}C vs target ${TARGET}C: fan ${last_ratio}% -> ${RATIO}% -> $RESULT"
            last_ratio=$RATIO
            last_state=held
            sleep $POLL
            continue
        fi

        # Say so once if the target simply cannot be reached. On a unit with
        # an external fan on the chassis the internal fan may have little
        # authority left, and sitting silently at the floor looks identical to
        # working correctly.
        if [ "$TEMP" != "x" ]; then
            if [ "$RATIO" = "$MAXFAN" ] && [ "$((TEMP - TARGET))" -gt "$DEADBAND" ]; then
                [ "$saturated" = hot ] || log "fan at maximum and still ${TEMP}C: target ${TARGET}C is out of reach"
                saturated=hot
            elif [ "$RATIO" = "$MINFAN" ] && [ "$((TARGET - TEMP))" -gt "$DEADBAND" ]; then
                [ "$saturated" = cold ] || log "fan at minimum and only ${TEMP}C: cooling to spare, target ${TARGET}C never reached"
                saturated=cold
            else
                saturated=""
            fi
        fi
    fi

    CURRENT=$(read_ratio)

    if [ "$CURRENT" = "$RATIO" ]; then
        if [ "$last_state" != "held" ]; then
            if [ "$MODE" = target ]; then
                log "fan ${RATIO}% in force (rpm $(read_rpm), chip max ${TEMP}C)"
            else
                log "ratio $RATIO in force (rpm $(read_rpm))"
            fi
            last_state=held
        fi
    elif [ "$CURRENT" = "x" ]; then
        # Miner restarting or port busy - say so once, then keep trying.
        if [ "$last_state" != "down" ]; then
            log "miner command port not answering; will keep retrying"
            last_state=down
        fi
    else
        corrections=$((corrections + 1))
        RESULT=$(apply_ratio)
        log "correction $corrections: miner moved ratio to $CURRENT, set back to $RATIO -> $RESULT"
        last_state=corrected
    fi

    sleep $POLL
done
