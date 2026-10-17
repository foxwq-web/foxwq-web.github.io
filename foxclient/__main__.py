"""Run with python3 -m foxclient. HTTP UI is restricted to loopback."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
import secrets
from urllib.parse import urlparse
import webbrowser
from .session import Session


def main():
    parser = argparse.ArgumentParser(description='Fox reverse-engineering prototype')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--creds', default='creds')
    parser.add_argument('--fox-host', default='43.132.13.39')
    parser.add_argument('--fox-port', type=int, default=10000)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    session = Session(args.creds, (args.fox_host, args.fox_port))
    csrf = secrets.token_urlsafe(32)
    static = Path(__file__).parent / 'static'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, body, kind='application/json', status=200):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

        def do_GET(self):
            if not self.valid_host():
                self.reply({'error': 'Invalid host'}, status=403)
                return
            path = urlparse(self.path).path
            if path == '/api/state':
                self.reply(dict(session.snapshot(), csrf=csrf))
            elif path == '/game.sgf':
                with session.lock:
                    self.reply(session.board.sgf(session.result).encode(), 'application/x-go-sgf')
            elif path in ('/', '/app.js', '/style.css'):
                name = 'index.html' if path == '/' else path[1:]
                kind = {'html': 'text/html; charset=utf-8', 'js': 'text/javascript; charset=utf-8', 'css': 'text/css; charset=utf-8'}[name.rsplit('.', 1)[1]]
                self.reply((static / name).read_bytes(), kind)
            else:
                self.reply({'error': 'Not found'}, status=404)

        def do_POST(self):
            if not self.valid_host() or self.headers.get('X-Fox-Token') != csrf:
                self.reply({'error': 'Invalid request'}, status=403)
                return
            try:
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= 8192:
                    raise ValueError('Invalid request length')
                body = json.loads(self.rfile.read(length))
                action = urlparse(self.path).path
                if action == '/api/login': session.login()
                elif action == '/api/disconnect': session.close()
                elif action == '/api/local': session.local_game()
                elif action == '/api/match': session.match()
                elif action == '/api/cancel': session.cancel_match()
                elif action == '/api/request-score': session.request_score()
                elif action == '/api/confirm': session.confirm(body.get('accept',False))
                elif action == '/api/play': session.play(int(body['x']), int(body['y']))
                elif action == '/api/pass': session.pass_turn()
                elif action == '/api/resign': session.resign()
                elif action == '/api/score': session.score(body.get('dead', []))
                else: raise ValueError('Unknown action')
                self.reply(session.snapshot())
            except (ValueError, KeyError, TypeError) as exc:
                self.reply({'error': str(exc)}, status=400)

    class LocalHTTPServer(ThreadingHTTPServer):
        def server_bind(self):
            TCPServer.server_bind(self)
            self.server_name='127.0.0.1'
            self.server_port=self.server_address[1]

    server = LocalHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'Fox prototype: {url}', flush=True)
    print('Log in with your local credential file, then find a normal match.', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        session.close()
        server.server_close()


if __name__ == '__main__':
    main()
