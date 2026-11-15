# Сборка index.html из исходников: python3 src/build.py
import pathlib
d = pathlib.Path(__file__).parent
s = (d/'app.src.html').read_text(encoding='utf-8')
s = s.replace('/*LAME*/', (d/'lame.min.js').read_text(encoding='utf-8')).replace('/*ENGINE*/', (d/'engine.js').read_text(encoding='utf-8'))
(d.parent/'index.html').write_text(s, encoding='utf-8')
print('index.html собран')
