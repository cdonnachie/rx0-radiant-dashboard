#!/usr/bin/env python3
"""Install the Radiant RXD dashboard and tooling onto an IceRiver RX0.

Run this on your own machine, pointed at the miner. It needs SSH access to the
miner and nothing installed on the miner itself.

    pip install paramiko cryptography
    python install_rxd.py --host 10.0.0.42

What it puts on the miner:

  * the Radiant web dashboard, built from YOUR miner's own stock package so it
    matches whatever firmware version you are running
  * a read-only telemetry bridge (per-chip temp/voltage/clock, protection
    state, hashrate history replayed from the miner's logs)
  * a fan service that holds a fixed fan speed instead of the stock bang-bang
    auto curve
  * HTTPS for the web UI, with a local CA you install once

What it does NOT do unless you ask: overclocking. Pass --enable-oc to turn the
Overclock page on. Without it the page reports that overclocking is disabled and
the write endpoint refuses everything. Changing the chip clock rewrites the hash
board's EEPROM, so it is opt-in.

Nothing here touches the EEPROM, the chip clock, or the board voltage.

Files you can edit afterwards, all in /var/order/conf:

  rxd_fan.conf       fan mode, ratio, target and limits (--fan, --fan-target,
                     --fan-min, --fan-max). The fan service reads this once at
                     startup: the Fan page restarts it for you, but after a
                     hand edit run /etc/init.d/rxdfan restart.
  rxd_peers.conf     the Swarm page's miner list, read per request
  rxd_oc.enable      its presence turns the Overclock page on (--enable-oc)
  rxd_expected.conf  hashes_per_core_cycle, the denominator of the Output
                     figure. Defaults to 3.0 and should normally be left
                     alone - it is a fixed firmware constant, not a per-board
                     calibration, and keeping it identical on every miner is
                     what makes Output percentages comparable between them.
                     Only a different board design warrants changing it, and
                     it affects nothing but the displayed percentage.

Safety:
  * your miner's existing firmware package is backed up on the device before
    anything replaces it, and --uninstall puts it back
  * every upload is verified by md5 against the local file
  * the miner is never left stopped; the script refuses rather than guessing

Tested against ICM168_08_02_1806_10107. Other versions are allowed but warned
about, because the dashboard patches the stock base.js/index.js by matching
their contents - if the structure moved, the build will say so rather than
producing something broken.
"""

import argparse
import getpass
import hashlib
import os
import posixpath
import subprocess
import sys
import tempfile

try:
    import paramiko
except ImportError:
    sys.exit("paramiko is required:  pip install paramiko")

HERE = os.path.dirname(os.path.abspath(__file__))

# The pbfarmer firmware creates this account, and it is how most people get a
# shell on one of these. Both passwords are defaults people actually have;
# --password overrides.
DEFAULT_USER = 'iceriver'
DEFAULT_PASSWORDS = ['iceriver', '12345678']
DEFAULT_PORT = 54188

ORDER = '/var/order'              # jffs2, survives reboots AND firmware updates
CONF = ORDER + '/conf'
UPDATE = '/var/update'
RESET = ORDER + '/reset'
INITD = '/etc/init.d'
RC5 = '/etc/rc5.d'

# Installed into /var/order, which is why they survive a firmware update.
DEVICE_FILES = [
    ('device/rxd_bridge.py', ORDER + '/rxd_bridge.py', '755'),
    ('device/rxd_fanset.sh', ORDER + '/rxd_fanset.sh', '755'),
    ('device/eeprom_read.py', ORDER + '/eeprom_read.py', '755'),
    ('device/eeprom_write.py', ORDER + '/eeprom_write.py', '755'),
]
INIT_FILES = [
    ('device/rxdbridge', INITD + '/rxdbridge', 'S97rxdbridge'),
    ('device/rxdfan', INITD + '/rxdfan', 'S98rxdfan'),
]

# The web-patch route. These add the dashboard WITHOUT rebuilding the
# firmware package: rxdweb reapplies it to the unpacked web root on every
# boot. S99rxdweb must sort after S99boot.sh, which is what unpacks the
# package - and it does, because "boot.sh" sorts before "rxdweb".
WEB_ASSETS = ORDER + '/web'
WEB_FILES = [
    ('device/rxd_webpatch.py', ORDER + '/rxd_webpatch.py', '755'),
    ('webui/js/radiant_dashboard.js', WEB_ASSETS + '/js/radiant_dashboard.js',
     '644'),
    ('webui/css/radiant.css', WEB_ASSETS + '/css/radiant.css', '644'),
    ('webui/css/login.css', WEB_ASSETS + '/css/login.css', '644'),
]
WEB_INIT = ('device/rxdweb', INITD + '/rxdweb', 'S99rxdweb')


class Miner(object):
    """Thin SSH wrapper. Uses `cat` for transfers: scp and sftp are not
    reliably available on this busybox, but a shell always is."""

    def __init__(self, host, port, user, password):
        self.host, self.port, self.user, self.password = host, port, user, password
        self.client = paramiko.SSHClient()
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.client.connect(host, port=port, username=user, password=password,
                            timeout=20, look_for_keys=False, allow_agent=False)

    def run(self, command, timeout=60):
        _, out, err = self.client.exec_command(command, timeout=timeout)
        stdout = out.read().decode('utf-8', 'replace')
        stderr = err.read().decode('utf-8', 'replace')
        return stdout.strip(), stderr.strip(), out.channel.recv_exit_status()

    def sudo(self, command, timeout=120):
        """sudo -S reads the password from stdin. Never add a stdin redirect to
        one of these - it overrides the pipe, sudo reads EOF, and the command
        dies unauthenticated without saying so."""
        quoted = command.replace("'", "'\\''")
        return self.run("echo '%s' | sudo -S sh -c '%s' 2>/dev/null"
                        % (self.password, quoted), timeout=timeout)

    def put(self, local, remote, timeout=300):
        """Upload byte-for-byte and verify. The firmware package is encrypted,
        so a single altered byte makes it undecryptable."""
        with open(local, 'rb') as handle:
            data = handle.read()
        stdin, out, _ = self.client.exec_command('cat > %s' % remote, timeout=timeout)
        stdin.write(data)
        stdin.channel.shutdown_write()
        out.read()

        want = hashlib.md5(data).hexdigest()
        got, _, _ = self.run('md5sum %s' % remote)
        got = got.split()[0] if got else ''
        if got != want:
            raise RuntimeError('upload of %s did not verify (%s != %s)'
                               % (remote, got, want))
        return want

    def get(self, remote, local, timeout=300):
        _, out, _ = self.client.exec_command('cat %s' % remote, timeout=timeout)
        data = out.channel.makefile('rb').read()
        with open(local, 'wb') as handle:
            handle.write(data)
        return len(data)

    def exists(self, path):
        _, _, code = self.run('test -e %s' % path)
        return code == 0


def say(message):
    print(message)
    sys.stdout.flush()


def connect(host, port, user, password):
    passwords = [password] if password else DEFAULT_PASSWORDS
    last = None
    for candidate in passwords:
        try:
            miner = Miner(host, port, user, candidate)
            say('  connected as %s' % user)
            return miner
        except paramiko.AuthenticationException as ex:
            last = ex
        except Exception as ex:
            raise SystemExit('cannot reach %s:%s - %s' % (host, port, ex))
    raise SystemExit(
        'authentication failed for %s. Pass --password if it is not one of the '
        'defaults. (%s)' % (user, last))


def preflight(miner, args):
    """Everything that can make this install silently fail later."""
    say('\n[1/6] Checking the miner')
    problems, warnings = [], []

    model, _, _ = miner.run('cat /etc/hostname 2>/dev/null')
    say('  hostname: %s' % (model or 'unknown'))

    # The firmware package we rebuild. Its name carries the version.
    listing, _, _ = miner.run('ls %s/*_bg.bgz 2>/dev/null' % UPDATE)
    packages = [line for line in listing.splitlines()
                if line.strip() and not posixpath.basename(line).startswith('pbv')]
    if not packages:
        problems.append('no *_bg.bgz found in %s - is this an IceRiver RX0?' % UPDATE)
        bg_path = None
    else:
        bg_path = packages[0].strip()
        say('  firmware package: %s' % posixpath.basename(bg_path))
        if 'ICM168_08_02_1806_10107' not in bg_path:
            warnings.append(
                'this is not the version this was developed against '
                '(ICM168_08_02_1806_10107). The build will refuse rather than '
                'produce something broken if the stock scripts have moved.')

    # THE landmine. S98pbsetup.sh runs every boot and, if any pbv*.bgz is
    # present in /var/update, deletes every other .bgz there - including the one
    # this script installs. The install would appear to work and silently revert
    # on the next reboot.
    pbv, _, _ = miner.run('ls %s/pbv*.bgz 2>/dev/null' % UPDATE)
    pbv_files = [line.strip() for line in pbv.splitlines() if line.strip()]
    if pbv_files:
        if args.keep_pbv:
            problems.append(
                'pbfarmer packages are present in %s and --keep-pbv was given. '
                '/etc/rc5.d/S98pbsetup.sh deletes every non-pbv .bgz there on '
                'each boot, so this install would be erased at the next reboot. '
                'Drop --keep-pbv to let them be moved aside.' % UPDATE)
        else:
            say('  found %d pbfarmer package(s) to move aside (see notes)'
                % len(pbv_files))

    # Our listeners. A previous install of this bridge holding them is fine -
    # it gets restarted - so only flag ports held by something else. pbfarmer's
    # stratum balancer is the likely other occupant of 4112.
    bridge_running, _, _ = miner.run(
        "ps 2>/dev/null | grep rxd_bridge | grep -v grep | wc -l")
    bridge_running = bridge_running.strip() not in ('', '0')
    if bridge_running:
        say('  this bridge is already installed and running - it will be upgraded')

    for port in (4112, 4113):
        busy, _, _ = miner.run(
            "netstat -ltn 2>/dev/null | grep -c ':%d '" % port)
        if busy.strip() not in ('', '0') and not bridge_running:
            problems.append(
                'port %d is in use by something other than this bridge. '
                "pbfarmer's stratum balancer is the usual occupant of 4112; "
                'stop it, or the bridge cannot bind.' % port)

    running, _, _ = miner.run('pidof iceriverminer')
    if running.strip():
        say('  miner process: running (pid %s)' % running.split()[0])
    else:
        warnings.append('the miner process is not running - installing anyway, '
                        'but check the miner afterwards.')

    _, _, code = miner.sudo('test -w %s' % ORDER)
    if code != 0:
        problems.append('cannot write to %s with sudo - check the password.' % ORDER)

    free, _, _ = miner.run("df -k %s | awk 'NR==2 {print $4}'" % UPDATE)
    try:
        if int(free) < 16000:
            problems.append('%s has only %s KB free; the package needs ~8 MB twice.'
                            % (UPDATE, free))
    except (ValueError, TypeError):
        pass

    for note in warnings:
        say('  WARNING: %s' % note)
    if problems:
        say('')
        for note in problems:
            say('  BLOCKED: %s' % note)
        raise SystemExit('\nNothing has been changed.')

    return bg_path, pbv_files


def is_customised(package, workdir):
    """True if this package already carries the dashboard.

    Checked by decrypting and looking for our own file rather than by trusting
    a backup to exist: an install done by any other route leaves no .stock
    backup, and rebuilding the dashboard from an already-built package stacks
    the patches on themselves.
    """
    out = os.path.join(workdir, 'probe')
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, 'tools', 'bgz_toolkit.py'), 'decrypt',
         package, out],
        cwd=HERE, capture_output=True, text=True)
    if result.returncode != 0:
        return None            # unreadable - caller decides
    for root, _, files in os.walk(out):
        if 'radiant_dashboard.js' in files or 'radiant.css' in files:
            return True
    return False


def pristine_source(miner, bg_path, workdir, args):
    """Fetch the package to build from, and make sure it is actually stock."""
    say('\n[2/6] Fetching the stock firmware package')
    backup = bg_path + '.stock'

    if args.source:
        local = os.path.abspath(args.source)
        # Verify it rather than take its word for it. --source exists precisely
        # for the case where the miner's own package is already patched, and
        # handing over a patched package would stack the dashboard on itself -
        # the same failure this function refuses to walk into below.
        custom = is_customised(local, workdir)
        if custom is None:
            raise SystemExit('could not decrypt the package given with '
                             '--source - is it a *_bg.bgz for this firmware?')
        if custom:
            raise SystemExit(
                'the package given with --source already contains the '
                'dashboard. Building from it would stack the patches on '
                'themselves. Supply a stock *_bg.bgz.')
        say('  using the package given with --source (verified stock)')
        return local, backup, miner.exists(backup)

    source = backup if miner.exists(backup) else bg_path
    local = os.path.join(workdir, 'stock_bg.bgz')
    size = miner.get(source, local)
    say('  downloaded %s (%d bytes)' % (posixpath.basename(source), size))
    if size < 1024 * 1024:
        raise SystemExit('that package is implausibly small - aborting.')

    custom = is_customised(local, workdir)
    if custom is None:
        raise SystemExit(
            'could not decrypt the package from the miner. It may be a firmware '
            'version this tool does not understand. Supply a stock package with '
            '--source to continue.')
    if custom:
        if source == backup:
            raise SystemExit(
                'the .stock backup on the miner is itself customised, so there '
                'is no pristine package to build from. Supply one with --source '
                '(any stock *_bg.bgz for this firmware version).')
        raise SystemExit(
            'the package on the miner already contains the dashboard, and there '
            'is no .stock backup beside it - so this was installed some other '
            'way and the original is not recoverable from the miner.\n'
            'Rebuilding from it would stack the patches on themselves.\n'
            'Supply the original package with --source, or reflash stock '
            'firmware through the web UI first.')

    say('  verified stock (no dashboard files inside)')
    return local, backup, source == backup


def build_package(source, workdir):
    say('\n[3/6] Building the dashboard firmware')
    output = os.path.join(workdir, 'custom_bg.bgz')
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, 'tools', 'build_custom_bgz.py'),
         '--source', source, '--output', output],
        cwd=HERE, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(output):
        say(result.stdout[-2000:])
        say(result.stderr[-2000:])
        raise SystemExit('the build failed - see above. Nothing has been changed '
                         'on the miner.')
    for line in result.stdout.splitlines():
        if line.startswith('  [+]') or line.startswith('  [!]'):
            say('  ' + line.strip())
    say('  built %s (%d bytes)' % (os.path.basename(output), os.path.getsize(output)))
    return output


def build_certs(host, hostname):
    say('\n[4/6] Issuing the HTTPS certificate')
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, 'tools', 'make_certs.py'),
         '--host', host, '--name', hostname or 'ICERIVER'],
        cwd=HERE, capture_output=True, text=True)
    if result.returncode != 0:
        say(result.stdout[-1500:])
        say(result.stderr[-1500:])
        say('  WARNING: certificate generation failed; installing without HTTPS.')
        return None, None, None
    crt = os.path.join(HERE, 'certs', 'webserver.crt')
    key = os.path.join(HERE, 'certs', 'webserver.key')
    ca = os.path.join(HERE, 'certs', 'rxd-ca.crt')
    if not (os.path.exists(crt) and os.path.exists(key)):
        say('  WARNING: certificate files missing; installing without HTTPS.')
        return None, None, None
    say('  certificate covers %s' % host)
    return crt, key, ca


def install(miner, package, crt, key, bg_path, backup, had_backup, pbv_files,
            args, source=None):
    say('\n[5/6] Installing')

    miner.sudo('mkdir -p %s %s' % (CONF, RESET))

    tmp = '/var/volatile/tmp'

    # Back up the stock package once, before the first overwrite. Never
    # overwrite the backup afterwards: after this install the live package is
    # ours, and copying that over the backup would destroy the only stock copy.
    #
    # WHICH package is the stock one matters. Copying what is on the miner is
    # only right when that is still stock - and the whole reason --source
    # exists is that it may not be. Doing it anyway would record a customised
    # package as the pristine one, leaving --uninstall restoring the dashboard
    # it was asked to remove, and a later run refusing with "the .stock backup
    # is itself customised". With --source, the verified stock package we built
    # from is the one that belongs there.
    if not had_backup:
        if source:
            miner.put(source, tmp + '/rxd_stock_bg.bgz')
            miner.sudo('cp %s/rxd_stock_bg.bgz %s' % (tmp, backup))
            say('  backed up the stock package given with --source to %s'
                % posixpath.basename(backup))
        else:
            miner.sudo('cp %s %s' % (bg_path, backup))
            say('  backed up the stock package to %s'
                % posixpath.basename(backup))
    digest = miner.put(package, tmp + '/rxd_new_bg.bgz')
    miner.sudo('cp %s/rxd_new_bg.bgz %s; cp %s/rxd_new_bg.bgz %s/%s'
               % (tmp, bg_path, tmp, RESET, posixpath.basename(bg_path)))
    say('  installed the dashboard package (md5 %s)' % digest)

    for local, remote, mode in DEVICE_FILES:
        path = os.path.join(HERE, local)
        if not os.path.exists(path):
            raise SystemExit('missing %s - run this from a full checkout.' % local)
        name = posixpath.basename(remote)
        miner.put(path, tmp + '/' + name)
        miner.sudo('cp %s/%s %s; chmod %s %s' % (tmp, name, remote, mode, remote))
    say('  installed %d support scripts to %s' % (len(DEVICE_FILES), ORDER))

    for local, remote, link in INIT_FILES:
        name = posixpath.basename(remote)
        miner.put(os.path.join(HERE, local), tmp + '/' + name)
        miner.sudo('cp %s/%s %s; chmod 755 %s; ln -sf ../init.d/%s %s/%s'
                   % (tmp, name, remote, remote, name, RC5, link))
    say('  enabled the bridge and fan services at boot')

    if crt and key:
        miner.put(crt, tmp + '/webserver.crt')
        miner.put(key, tmp + '/webserver.key')
        miner.sudo('cp %s/webserver.crt %s/webserver.crt; '
                   'cp %s/webserver.key %s/webserver.key; '
                   'chmod 644 %s/webserver.crt; chmod 600 %s/webserver.key'
                   % (tmp, CONF, tmp, CONF, CONF, CONF))
        say('  installed the certificate to %s' % CONF)

    write_conf(miner, args)

    # Moved, not deleted: these are the user's firmware packages, and the only
    # problem with them is that S98pbsetup.sh treats their presence as licence
    # to delete everything else in /var/update on every boot.
    if pbv_files:
        miner.sudo('mkdir -p %s/pbv-backup' % ORDER)
        for path in pbv_files:
            miner.sudo('mv %s %s/pbv-backup/' % (path, ORDER))
        say('  moved %d pbfarmer package(s) to %s/pbv-backup so the boot script '
            'stops deleting other firmware' % (len(pbv_files), ORDER))

    miner.sudo('sync')


def start_services(miner):
    say('\n[6/6] Starting services')
    for name in ('rxdbridge', 'rxdfan'):
        out, _, _ = miner.sudo('%s/%s restart' % (INITD, name))
        say('  %s: %s' % (name, out.replace('\n', '; ') or 'started'))

    probe, _, _ = miner.run('curl -s -m 8 http://127.0.0.1:4112/clock 2>/dev/null')
    if probe.strip().startswith('{'):
        say('  bridge is answering on 4112')
    else:
        say('  NOTE: the bridge did not answer yet. It waits for the miner\'s '
            'command port, which can take a couple of minutes after a boot.')


def write_conf(miner, args):
    """Fan and overclock settings in /var/order/conf. Shared by both install
    routes, so they cannot drift."""
    # Only if absent - never stamp on a value already chosen.
    if not miner.exists(CONF + '/rxd_fan.conf'):
        mode = 'target' if args.fan_target else 'fixed'
        miner.sudo("printf 'mode = %s\\nratio = %d\\ntarget = %d\\n"
                   "minfan = %d\\nmaxfan = %d\\n' > %s/rxd_fan.conf"
                   % (mode, args.fan, args.fan_target or 60,
                      args.fan_min, args.fan_max, CONF))
        if mode == 'target':
            say('  holding chips at %d C, fan between %d%% and %d%%'
                % (args.fan_target, args.fan_min, args.fan_max))
        else:
            say('  fan ratio set to %d%% (edit %s/rxd_fan.conf to change)'
                % (args.fan, CONF))
    else:
        say('  kept the existing fan setting in %s/rxd_fan.conf' % CONF)

    # A flag, not a secret. The bridge serves /setclock only when this exists,
    # so a miner installed without --enable-oc has no clock endpoint at all.
    # The old rxd_oc.token counts as the same flag, so an install made before
    # the token went away keeps its Overclock page without being touched.
    if args.enable_oc:
        if miner.exists(CONF + '/rxd_oc.token'):
            say('  overclocking already enabled (via the older rxd_oc.token)')
        elif miner.exists(CONF + '/rxd_oc.enable'):
            say('  overclocking already enabled')
        else:
            miner.sudo('echo enabled > %s/rxd_oc.enable' % CONF)
            say('  overclocking ENABLED')
    else:
        say('  overclocking not enabled (pass --enable-oc if you want it)')


def install_webpatch(miner, args, pbv_files):
    """Install without touching the firmware package.

    The dashboard is a handful of text changes to the web root the miner
    unpacks at boot, so it does not need the package rebuilt - and rebuilding
    is the one step that needs IceRiver's container passphrase. Instead the
    files live in /var/order (jffs2, survives reboots and firmware updates)
    and rxdweb reapplies them to /var/volatile/tmp/bg after boot.sh unpacks it.

    Nothing of IceRiver's is modified on disk, so there is no backup to keep
    and no restore to get wrong: removing rxdweb returns the miner to stock at
    the next boot.
    """
    say('\n[1/4] Copying the dashboard and services to %s' % ORDER)
    miner.sudo('mkdir -p %s/js %s/css %s' % (WEB_ASSETS, WEB_ASSETS, CONF))
    for local, remote, mode in DEVICE_FILES + WEB_FILES:
        path = os.path.join(HERE, local)
        if not os.path.exists(path):
            raise SystemExit('missing file in this checkout: %s' % local)
        tmp = '/var/volatile/tmp/rxd_upload'
        miner.put(path, tmp)
        miner.sudo('cp %s %s; chmod %s %s; rm -f %s'
                   % (tmp, remote, mode, remote, tmp))
        say('  %s' % remote)

    say('\n[2/4] Writing the configuration')
    write_conf(miner, args)

    say('\n[3/4] Installing the services')
    for local, remote, link in INIT_FILES + [WEB_INIT]:
        path = os.path.join(HERE, local)
        tmp = '/var/volatile/tmp/rxd_init'
        miner.put(path, tmp)
        miner.sudo('cp %s %s; chmod 755 %s; ln -sf ../init.d/%s %s/%s; rm -f %s'
                   % (tmp, remote, remote, posixpath.basename(remote),
                      RC5, link, tmp))
        say('  %s -> %s/%s' % (remote, RC5, link))

    say('\n[4/4] Applying it to the running web root')
    out, _, code = miner.sudo('/etc/init.d/rxdweb restart')
    say('  %s' % (out.strip() or 'applied'))
    start_services(miner)

    say('\n' + '=' * 62)
    say('Done - and the firmware package was not touched.')
    say('')
    say('  Dashboard:  http://%s/     (reload with a hard refresh)' % args.host)
    say('')
    say('  The dashboard is reapplied to the web root on every boot, so it')
    say('  survives reboots AND firmware updates: a new package unpacks')
    say('  clean and rxdweb patches it again.')
    if args.enable_oc:
        say('')
        say('  Overclock:  enabled, on the Overclock page in the sidebar.')
        say('  Read the warning there - a higher clock is not automatically')
        say('  faster, and judging one takes hours of average hashrate.')
    if pbv_files:
        say('')
        say('  NOTE: %d pbfarmer package(s) are still in /var/update. They do'
            % len(pbv_files))
        say('  not threaten this install - nothing of ours lives there now.')
    say('')
    say('  Undo:  python install_rxd.py --host %s --uninstall' % args.host)
    say('=' * 62)


def uninstall(miner, args):
    say('\n[1/3] Removing the web patch')
    # Nothing of IceRiver's was modified, so this is just deletion: the next
    # boot unpacks a clean web root from the untouched stock package.
    miner.sudo('rm -f %s/%s %s' % (RC5, WEB_INIT[2], WEB_INIT[1]))
    miner.sudo('rm -rf %s %s/rxd_webpatch.py' % (WEB_ASSETS, ORDER))
    say('  removed rxdweb; the stock UI returns at the next boot')

    say('\n[2/3] Restoring the stock firmware package')
    listing, _, _ = miner.run('ls %s/*_bg.bgz.stock 2>/dev/null' % UPDATE)
    backup = listing.strip().splitlines()[0].strip() if listing.strip() else ''
    if not backup:
        say('  no .stock backup found - leaving the package alone. If you want '
            'stock firmware back, reflash it through the web UI.')
    else:
        live = backup[:-len('.stock')]
        miner.sudo('cp %s %s; cp %s %s/%s'
                   % (backup, live, backup, RESET, posixpath.basename(live)))
        say('  restored %s' % posixpath.basename(live))

    say('\n[3/3] Removing services')
    for _, remote, link in INIT_FILES:
        name = posixpath.basename(remote)
        miner.sudo('%s/%s stop' % (INITD, name))
        miner.sudo('rm -f %s/%s %s' % (RC5, link, remote))
        say('  removed %s' % name)

    # The support scripts and conf are left in /var/order deliberately: they are
    # inert without the init scripts, and rxd_oc.enable / the certificate are
    # the user's to delete.
    say('\nLeft in place: %s/{rxd_bridge.py,rxd_fanset.sh,eeprom_*.py} and %s.'
        % (ORDER, CONF))
    say('They do nothing without the services. Delete them by hand if you want.')
    say('\nReboot for the stock dashboard to come back.')


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--host', required=True, help="the miner's IP address")
    ap.add_argument('--port', type=int, default=DEFAULT_PORT,
                    help='SSH port (default %d)' % DEFAULT_PORT)
    ap.add_argument('--user', default=DEFAULT_USER, help='SSH user')
    ap.add_argument('--password', help='SSH password (default: try the usual ones)')
    ap.add_argument('--ask-password', action='store_true',
                    help='prompt for the password instead of passing it on the '
                         'command line, where it would land in your shell history')
    ap.add_argument('--fan', type=int, default=25,
                    help='fan speed percent to hold (default 25)')
    ap.add_argument('--fan-target', type=int, metavar='C',
                    help='hold this chip temperature instead of a fixed fan '
                         'speed, letting the fan move to keep it (e.g. 60). A '
                         'fixed speed is only right for one ambient; this is '
                         'not. Omit for the fixed --fan behaviour.')
    ap.add_argument('--fan-min', type=int, default=25, metavar='PCT',
                    help='with --fan-target, never run the fan below this '
                         '(default 25)')
    ap.add_argument('--fan-max', type=int, default=100, metavar='PCT',
                    help='with --fan-target, never run the fan above this '
                         '(default 100)')
    ap.add_argument('--enable-oc', action='store_true',
                    help='turn on the Overclock page and its write endpoint')
    ap.add_argument('--repack', action='store_true',
                    help='rebuild the firmware package instead of patching the '
                         'web root at boot. Needs the container passphrase in '
                         'tools/bgz_toolkit.py, and is only required for HTTPS '
                         '(--certs), because appweb reads appweb.conf once at '
                         'startup. The default route touches no IceRiver file '
                         'and survives firmware updates.')
    ap.add_argument('--keep-pbv', action='store_true',
                    help='do not move pbfarmer packages out of /var/update '
                         '(the install will not survive a reboot - see notes)')
    ap.add_argument('--source',
                    help='a stock *_bg.bgz to build from, when the miner no '
                         'longer has a pristine copy')
    ap.add_argument('--dry-run', action='store_true',
                    help='check the miner and build the package, then stop '
                         'without changing anything on it')
    ap.add_argument('--no-reboot', action='store_true',
                    help='do not offer to reboot at the end')
    ap.add_argument('--uninstall', action='store_true',
                    help='restore the stock package and remove the services')
    args = ap.parse_args()

    if not 0 <= args.fan <= 100:
        raise SystemExit('--fan must be 0-100')
    # Mirrors the bounds the bridge enforces, so the installer cannot write a
    # config the dashboard would silently clamp the moment anyone opened it.
    if args.fan_target is not None and not 40 <= args.fan_target <= 85:
        raise SystemExit('--fan-target must be 40-85 C')
    if not 10 <= args.fan_min <= 100 or not 10 <= args.fan_max <= 100:
        raise SystemExit('--fan-min and --fan-max must be 10-100')
    if args.fan_min > args.fan_max:
        raise SystemExit('--fan-min cannot be above --fan-max')

    password = args.password
    if args.ask_password:
        password = getpass.getpass('SSH password for %s: ' % args.user)

    say('Radiant RXD installer -> %s:%d' % (args.host, args.port))
    miner = connect(args.host, args.port, args.user, password)

    if args.uninstall:
        uninstall(miner, args)
        return

    bg_path, pbv_files = preflight(miner, args)
    hostname, _, _ = miner.run('cat /etc/hostname 2>/dev/null')

    if not args.repack:
        install_webpatch(miner, args, pbv_files)
        return

    # --repack rebuilds the *_bg.bgz, which means decrypting and re-encrypting
    # IceRiver's container. That needs their passphrase, which is not in this
    # repository - so neither is the tooling for that route.
    if not os.path.exists(os.path.join(HERE, 'tools', 'bgz_toolkit.py')):
        raise SystemExit(
            "--repack needs tools/bgz_toolkit.py, which is not part of this\n"
            "repository: rebuilding the firmware package requires IceRiver's\n"
            "container passphrase, and that is not published here.\n"
            "\n"
            "You do not need it. Run without --repack and the dashboard is\n"
            "applied to the unpacked web root at every boot, leaving the\n"
            "firmware package untouched - which is the better route anyway.\n"
            "\n"
            "The only thing --repack adds is HTTPS for the web UI, because\n"
            "appweb reads appweb.conf once at startup, so a boot-time patch\n"
            "cannot add a TLS listener to it. The bridge still serves TLS on\n"
            "4113 if you put a certificate in /var/order/conf.")

    with tempfile.TemporaryDirectory() as workdir:
        source, backup, had_backup = pristine_source(miner, bg_path, workdir, args)
        package = build_package(source, workdir)

        if args.dry_run:
            # Stop before the certificate too: make_certs.py writes into certs/
            # and reissues the leaf, which is a change, if only a local one.
            say('\n' + '=' * 62)
            say('Dry run: the miner passed every check and the package built')
            say('cleanly. Nothing on the miner was changed.')
            say('Run again without --dry-run to install.')
            say('=' * 62)
            return

        crt, key, ca = build_certs(args.host, hostname)
        install(miner, package, crt, key, bg_path, backup, had_backup,
                pbv_files, args, source if args.source else None)
        start_services(miner)

    say('\n' + '=' * 62)
    say('Done. The dashboard loads after a reboot, when the miner unpacks the')
    say('new package into its web root.')
    say('')
    say('  Dashboard:  http://%s/   (or https://%s/ once the CA is trusted)'
        % (args.host, args.host))
    if ca:
        say('  Trust once: certutil -addstore -user Root %s     (Windows)' % ca)
        say('              or add certs/rxd-ca.crt to your keychain / trust store')
    if args.enable_oc:
        say('')
        say('  Overclock:  enabled, on the Overclock page in the sidebar.')
        say('  Read the warning there - a higher clock is not automatically')
        say('  faster, and judging one takes hours of average hashrate, not')
        say('  minutes. Each change reboots the miner.')
    if pbv_files:
        say('')
        say('  Moved %d pbfarmer package(s) to %s/pbv-backup. They were left in'
            % (len(pbv_files), ORDER))
        say('  /var/update by the pbfarmer firmware, and its boot script deletes')
        say('  every OTHER .bgz there whenever one is present - which would have')
        say('  erased this install on your next reboot.')
    say('')
    say('  Undo:  python install_rxd.py --host %s --uninstall' % args.host)
    say('=' * 62)

    if not args.no_reboot:
        try:
            answer = input('\nReboot the miner now to load it? [y/N] ')
        except EOFError:
            answer = 'n'
        if answer.strip().lower().startswith('y'):
            say('Rebooting - mining stops for about three minutes.')
            # /sbin/reboot, not `reboot` or `busybox reboot`: this is sysvinit,
            # and the busybox applet exits 0 without doing anything. /sbin is
            # not on this user's PATH, hence the absolute path.
            miner.sudo('sync; /sbin/reboot')
        else:
            say('Not rebooting. The dashboard loads on the next restart.')


if __name__ == '__main__':
    main()
