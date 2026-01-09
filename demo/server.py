import http.server
import socketserver
import os

PORT = 8000
DIRECTORY = ".."  # Serve from root to access dist/

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

print(f"Serving at http://localhost:{PORT}/demo/streaming.html")
print("Note: COOP/COEP headers enabled for SharedArrayBuffer support.")

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.serve_forever()
