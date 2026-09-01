from pathlib import Path

p = Path('worker/src/public.js')
s = p.read_text(encoding='utf-8')
old = s
s = s.replace("Number(policy.iterations)||310000", "Number(policy.iterations)||100000")
s = s.replace("const iterations=310000;", "const iterations=100000;")
if s == old:
    raise SystemExit('Expected PBKDF2 iteration patterns were not found')
p.write_text(s, encoding='utf-8')
print('Updated Guest PBKDF2 iteration limit to 100000')
