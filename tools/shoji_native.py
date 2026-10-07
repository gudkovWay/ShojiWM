#!/usr/bin/env python3
"""Общий native-клиент ShojiWM и CLI температуры.

Единственная реализация вычисления абстрактного адреса силового сокета
композитора (FNV-1a по каноническому абсолютному пути Wayland-сокета) —
её импортирует shoji-screen-off.py. Здесь же — маленький CLI для ночной
кривой:

    shoji_native.py temperature <1000..20000>
    shoji_native.py identity

Протокол композитора построчный: команда + \\n, ответ — одна строка.
Для temperature/identity контракт такой: ровно `ok temperature`,
`ok identity` или `ok deferred`. `ok deferred` значит «цель записана, но
железо сейчас недоступно (тьма/неактивный VT)» — это НЕ аппаратное
применение; CLI сообщает об этом явно и выходит с нулём. Любой другой
ответ, таймаут или обрыв — ошибка: текст в stderr, код 1. Внешних
зависимостей нет.
"""

import os
import select
import socket
import subprocess
import sys
import time

CONNECT_TIMEOUT = 2
REPLY_TIMEOUT = 10
# Граница кадра протокола композитора: та же, что у клиентов силы.
LINE_LIMIT = 1024


def native_address():
    """Абстрактный адрес силового сокета текущего композитора.

    Имя выбирает композитор после init_wayland_listener — по фактическому
    WAYLAND_DISPLAY, не по устаревшим подсказкам, поэтому и клиент берёт его
    из окружения на момент запуска. Ведущий NUL обязателен: это абстрактное
    пространство имён Linux, файловой точки у сокета нет.
    """
    display = os.environ.get("WAYLAND_DISPLAY")
    if not display:
        raise OSError(
            "WAYLAND_DISPLAY не задан: не вычислить силовой сокет композитора")
    if os.path.isabs(display):
        wayland_path = display
    else:
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
        if not runtime_dir:
            raise OSError("XDG_RUNTIME_DIR не задан: не определена сессия Wayland")
        wayland_path = os.path.join(runtime_dir, display)
    # Одна сессия — один адрес; basename не отличает вложенный compositor.
    path_hash = 14695981039346656037
    for byte in os.fsencode(os.path.realpath(wayland_path)):
        path_hash = ((path_hash ^ byte) * 1099511628211) & 0xffffffffffffffff
    return f"\0shojiwm-output-power-{os.getuid()}-{path_hash:016x}"


def notify_failure(text):
    """Показать пользователю критическое уведомление (кнопка Screen Off).

    Вызывается только при провале инициированного человеком Screen Off;
    машинные команды (state, таймерная температура) уведомлений не создают.
    Отсутствие notify-send или шины не должно ронять сам обработчик отказа.
    """
    try:
        subprocess.run(
            ["notify-send", "--app-name", "ShojiWM", "--urgency", "critical",
             text],
            timeout=5,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        pass


def _readline_bounded(sock, timeout):
    """Одна строка без \\n; "" = EOF, None = таймаут.

    Граница кадра LINE_LIMIT включает \\n: перевод >= LINE_LIMIT и буфер
    без перевода длиной >= LINE_LIMIT — мусор, а не строка протокола.
    """
    deadline = time.monotonic() + timeout
    buf = b""
    while True:
        nl = buf.find(b"\n")
        if nl >= 0:
            if nl >= LINE_LIMIT:
                return "error line exceeds protocol limit"
            return buf[:nl].decode("utf-8", "replace").strip()
        if len(buf) >= LINE_LIMIT:
            return "error line exceeds protocol limit"
        remaining = max(0, deadline - time.monotonic())
        if not select.select([sock], [], [], remaining)[0]:
            return None
        chunk = sock.recv(LINE_LIMIT)
        if not chunk:
            return ""
        buf += chunk


def _transact_temperature(cmd):
    """Подключиться, отправить команду температуры, вернуть строку ответа."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(CONNECT_TIMEOUT)
        sock.connect(native_address())
        payload = (cmd + "\n").encode()
        if len(payload) > LINE_LIMIT:
            raise OSError("команда длиннее границы протокола")
        # Таймаут держим и на отправку: только после неё переводим сокет
        # в режим чтения без таймаута (select сам ограничен по времени).
        sock.sendall(payload)
        sock.settimeout(None)
        return _readline_bounded(sock, REPLY_TIMEOUT)
    finally:
        sock.close()


def main(argv):
    if len(argv) == 2 and argv[1] == "identity":
        command = "identity"
        expected = "ok identity"
    elif len(argv) == 3 and argv[1] == "temperature":
        try:
            value = int(argv[2])
        except ValueError:
            print(f"shoji-native: температура не целое: {argv[2]!r}",
                  file=sys.stderr)
            return 1
        if not 1000 <= value <= 20000:
            print(f"shoji-native: температура {value} вне диапазона "
                  f"1000..20000", file=sys.stderr)
            return 1
        command = f"temperature {value}"
        expected = "ok temperature"
    else:
        print("usage: shoji_native.py identity | temperature <1000..20000>",
              file=sys.stderr)
        return 1

    try:
        reply = _transact_temperature(command)
    except OSError as err:
        print(f"shoji-native: композитор недоступен ({command}): {err}",
              file=sys.stderr)
        return 1

    if reply == "ok deferred":
        # Явно НЕ аппаратное применение: цель записана, применится при
        # пробуждении тьмы/VT. Не успех железа, но и не ошибка тика.
        print("shoji-native: deferred (тьма или неактивный VT), "
              "цель записана композитором")
        return 0
    if reply == expected:
        return 0
    print(f"shoji-native: {command} ответил {reply!r}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
