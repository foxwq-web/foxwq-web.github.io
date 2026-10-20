#!/usr/bin/env python3

import hashlib
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import urllib.request


def install(destination):
    destination.mkdir(parents=True, exist_ok=True)
    lock = json.loads(Path(__file__).with_name('toolchain.json').read_text())
    for tool in lock['downloads']:
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'download.tar.gz'
            digest = hashlib.sha256()
            with urllib.request.urlopen(tool['url'], timeout=120) as response, archive.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != tool['sha256']:
                raise ValueError(f"Checksum mismatch for {tool['name']}")
            with tarfile.open(archive) as source:
                source.extractall(temporary, filter='data')
            (Path(temporary) / tool['directory']).rename(destination / tool['name'])


if __name__ == '__main__':
    install(Path(sys.argv[1]))
