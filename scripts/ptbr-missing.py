#!/usr/bin/env python3
"""Lista chaves que existem em en.json mas faltam (ou mudaram) em ptBR.json.

Uso, depois de trazer atualizações do upstream:
    python3 scripts/ptbr-missing.py            # lista chaves faltando
    python3 scripts/ptbr-missing.py --fill     # copia o inglês para as faltantes (para traduzir depois)
"""
import json, sys, os

ROOT = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'src', 'locales')
en = json.load(open(os.path.join(ROOT, 'en.json')))
pt_path = os.path.join(ROOT, 'ptBR.json')
pt = json.load(open(pt_path))

def flat(o, p=''):
    r = {}
    for k, v in o.items():
        if isinstance(v, dict): r.update(flat(v, p + k + '.'))
        else: r[p + k] = v
    return r

fe, fp = flat(en), flat(pt)
missing = [k for k in fe if k not in fp]
stale = [k for k in fp if k not in fe]

print(f'faltando em ptBR: {len(missing)}')
for k in missing: print(f'  + {k} = {fe[k]!r}')
print(f'sobrando em ptBR (removidas do en): {len(stale)}')
for k in stale: print(f'  - {k}')

if '--fill' in sys.argv and (missing or stale):
    def rebuild(e, p):
        return {k: (rebuild(e[k], p.get(k, {})) if isinstance(e[k], dict) else p.get(k, e[k])) for k in e}
    out = rebuild(en, pt)
    json.dump(out, open(pt_path, 'w'), ensure_ascii=False, indent=2)
    open(pt_path, 'a').write('\n')
    print(f'\nptBR.json atualizado: {len(missing)} chave(s) copiada(s) do inglês — traduza-as e rode os testes.')
