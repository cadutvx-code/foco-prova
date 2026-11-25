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
# grupos: o doc lido por get() é simulado (functionMocks)
GR = P + "/grupos/uni-c__fisio"; PT = GR + "/semanas/2026-S48/pontos/u1"
G_U1 = {"data": {"nome": "Fisio", "membros": ["u1", "u2"], "admin": "u2"}}; G_OUTROS = {"data": {"nome": "Fisio", "membros": ["u2"], "admin": "u2"}}
def mock(g): return [{"function": "get", "args": [{"exactValue": GR}], "result": {"value": g}}]
pt = lambda xp=10, **k: {"data": {"nome": "Aluno A.", "av": None, "xp": xp, "atualizado": 5, **k}}
G = lambda nome, esp, metodo, caminho, g=G_U1, quem=auth, novo=None, antes=None: (nome, esp, {"auth": quem, "path": caminho, "method": metodo, "resource": novo, "_mocks": mock(g), "_antes": antes})
casos_grupo = [
    G("membro lê o grupo", "ALLOW", "get", GR, antes=G_U1),
    G("não membro não lê o grupo", "DENY", "get", GR, antes=G_OUTROS),
    G("sem login não lê o grupo", "DENY", "get", GR, quem=None, antes=G_U1),
    G("ninguém cria grupo pelo site", "DENY", "create", GR, novo=G_U1),
    G("administrador do grupo não altera pelo site", "DENY", "update", GR, quem={**auth, "uid": "u2"}, novo=G_U1, antes=G_U1),
    G("ninguém apaga grupo pelo site", "DENY", "delete", GR, antes=G_U1),
    G("membro não lê a senha", "DENY", "get", GR + "/privado/dados", antes={"data": {"hash": "x"}}),
    G("administrador do grupo não lê a senha", "DENY", "get", GR + "/privado/dados", quem={**auth, "uid": "u2"}, antes={"data": {"hash": "x"}}),
    G("membro não grava a senha", "DENY", "update", GR + "/privado/dados", novo={"data": {"hash": "y"}}, antes={"data": {"hash": "x"}}),
    G("membro grava os próprios pontos", "ALLOW", "create", PT, novo=pt()),
    G("membro soma pontos", "ALLOW", "update", PT, novo=pt(50), antes=pt(10)),
    G("não membro não pontua", "DENY", "create", PT, g=G_OUTROS, novo=pt()),
    G("não pontua no lugar de outro", "DENY", "create", GR + "/semanas/2026-S48/pontos/u2", novo=pt()),
    G("primeiro envio absurdo", "DENY", "create", PT, novo=pt(9000)),
    G("salto absurdo de pontos", "DENY", "update", PT, novo=pt(9000), antes=pt(10)),
    G("pontos não diminuem", "DENY", "update", PT, novo=pt(5), antes=pt(10)),
    G("campo extra nos pontos", "DENY", "create", PT, novo=pt(admin=True)),
    G("semana inválida", "DENY", "create", GR + "/semanas/qualquer/pontos/u1", novo=pt()),
    G("membro vê o ranking do grupo", "ALLOW", "get", PT, antes=pt()),
    G("não membro não vê o ranking do grupo", "DENY", "get", PT, g=G_OUTROS, antes=pt()),
    G("sem login não pontua", "DENY", "create", PT, quem=None, novo=pt()),
    G("ninguém apaga pontos", "DENY", "delete", PT, antes=pt()),
]
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
    ("conta grava o próprio funil", "ALLOW", {"auth": auth, "path": P + "/funil/u1", "method": "create", "resource": {"data": {"email": "aluno@gmail.com", "nome": "Aluno", "ap": "ap_abc123", "ultimo": 5, "viu": 1, "clicou": 5, "qr": 5}}}),
    ("aparelho sem login grava o funil", "ALLOW", {"auth": None, "path": P + "/funil/ap_abc123", "method": "create", "resource": {"data": {"email": "", "nome": "", "ap": "ap_abc123", "ultimo": 5, "viu": 1, "limite": 5}}}),
    ("funil com e-mail de outro", "DENY", {"auth": auth, "path": P + "/funil/u1", "method": "create", "resource": {"data": {"email": "outro@gmail.com", "nome": "", "ap": "ap_abc123", "ultimo": 5}}}),
    ("funil de outra conta", "DENY", {"auth": auth, "path": P + "/funil/u2", "method": "create", "resource": {"data": {"email": "aluno@gmail.com", "nome": "", "ap": "ap_abc123", "ultimo": 5}}}),
    ("sem login não grava e-mail no funil", "DENY", {"auth": None, "path": P + "/funil/ap_abc123", "method": "create", "resource": {"data": {"email": "x@gmail.com", "nome": "", "ap": "ap_abc123", "ultimo": 5}}}),
    ("campo extra no funil", "DENY", {"auth": auth, "path": P + "/funil/u1", "method": "create", "resource": {"data": {"email": "aluno@gmail.com", "nome": "", "ap": "ap_abc123", "ultimo": 5, "pagou": 5}}}),
    ("aluno não lê o funil", "DENY", {"auth": auth, "path": P + "/funil/u1", "method": "get"}),
    *casos_grupo,
    ("sem login não vê ranking", "DENY", {"path": P + "/ranking/2026-S47/pessoas/u1", "method": "get"}),
]
# na API de teste, os dados novos (request.resource) vão dentro de "request"
suite = {"testCases": [{"expectation": e, "request": {k: v for k, v in r.items() if v is not None and not k.startswith("_")}, **({"functionMocks": r["_mocks"]} if r.get("_mocks") else {}), **({"resource": r["_antes"]} if r.get("_antes") else {})} for _, e, r in casos]}
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
