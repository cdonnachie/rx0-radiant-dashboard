# How the RX0 actually works

Notes gathered while building this, from a single-board RX0 running
`ICM168_08_02_1806_10107`. Written down because none of it is documented
anywhere and most of it cost a reboot to learn.

## The miner's command port

The mining process listens on **127.0.0.1:4111**, one JSON object per line.

Getters: `getchipinfo getcorestate geteeprom gethw getlocate getnet getpool
getshutdown board boardpow fan info hello log`

Writers: `sethw setlocate setnet setpool seturl reset resetfactory restart
changepass firmupdate`

`getshutdown` reads like an action but is not — it reports the thermal and
power protection counters, all zero on a healthy unit.

### Two traps

**`sethw` reports success either way.** Setting the fan needs
`{"id":"sethw","fan":{"control":true,"ratio":N},"mode":"normal"}`. With
`control:false` the port still answers `code 0` and then ignores the ratio — a
read-back showed 100, the miner having kept the fans for itself. Always read
`gethw` back.

**The port answers before the board is ready.** It accepts connections while the
chips are still in their initial work test. A write landing in that window makes
the test fail: the miner logs `The miner failed the initial test`, reports zero
chips, and does not hash until the next reboot. This is not deterministic, which
makes it look like unstable hardware rather than a self-inflicted wound. Wait
for chips to report a live PLL before writing anything.

## The board profile EEPROM

Each hash board carries an AT24C-style EEPROM at I²C address **0x57**, 49 bytes
(0x00–0x30). It is **not** on `/dev/i2c-*` — the miner bit-bangs it over GPIO.
Board 1 is **SCL 980, SDA 981** (the reverse of the argument order in the
binary; the other orientation gets no ACK). Boards 2 and 3 are 983/982 and
985/984.

```
0x00-0x01  power/voltage, big-endian, /100   -> 2.00 V
0x02-0x03  PLL clock in MHz, big-endian      -> 640
0x04-0x05  chip count, big-endian            -> 12
0x0b-0x0e  unknown, reads 101 and 7
0x30       XOR checksum of bytes 0x00-0x2f
```

A stock image from a 12-chip board:

```
00c80280000cffffffffff00650007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff24
```

**This is how the chip clock is set.** Write the MHz big-endian at 0x02–0x03,
fix the checksum, reboot — the miner reads it at startup, programs the PLLs and
ramps to it. No SPI access needed and no fighting the running miner for the bus.

`device/eeprom_write.py` does this with interlocks: it refuses unless `--expect`
matches the chip exactly, writes only changed bytes, and verifies by reading
back. Pause the miner first (`kill -STOP`) — it owns those GPIOs.

Encodings used in testing: 640 `02 80`/`24`, 645 `02 85`/`21`, 655 `02 8f`/`2b`,
660 `02 94`/`30`, 700 `02 bc`/`18`, 800 `03 20`/`85`.

## The PLL

Recovered by decompiling the miner binary (ARM Thumb).

Reference clock is 25 MHz:

```
f_out = 25 * FBDIV / (REFDIV * POSTDIV1 * POSTDIV2)
```

searched with REFDIV 1–3, POSTDIV1 1–7, POSTDIV2 ≥ POSTDIV1, FBDIV 16–0xffe,
subject to the VCO constraint 2400 ≤ 25*FBDIV/REFDIV ≤ 4800 MHz. The solver
takes the first hit in that iteration order, so a target maps deterministically
to one tuple. **Only multiples of 5 MHz are reachable.**

Encoded into three bytes:

```
b0 = FBDIV >> 4
b1 = (FBDIV << 4) & 0xff
b2 = POSTDIV1 | (POSTDIV2 << 3) | (REFDIV << 6)
```

640 MHz = 25 × 128 / (1×1×5) → FBDIV 128, VCO 3200 → `08 00 69`.

The write is a single 13-byte frame on `/dev/spidev0.0`, broadcast to every
chip, with no latch frame after it:

```
7f 55 <board> <chip> <reg> <len> <payload>
7f 55   ff      7f     d0    07   2b 00 00 00 b0 b1 b2
```

`ff` is all boards, `7f` is broadcast to all chips. The miner **ramps in 100 MHz
steps one second apart** rather than jumping straight to the target.

The live miner holds `/dev/spidev0.0` as fd 9, which is why anything writing
clocks over SPI needs the miner paused — and why going through the EEPROM
instead is so much less invasive.

## Clock behaviour

Confirmed working on one board at stock 2.00 V: **640, 645, 655, 660, 700, 800**.

A clock the board cannot run **fails safe**: the miner refuses to start rather
than hashing badly, so probing costs only a reboot cycle. The failure is graded
— some clocks program the PLL and calibrate fine and then fail the work test,
while a clock the PLL itself cannot produce never calibrates at all.

**Hashrate does not scale linearly with clock.** 800 MHz is +25% clock for about
+11% hashrate — roughly 43% efficiency, so power rises much faster than work
done. Measured pool-side over 24 hours, not from the miner's own counter.

**The miner undercounts itself.** Its `rtpow` ran about 8% below what the pool
credited over the same window. Trust pool-side numbers.

**`rtpow` is a five-minute rolling average** and reads `0G` for about six minutes
after a restart. It then climbs for a long time — 241 → 261 → 265 → 273 → 281 →
283 G across successive windows in one run. Any conclusion drawn from the first
half hour is worthless.

## Voltage droop

Chip core voltage (~370 mV, not the 2.00 V board rail) **sags measurably as the
clock rises**: avg 373.9 mV at 645–660 against 371.1 mV at 800, about 0.75%.
More switching current through the same power delivery, so more IR drop.

This is the wrong direction for stability — faster switching wants more margin
and gets less — and is likely a large part of what sets the usable ceiling. It
is also why other firmware pairs a big clock increase with a small voltage
offset.

This project does not change voltage. The board profile has one copy, and a bad
write there is a different class of risk from a clock that fails safe.

## Fan control

Stock `fanratio 0` is auto, and auto is bang-bang: fans idle until the board
heats, then full ~6000 RPM, around 13 cycles a day, swinging chip temperature by
~8 °C. A fixed 25% holds ~1160 RPM steadily.

**Temperatures quoted here are not the miner's alone.** The unit they were
measured on also has an external PWM fan blowing onto the chassis, which is the
heatsink. 70 °C board / low-60s chips at 800 MHz is what that setup gives at a
25% internal ratio — the same ratio on a bare unit will run hotter. Pick a ratio
by watching your own temperatures, not by copying a number from here. Keep any
auxiliary fan at a *fixed* speed while comparing clocks: one that ramps with
room temperature quietly varies between runs and confounds the comparison.

**The miner takes the fan back a few minutes after boot**, and keeps adjusting
it:

```
boot +3 min   rpm 1162  ratio 25   <- our setting, in force
boot +4 min   rpm 1788  ratio 34   <- miner back on its own curve
```

It does not merely clear a control flag — it recomputes the ratio for itself and
raises it as the board warms, reaching ~2190 RPM six hours in. So a one-shot
write at boot does not hold, and **a short verification window is worse than
none** because it reports success: an early version of `rxd_fanset.sh` checked
twice over 90 seconds, logged "ratio holding", and exited about two minutes
before the revert it existed to prevent.

Re-applying mid-run works and takes effect within seconds, so the fix is simply
to keep watching. `rxd_fanset.sh` polls every 60 s for the life of the run.

## The stock web UI

**It never refreshes itself.** `base.js` sets a five-minute timer, but it only
posts `post=7` and calls `login(re)` — a session check, with the data refresh
commented out beside it. The tiles sit frozen until a reload.

**`content2()` mutates the payload in place**, turning `data.rtpow` from `"270G"`
into raw H/s before later handlers see it, and parking the scaled value in
`rtpow_hash`/`rtpow_unit`.

**Five elements match `.right .content2 .panlcss`.** Appending to the jQuery set
clones your row into all five. Select with `.has('.speedcss').first()`.

**The "Fan Speed(%)" checkbox is an input, not a status readout, and is always
unchecked.** `machine.esp` ships it with no `checked` attribute and the name
`fancontrol` appears in no JavaScript at all, so nothing reflects miner state
onto it — while the ratio field beside it *is* filled from live data. Save the
form with it clear and jQuery omits it entirely, sending `control=false`, which
the miner accepts and ignores.

**`index.esp` and `login.esp` cannot be edited** — ESP recompilation fails on the
device (no compiler). That is why the viewport meta, the dashboard script tag
and the theme are injected from `base.js`, and why the themed login page ships
as a replacement `login.css`.

**The stock API has no authentication.** `POST /user/machineconfig` answers
`error:0` with no session cookie. Anything you add should not assume otherwise.

## HTTPS

The appweb the miner runs is 6.2.2 with mbedTLS linked into `libmpr.so`, and
`libappweb.so` already parses `ListenSecure` and the SSL directives. Only a
certificate was missing. The device has no openssl binary, so `make_certs.py`
issues one locally and it is installed to `/var/order/conf` — jffs2, so it
survives firmware updates, and the private key never sits inside a `.bgz`.

Mixed content matters here: a dashboard served over HTTPS cannot call a
plain-HTTP bridge, and the browser blocks it **silently**. That is why the bridge
listens on both 4112 (plain) and 4113 (TLS).
