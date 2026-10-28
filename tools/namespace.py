"""Apply the fork's fixed identity to the upstream frontend (idempotent)."""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
files = [root/'res/config.xml', root/'res/service/service.js', *list((root/'wasm/platform').glob('*.js'))]
for path in files:
    text = path.read_text(encoding='utf-8')
    text = text.replace('MoonLightS.MoonlightWasm', 'PlatyNite1.Platynite').replace('MoonLightS.service', 'PlatyNite1.service')
    text = text.replace('package="MoonLightS"', 'package="PlatyNite1"').replace("'.MoonlightWasm'", "'.Platynite'")
    text = text.replace('http://samsung.tv/MoonlightWasm', 'http://samsung.tv/Platynite')
    text = text.replace('GameStreamingDB', 'PlatyniteStreamingDB').replace('GameStreamingStore', 'PlatyniteStreamingStore')
    text = text.replace('moonlight_service', 'platynite_service').replace(':8888', ':8889').replace('listen(8888,', 'listen(8889,')
    text = text.replace('__REPO_OWNER__', 'PegThaStallion').replace('__REPO_NAME__', 'platynite')
    text = text.replace('https://github.com/brightcraft/moonlight-tizen/releases', 'https://github.com/PegThaStallion/platynite/releases')
    if path.name == 'config.xml':
        text = text.replace('version="1.19.0"', 'version="0.2.0"').replace('<name>Moonlight</name>', '<name>Platynite</name>')
        text = text.replace('<description>Moonlight Game Streaming</description>', '<description>Playnite library powered by Moonlight</description>')
    path.write_text(text, encoding='utf-8', newline='\n')
html = root/'wasm/index.html'
text = html.read_text(encoding='utf-8').replace('<title data-i18n="Moonlight Game Streaming">Moonlight Game Streaming</title>', '<title>Platynite</title>')
if 'platform/platynite.css' not in text:
    text = text.replace('</head>', '  <link rel="stylesheet" href="platform/platynite.css">\n</head>')
    text = text.replace('</body>', '  <script src="platform/platynite.js"></script>\n</body>')
html.write_text(text, encoding='utf-8', newline='\n')
path = root/'wasm/platform/messages.js'; text = path.read_text(encoding='utf-8')
if 'window.Platynite.connected' not in text:
    text = text.replace("} else if (msg === 'Connection Established') {", "} else if (msg === 'Connection Established') {\n    if (window.Platynite) window.Platynite.connected();")
    text = text.replace("if (msg.indexOf('streamTerminated: ') === 0) {", "if (msg.indexOf('streamTerminated: ') === 0) {\n    if (window.Platynite) window.Platynite.ended();")
path.write_text(text, encoding='utf-8', newline='\n')
