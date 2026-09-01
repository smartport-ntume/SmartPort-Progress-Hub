from pathlib import Path

OLD='20260901.1630'
NEW='20260901.1720'
for name in ['index.html','README.md']:
    p=Path(name)
    s=p.read_text(encoding='utf-8')
    if OLD not in s:
        raise SystemExit(f'{OLD} not found in {name}')
    p.write_text(s.replace(OLD,NEW),encoding='utf-8')
print(f'Bumped build {OLD} -> {NEW}')
