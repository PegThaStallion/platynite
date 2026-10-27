"""Assemble frontend with a Moonlight 1.19.0 engine; no user credentials or certificates."""
import argparse, hashlib, json, shutil, zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--engine', type=Path, required=True, help='Upstream/compiled WGT containing the native WASM engine')
parser.add_argument('--output', type=Path, default=root/'build/Platynite-unsigned.wgt')
args = parser.parse_args()
widget = args.output.parent/'widget'
widget.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(args.engine) as package:
    # Copy only the unchanged streaming binaries. All application code comes from this fork.
    names = [n for n in package.namelist() if n.startswith('moonlight-wasm.') and '/' not in n]
    if not any(n.endswith('.wasm') for n in names):
        raise SystemExit('Engine package has no WASM streaming engine')
    for name in names:
        (widget/name).write_bytes(package.read(name))
for folder in ('platform','static'):
    shutil.copytree(root/'wasm'/folder, widget/folder, dirs_exist_ok=True)
shutil.copytree(root/'res/service', widget/'service', dirs_exist_ok=True)
for name in ('config.xml','platform.js','icon.png'):
    shutil.copy2(root/'res'/name, widget/name)
shutil.copy2(root/'wasm/index.html', widget/'index.html')
shutil.copy2(root/'LICENSE', widget/'LICENSE-Moonlight.txt')
(widget/'BUILD.json').write_text(json.dumps({'name':'Platynite','version':'0.1.0','engine':'Moonlight 1.19.0',
    'enginePackageSha256':hashlib.sha256(args.engine.read_bytes()).hexdigest()}, indent=2))
with zipfile.ZipFile(args.output, 'w', zipfile.ZIP_DEFLATED) as package:
    for file in sorted(widget.rglob('*')):
        if file.is_file() and file.name not in ('author-signature.xml','signature1.xml'):
            package.write(file, file.relative_to(widget).as_posix())
print(args.output)
