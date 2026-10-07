#!/usr/bin/env python3
"""Клиент Screen Off для ShojiWM: гасит выходы композитора и ждёт пробел.

Запускается командой `off` из панели Noctalia: она поднимает этот же скрипт в
режиме `wait` собственным transient-юнитом (systemd-run). Юнит нужен по той же
причине, что и в monitors.sh: Noctalia запускает команды панели в transient-юните
и по его завершении вычищает cgroup целиком — живущий во тьме процесс должен
быть сиблингом вызывающего, а не потомком, иначе его убьют вместе с панелью.
Имя юнита фиксировано, поэтому повторный `off` при живом юните ничего не
делает (idempotent), а стартовая гонка двух `off` закрывается и именем юнита,
и неблокирующим flock внутри `wait`.

Темнота владеется сокетом композитора: абстрактный Unix-сокет
`shojiwm-output-power-<uid>-<hash полного пути Wayland-сокета>` принимает
построчные команды `off` / `on` / `state` и отвечает `ok off` / `ok on` либо
`error <message>`. Соединение, отправившее `off`, держит «аренду тьмы»: пока
оно живо, темнота сохраняется; разрыв (EOF) или `on` возвращает свет. `off`
считается сделанным только после `ok off` — композитор подтверждает реальную
очистку DRM, а не приём команды. Частичный провал композитор откатывает сам.

Пробуждение — только пробел: перед гашением клиент подключается к корневому
демону /run/wake-on-space/sock и требует подтверждения `armed`. Нет демона,
нет сокета композитора, нет `ok off` — выход с ошибкой ДО darkness: экраны,
подсветка, кулеры и обои остаются как были. Никакого фолбэка на Hyprland,
выключение мониторов или «будит любая клавиша» здесь нет.

Подсветка, кулеры, обои — тот же переход, что у wake-on-space.py: маркер
SCREEN_OFF_RGB_LOCK ставится перед гашением (sync-скрипты видят его и держат
0%), после подтверждённой темноты зовутся screen-off-extras.sh dark и обычный
sync палитры. Возврат — строго в обратном порядке: extras wake, снять маркер,
дождаться затемняющий sync, финальный восстановительный sync — синхронно,
потому что transient-юнит забирает cgroup, как только основной процесс выйдет.
Скрипты лежат рядом с wake-on-space.py в /home/q/.config/hypr/scripts — не в
worktree композитора: по ним ходит живая сессия.

    shoji-screen-off.py off    поднять юнит shoji-screen-off.service (wait внутри)
    shoji-screen-off.py on     зажечь: native `on`, потом остановить юнит
    shoji-screen-off.py state  напечатать on/off (ненулевой код при ошибке)
    shoji-screen-off.py wait   внутренний режим: погасить и ждать пробел
"""

import argparse
import fcntl
import os
import select
import signal
import socket
import subprocess
import sys
import time

# Общий модуль лежит рядом; он же — CLI температуры для night-mode.sh.
# Единственная реализация адреса — здесь, в shoji_native.py.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from shoji_native import native_address, notify_failure

SERVICE = "shoji-screen-off.service"
WAKE_SOCK = "/run/wake-on-space/sock"
CONNECT_TIMEOUT = 2
# Сколько ждать строку от сокета под select: ответы композитора (`off` —
# реальная очистка DRM) могут занять заметно дольше, чем локальный демон.
REPLY_TIMEOUT = 10
POLL_TIMEOUT = 5
# Граница кадра протокола композитора: длиннее строк протокол не признаёт,
# мусор обрывается, чтобы никогда не читать бесконечную строку.
LINE_LIMIT = 1024
# Переход тьмы: те же скрипты, что зовёт wake-on-space.py, рядом с ним —
# живая сессия не знает про worktree композитора.
HYPR_SCRIPTS = "/home/q/.config/hypr/scripts"
RGB_SYNC = os.path.join(HYPR_SCRIPTS, "noctalia-openrgb-sync.sh")
SCREEN_OFF_EXTRAS = os.path.join(HYPR_SCRIPTS, "screen-off-extras.sh")
EXTRAS_TIMEOUT = 5
# Маркер тьмы: тот же путь, что в wake-on-space.py, monitors.sh и sync-скрипте.
SCREEN_OFF_RGB_LOCK = os.environ.get(
    "SCREEN_OFF_RGB_LOCK",
    os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"),
                 "screen-off-rgb.lock"))
# Сериализация `wait`-ов: держим неблокирующий flock, пока темнота наша, —
# прямой вызов `wait` не должен ступить на маркер и extras чужого владельца.
# Файл не маркер тьмы: его существование ничего не значит.
WAIT_LOCK = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"),
                         "screen-off-wait.lock")
# Переменные, без которых внутренний `wait` в юните слеп: путь до сокета
# композитора, окружение Noctalia-триала (его корни НЕ системные дефолты) и
# путь маркера, если его переопределили.
PASSTHROUGH_ENV = (
    "PATH",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "NOCTALIA_CONFIG_HOME",
    "NOCTALIA_STATE_HOME",
    "NOCTALIA_DATA_HOME",
    "SCREEN_OFF_RGB_LOCK",
    # Уведомление о провале wait-стадии должно дойти до пользователя юнита.
    "DBUS_SESSION_BUS_ADDRESS",
)


def rgb_lock_create():
    """Поставить маркер тьмы (0% подсветки для всех sync'ов). True если наш."""
    try:
        with open(SCREEN_OFF_RGB_LOCK, "w"):
            pass
        return True
    except OSError:
        return False


def rgb_lock_remove():
    """Снять маркер тьмы перед восстановлением подсветки."""
    try:
        os.unlink(SCREEN_OFF_RGB_LOCK)
    except OSError:
        pass


def screen_off_extras(mode):
    """Переход тьмы («dark») или пробуждения («wake»): кулеры, обои, сторож."""
    if not os.access(SCREEN_OFF_EXTRAS, os.X_OK):
        return
    try:
        subprocess.run([SCREEN_OFF_EXTRAS, mode], timeout=EXTRAS_TIMEOUT,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        print(f"screen-off-extras {mode}: не уложился в {EXTRAS_TIMEOUT} с",
              file=sys.stderr)


def rgb_sync(wait=False):
    """Протолкнуть палитру в OpenRGB; яркость решает сам sync-скрипт.

    По умолчанию неблокирующе: подсветка — косметика. wait=True дожидается
    завершения — обязателен для финального восстановления в finally:
    transient-юнит вычищает cgroup, как только основной процесс выйдет, и
    недожданный восстанавливающий sync умрёт на полпути с чёрной подсветкой.
    """
    if not os.access(RGB_SYNC, os.X_OK):
        return None
    proc = subprocess.Popen([RGB_SYNC],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    if wait:
        proc.wait()
    return proc


class Lines:
    """Построчное чтение из сокета с таймаутом.

    sock.makefile() для этого не годится: первый же таймаут навсегда взводит
    внутри SocketIO флаг, и все следующие чтения падают с
    OSError("cannot read from timed out object"). Читаем через select+recv
    вручную и ограничиваем строку LINE_LIMIT, чтобы бесконечная строка с той
    стороны не забила память.
    """

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""

    def _line_from_buf(self):
        nl = self.buf.find(b"\n")
        if nl < 0:
            return None
        if nl > LINE_LIMIT:
            self.buf = b""
            return "error line exceeds protocol limit"
        line, self.buf = self.buf[:nl], self.buf[nl + 1:]
        return line.decode("utf-8", "replace").strip()

    def readline(self, timeout):
        """Строка без \\n, "" если сокет закрыт, None если таймаут.

        timeout=0 — мгновенная попытка: буфер, затем единственный
        неблокирующий recv, если байты уже ждут. Так читается готовность,
        уже доказанная внешним select: recv обязателен, иначе EOF и кадры
        не забираются никогда.
        """
        deadline = time.monotonic() + timeout
        while True:
            line = self._line_from_buf()
            if line is not None:
                return line
            if len(self.buf) > LINE_LIMIT:
                # Протокол таких строк не пишет: обрываем и честно говорим
                # про мусор, чтобы не копить его до бесконечности.
                self.buf = b""
                return "error line exceeds protocol limit"
            remaining = max(0, deadline - time.monotonic())
            if not select.select([self.sock], [], [], remaining)[0]:
                return None
            chunk = self.sock.recv(LINE_LIMIT)
            if not chunk:
                return ""
            self.buf += chunk
            if timeout == 0:
                # Дочитываем только полный кадр из уже полученных байт;
                # за хвостом — следующий вызов и его внешний select.
                line = self._line_from_buf()
                if line is not None:
                    return line
                if len(self.buf) > LINE_LIMIT:
                    self.buf = b""
                    return "error line exceeds protocol limit"
                return None


def connect_native():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(CONNECT_TIMEOUT)
    try:
        sock.connect(native_address())
    except OSError:
        sock.close()
        raise
    sock.settimeout(None)
    return sock, Lines(sock)


def transact(native, lines, cmd, timeout=REPLY_TIMEOUT):
    """Отправить команду и получить строку ответа; "" = композитор умер,
    None = ответ не пришёл вовремя."""
    payload = (cmd + "\n").encode()
    if len(payload) > LINE_LIMIT:
        raise OSError("команда длиннее границы протокола")
    native.sendall(payload)
    return lines.readline(timeout)


def connect_wake():
    """Подключается к демону пробуждения и ждёт подтверждения готовности."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(CONNECT_TIMEOUT)
    try:
        sock.connect(WAKE_SOCK)
    except OSError:
        sock.close()
        raise
    sock.settimeout(None)
    lines = Lines(sock)
    reply = lines.readline(CONNECT_TIMEOUT)
    if reply != "armed":
        sock.close()
        raise OSError(f"демон ответил {reply!r}, а не 'armed'")
    return sock, lines


def fail(msg):
    print(f"shoji-screen-off: {msg}", file=sys.stderr)
    return 1


def cmd_off():
    """Поднять transient-юнит с `wait` внутри.

    Idempotent: при живом юните выходим с нулём — второй владелец тьмы не
    создаётся. Стартовую гонку двух `off` закрывают и имя юнита (systemd-run
    с занятым именем падает), и flock внутри `wait`.
    """
    active = subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", SERVICE],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if active.returncode == 0:
        print(f"shoji-screen-off: {SERVICE} уже активен", file=sys.stderr)
        return 0
    # Preflight read-only `state` ДО юнита, маркера, кулеров и RGB: старый
    # или отсутствующий композитор — провал здесь, без единого побочного
    # эффекта тьмы. Соединение не держит аренды и сразу закрывается.
    try:
        native, lines = connect_native()
    except OSError as err:
        msg = (f"композитор недоступен ({err}): запущенный ShojiWM, возможно, "
               f"старой сборки — обновите и перелогиньтесь")
        print(f"shoji-screen-off: {msg}", file=sys.stderr)
        notify_failure(f"Screen Off не удался: {msg}")
        return 1
    try:
        reply = transact(native, lines, "state")
    except OSError as err:
        native.close()
        msg = f"native state preflight: {err}"
        print(f"shoji-screen-off: {msg}", file=sys.stderr)
        notify_failure(f"Screen Off не удался: {msg}")
        return 1
    native.close()
    if reply not in ("ok on", "ok off"):
        msg = (f"native state preflight ответил {reply!r}: силовой сокет "
               f"не отвечает как ожидалось; запущенный ShojiWM, возможно, "
               f"старой сборки — обновите и перелогиньтесь")
        print(f"shoji-screen-off: {msg}", file=sys.stderr)
        notify_failure(f"Screen Off не удался: {msg}")
        return 1
    cmd = ["systemd-run", "--user", "--collect", f"--unit={SERVICE}"]
    for var in PASSTHROUGH_ENV:
        if var in os.environ:
            cmd.append(f"--setenv={var}={os.environ[var]}")
    cmd += [sys.executable, os.path.realpath(__file__), "wait"]
    # Возврат кода юнита — это только код его процесса: юнит может упасть
    # уже после preflight (внутренний wait), и это не значит, что экраны
    # физически погасли — wait сам отчитается об отказе и уведомлением.
    proc = subprocess.run(cmd)
    if proc.returncode != 0:
        # Сам спавн не удался (занятое имя юнита, сбой systemd-run) — юнит
        # не поднят; это пользовательский Screen Off, молчать нельзя.
        msg = f"systemd-run {SERVICE} не поднялся: код {proc.returncode}"
        print(f"shoji-screen-off: {msg}", file=sys.stderr)
        notify_failure(f"Screen Off не удался: {msg}")
    return proc.returncode


def cmd_on():
    """Зажечь: сначала подтверждённый native `on`, только потом стоп юнита.

    Порядок принципиален: стоп убивает watcher сигналом, и если свет ещё не
    подтверждён, останется тьма, у которой кончился владелец. После `ok on`
    watcher увидит это же в своём цикле, но остановка юнита здесь гарантирует
    завершение и его финальный restore даже если цикл спал.
    """
    try:
        native, lines = connect_native()
    except OSError as err:
        return fail(f"композитор недоступен: {err}")
    try:
        reply = transact(native, lines, "on")
    except OSError as err:
        native.close()
        return fail(f"native on: {err}")
    native.close()
    if reply != "ok on":
        return fail(f"native on ответил {reply!r}")
    stop = subprocess.run(["systemctl", "--user", "stop", SERVICE],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if stop.returncode != 0:
        print(f"shoji-screen-off: systemctl stop {SERVICE}: "
              f"код {stop.returncode} (юнит мог быть не запущен)",
              file=sys.stderr)
    return 0


def cmd_state():
    try:
        native, lines = connect_native()
    except OSError as err:
        return fail(f"композитор недоступен: {err}")
    try:
        reply = transact(native, lines, "state")
    except OSError as err:
        native.close()
        return fail(f"native state: {err}")
    native.close()
    if reply == "ok on":
        print("on")
        return 0
    if reply == "ok off":
        print("off")
        return 0
    return fail(f"native state ответил {reply!r}")


def cmd_wait():
    """Погасить экраны и ждать пробел. Живёт внутри transient-юнита.

    Всё, что меняет состояние машины (маркер, extras, native off), делается
    только когда темнота точно наша; restore в finally зеркально строгий —
    чужую тьму он не трогает.
    """
    # Сериализация: второй `wait` не должен ступить на маркер и extras
    # первого. Неблокирующий flock держим до конца темноты.
    lock = open(WAIT_LOCK, "w")

    def wfail(msg):
        # Wait-стадия запускается кнопкой Screen Off: её провал должен быть
        # виден пользователю так же, как провал preflight.
        notify_failure(f"Screen Off не удался: {msg}")
        return fail(msg)

    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        return wfail("другой wait уже владеет темнотой")

    # Порядок строго fail-closed: сначала оба сокета, потом darkness. Нет
    # демона или композитора — выходим ДО маркера, extras и гашения.
    try:
        wake, wlines = connect_wake()
    except OSError as err:
        lock.close()
        return wfail(f"демон пробуждения недоступен: {err}")
    try:
        native, nlines = connect_native()
    except OSError as err:
        wake.close()
        lock.close()
        return wfail(f"силовой сокет композитора недоступен: {err}")

    # Сигналы ставим ДО маркера и гашения: SIGTERM между маркером и extras
    # иначе прошёл бы мимо restore по умолчанию. В finally сигналы глушим,
    # чтобы не убить восстановление на середине.
    def _die(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _die)
    signal.signal(signal.SIGINT, _die)

    dim = None
    # Владение состояниями: только они дают право на симметричный restore.
    marker_ours = False      # маркер тьмы поставили мы
    dark_ok = False          # композитор подтвердил ok off
    extras_dark_done = False # dark-extras запускали
    code = 1
    try:
        marker_ours = rgb_lock_create()
        if not marker_ours:
            return wfail(f"не удалось создать маркер подсветки {SCREEN_OFF_RGB_LOCK}")
        try:
            reply = transact(native, nlines, "off")
        except OSError as err:
            reply = f"error {err}"
        if reply != "ok off":
            # Включая None (ответ не пришёл вовремя): подтверждения нет —
            # темнотой не владеем, соединение в finally закроется, и lease
            # EOF композитора откатит частичный провал сам.
            code = wfail(f"native off ответил {reply!r}: экраны не гасим")
            return code
        dark_ok = True
        # Экраны погасли — можно гасить шум. Маркер уже стоит, поэтому
        # фоновые sync'и во тьме держат 0%.
        extras_dark_done = True
        screen_off_extras("dark")
        dim = rgb_sync()

        while True:
            ready, _, _ = select.select([wake, native], [], [], POLL_TIMEOUT)
            if wake in ready:
                line = wlines.readline(0.1)
                if line == "space":
                    reply = transact(native, nlines, "on")
                    if reply != "ok on":
                        code = wfail(f"native on ответил {reply!r}")
                    else:
                        code = 0
                    return code
                if line in ("", "no-keyboards"):
                    # Демон умер или остался без клавиатур: будильщика нет,
                    # зажигаем сами, а не оставляем тьму навсегда.
                    reply = transact(native, nlines, "on")
                    code = 0 if reply == "ok on" else wfail(
                        f"native on ответил {reply!r}")
                    return code
                # Незнакомая строка — не повод зажигать, ждём дальше.
            if native in ready:
                line = nlines.readline(0.1)
                if line == "":
                    # Композитор закрыл соединение: lease EOF уже вернул свет
                    # на его стороне; темнотой больше не владеем.
                    return 1
                if line == "ok on":
                    # Чужой `on` по нашему же сокету: темнота кончилась.
                    return 0
                print(f"shoji-screen-off: лишние данные от композитора: "
                      f"{line!r}", file=sys.stderr)
                return 1
            if not ready:
                # Тишину перепроверяем: чужой `on` (tty, ssh, второй клиент)
                # мог зажечь экраны, не трогая наш сокет.
                reply = transact(native, nlines, "state")
                if reply == "":
                    return 1
                if reply == "ok on":
                    return 0
                if reply == "ok off":
                    continue
                code = wfail(f"native state ответил {reply!r}")
                return code
    finally:
        # Сигналы во время restore глушим: недоделанный restore хуже
        # проигнорированного SIGTERM.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if dark_ok:
            # Свет возвращает только владелец этой темноты: при отказе off
            # чужая тьма или частичный провал — не наши, их не трогаем.
            try:
                transact(native, nlines, "on")
            except OSError:
                pass
        native.close()
        wake.close()
        if extras_dark_done:
            # extras wake убивает сторожа насмерть раньше возврата кривых.
            screen_off_extras("wake")
        if marker_ours:
            # Снимаем только свой маркер, затем ре-синк: пока маркер стоял,
            # фоновые sync'и могли выдать чёрный, и без пересинха подсветка
            # осталась бы темной после возврата. При отказе off маркер тоже
            # был наш — откатываем его след синхронно, экраны-то горят.
            rgb_lock_remove()
        if dim is not None and dim.poll() is None:
            dim.wait()
        if marker_ours or dark_ok:
            # Финальное восстановление также откатывает любой фоновый sync,
            # который увидел маркер до отказа native off.
            rgb_sync(wait=True)
        lock.close()


def main():
    ap = argparse.ArgumentParser(
        description="Screen Off клиент ShojiWM: гасит DRM-выходы, ждёт пробел")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("off", help="поднять transient-юнит с wait внутри")
    sub.add_parser("on", help="зажечь: native on, затем стоп юнита")
    sub.add_parser("state", help="напечатать on/off")
    sub.add_parser("wait", help="внутренний режим: погасить и ждать пробел")
    args = ap.parse_args()
    if args.cmd == "off":
        return cmd_off()
    if args.cmd == "on":
        return cmd_on()
    if args.cmd == "state":
        return cmd_state()
    return cmd_wait()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
