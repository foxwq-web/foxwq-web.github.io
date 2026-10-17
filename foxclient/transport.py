"""Threaded TCP framing with bounded buffers and serialized writes."""
import socket
import threading
from protocol import framing


class Connection:
    def __init__(self, host, port, receive, failed, tgw=None):
        self.socket = socket.create_connection((host, port), timeout=10)
        self.socket.settimeout(1)
        self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.receive, self.failed = receive, failed
        self.lock = threading.Lock()
        self.closed = threading.Event()
        if tgw:
            target_host, target_port = tgw
            if any(c in target_host for c in '\r\n'):
                self.socket.close()
                raise ValueError('invalid TGW host')
            self.socket.sendall(f'tgw_l7_forward\r\nHost: {target_host}:{target_port}\r\n\r\n'.encode('ascii'))
        self.thread = threading.Thread(target=self._read, daemon=True)

    def start(self):
        self.thread.start()

    def send(self, command, payload):
        packet = framing.encode(command, payload, compress=True)
        with self.lock:
            if self.closed.is_set():
                raise ConnectionError('connection closed')
            self.socket.sendall(packet)

    def _read(self):
        buffer = bytearray()
        try:
            while not self.closed.is_set():
                try:
                    part = self.socket.recv(65536)
                except socket.timeout:
                    continue
                if not part:
                    raise ConnectionError('Fox closed the connection')
                buffer.extend(part)
                if len(buffer) > 11 * 1024 * 1024:
                    raise ValueError('receive buffer limit exceeded')
                while (decoded := framing.decode_one(buffer)) is not None:
                    frame, consumed = decoded
                    del buffer[:consumed]
                    self.receive(frame)
        except Exception as exc:
            if not self.closed.is_set():
                self.failed(str(exc))
        finally:
            self.close()

    def close(self):
        if not self.closed.is_set():
            self.closed.set()
            try:
                self.socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.socket.close()
