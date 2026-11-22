"""Testa e publica ferramentas/firestore.rules no projeto (API firebaserules, token do gcloud).
Uso: python publicar_regras.py <token> [--publicar]"""
import sys, json, os, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
tok, publicar = sys.argv[1], "--publicar" in sys.argv
PROJ = "foco-prova-b2c5c"; API = "https://firebaserules.googleapis.com/v1"
H = {"Authorization": "Bearer " + tok, "x-goog-user-project": PROJ, "Content-Type": "application/json"}
fonte = open(os.path.join(os.path.dirname(__file__), "firestore.rules"), encoding="utf-8").read()
def req(m, url, corpo=None):
    r = urllib.request.Request(url, method=m, data=json.dumps(corpo).encode() if corpo is not None else None, headers=H)
    try:
        with urllib.request.urlopen(r) as x: return json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: print("ERRO", e.code, e.read().decode()[:800]); sys.exit(1)
src = {"files": [{"name": "firestore.rules", "content": fonte}]}
P = "/databases/(default)/documents"
fb = lambda **k: {"tipo": "ideia", "texto": "Gostei do app!", "uid": "", "email": "", "nome": "", "contato": "", "data": 1, "pagina": "inicio", "idioma": "pt", "lido": False, **k}
auth = {"uid": "u1", "token": {"email": "aluno@gmail.com", "email_verified": True}}
casos = [
    ("anônimo envia feedback", "ALLOW", {"auth": None, "path": P + "/feedback/a", "method": "create", "resource": {"data": fb()}}),
    ("logado envia com o próprio e-mail", "ALLOW", {"auth": auth, "path": P + "/feedback/b", "method": "create", "resource": {"data": fb(uid="u1", email="aluno@gmail.com", nome="Aluno")}}),
    ("logado finge outro e-mail", "DENY", {"auth": auth, "path": P + "/feedback/c", "method": "create", "resource": {"data": fb(uid="u1", email="outro@gmail.com")}}),
    ("tipo inválido", "DENY", {"auth": None, "path": P + "/feedback/d", "method": "create", "resource": {"data": fb(tipo="spam")}}),
    ("campo extra", "DENY", {"auth": None, "path": P + "/feedback/e", "method": "create", "resource": {"data": fb(x=1)}}),
    ("aluno não lê feedbacks", "DENY", {"auth": auth, "path": P + "/feedback/a", "method": "get"}),
    ("cria duelo próprio", "ALLOW", {"auth": auth, "path": P + "/duelos/d1", "method": "create", "resource": {"data": {"criador": "u1", "criadorNome": "Aluno", "titulo": "cap 25", "idioma": "es", "questoes": [{"enunciado": "x"}], "criado": 1, "resultados": {}}}}),
    ("cria duelo em nome de outro", "DENY", {"auth": auth, "path": P + "/duelos/d2", "method": "create", "resource": {"data": {"criador": "u9", "criadorNome": "X", "titulo": "t", "idioma": "es", "questoes": [], "criado": 1, "resultados": {}}}}),
    ("grava o próprio ranking", "ALLOW", {"auth": auth, "path": P + "/ranking/2026-S47/pessoas/u1", "method": "create", "resource": {"data": {"nome": "Aluno A.", "av": None, "turma": "FISIO1-C", "xp": 120, "atualizado": 1}}}),
    ("grava ranking de outro", "DENY", {"auth": auth, "path": P + "/ranking/2026-S47/pessoas/u2", "method": "create", "resource": {"data": {"nome": "X", "av": None, "turma": "", "xp": 99999, "atualizado": 1}}}),
    ("XP absurdo no ranking", "DENY", {"auth": auth, "path": P + "/ranking/2026-S47/pessoas/u1", "method": "create", "resource": {"data": {"nome": "A", "av": None, "turma": "", "xp": 999999, "atualizado": 1}}}),
    ("sem login não vê ranking", "DENY", {"path": P + "/ranking/2026-S47/pessoas/u1", "method": "get"}),
]
# na API de teste, os dados novos (request.resource) vão dentro de "request"
suite = {"testCases": [{"expectation": e, "request": {k: v for k, v in r.items() if v is not None}} for _, e, r in casos]}
res = req("POST", f"{API}/projects/{PROJ}:test", {"source": src, "testSuite": suite})
ok = True
for (nome, esp, _), r in zip(casos, res.get("testResults", [])):
    passou = r.get("state") == "SUCCESS"; ok &= passou
    print(("OK   " if passou else "FALHA"), esp, "-", nome, "" if passou else json.dumps(r.get("debugMessages") or r)[:300])
if res.get("issues"): print("PROBLEMAS:", json.dumps(res["issues"], ensure_ascii=False)[:800]); ok = False
if not ok: sys.exit(1)
if publicar:
    rs = req("POST", f"{API}/projects/{PROJ}/rulesets", {"source": src})
    req("PATCH", f"{API}/projects/{PROJ}/releases/cloud.firestore", {"release": {"name": f"projects/{PROJ}/releases/cloud.firestore", "rulesetName": rs["name"]}})
    print("REGRAS PUBLICADAS:", rs["name"])
