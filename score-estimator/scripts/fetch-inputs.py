#!/usr/bin/env python3
"""Acquire proprietary build inputs without running or redistributing the installer."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent


def verify(data, name, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'Unverified engine version: {name}; expected SHA-256 {expected}')
    return data


def extract(installer, pins):
    import pefile
    pe = pefile.PE(data=installer)
    for resource_type in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if resource_type.id != 10:  # RT_RCDATA
            continue
        for resource in resource_type.directory.entries:
            for language in resource.directory.entries:
                entry = language.data.struct
                data = io.BytesIO(pe.get_data(entry.OffsetToData, entry.Size))
                if zipfile.is_zipfile(data):
                    with zipfile.ZipFile(data) as archive:
                        if all(f'Common/{name}' in archive.namelist() for name in pins):
                            return {name: verify(archive.read(f'Common/{name}'), name, expected)
                                    for name, expected in pins.items()}
    raise ValueError('Fox installer does not contain the expected engine archive')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installer', type=Path, help='Use a locally downloaded FoxWeiQi.exe')
    parser.add_argument('--dll-dir', type=Path, default=HERE.parent / 'dll')
    args = parser.parse_args()
    lock = json.loads((HERE / 'inputs.json').read_text())
    pins = lock['dll_sha256']
    if not args.installer and all((args.dll_dir / name).exists() for name in pins):
        for name, expected in pins.items():
            verify((args.dll_dir / name).read_bytes(), name, expected)
        print('Verified local DLL inputs.')
        return
    if args.installer:
        installer = args.installer.read_bytes()
    else:
        request = urllib.request.Request(lock['installer_url'], headers={
            'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.foxwq.com/'})
        print(f"Downloading build inputs from {lock['installer_url']}", flush=True)
        with urllib.request.urlopen(request, timeout=120) as response:
            installer = response.read()
    inputs = extract(installer, pins)  # Verify both before writing either.
    args.dll_dir.mkdir(parents=True, exist_ok=True)
    for name, data in inputs.items():
        (args.dll_dir / name).write_bytes(data)
    print('Extracted and verified DLL inputs.')


if __name__ == '__main__':
    main()
