"""Publica uma pasta no Firebase Hosting usando a API REST (sem firebase-tools).
Uso: python publicar_firebase.py <pasta> <site_id> <projeto> <token>"""
import sys, os, gzip, hashlib, json, urllib.request

pasta, site, projeto, token = sys.argv[1:5]
API = "https://firebasehosting.googleapis.com/v1beta1"
H = {"Authorization": f"Bearer {token}", "x-goog-user-project": projeto, "Content-Type": "application/json"}

def req(metodo, url, corpo=None, headers=None, bruto=False):
    dados = corpo if bruto else (json.dumps(corpo).encode() if corpo is not None else None)
    r = urllib.request.Request(url, data=dados, method=metodo, headers=headers or H)
    with urllib.request.urlopen(r) as resp:
        t = resp.read()
        return json.loads(t) if t and not bruto else t

# 1) arquivos: cada um compactado em gzip e identificado pelo sha256 do gzip
arquivos, por_hash = {}, {}
for raiz, _, nomes in os.walk(pasta):
    if ".git" in raiz.split(os.sep): continue
    for n in nomes:
        caminho = os.path.join(raiz, n)
        rel = "/" + os.path.relpath(caminho, pasta).replace(os.sep, "/")
        if rel.startswith("/.git") or rel.startswith("/ferramentas/") or rel in ("/README.md", "/.nojekyll"): continue
        gz = gzip.compress(open(caminho, "rb").read(), mtime=0)
        h = hashlib.sha256(gz).hexdigest()
        arquivos[rel] = h; por_hash[h] = gz
print("arquivos:", len(arquivos))

# 2) nova versão com cabeçalhos (sem cache no index para atualizações aparecerem na hora)
versao = req("POST", f"{API}/sites/{site}/versions", {"config": {"headers": [
    {"glob": "/index.html", "headers": {"Cache-Control": "no-cache"}},
    {"glob": "/", "headers": {"Cache-Control": "no-cache"}}]}})["name"]
print("versão:", versao)

# 3) informa os arquivos; envia só os que o Firebase ainda não tem
pop = req("POST", f"{API}/{versao}:populateFiles", {"files": arquivos})
faltam, url_up = pop.get("uploadRequiredHashes", []), pop.get("uploadUrl")
print("enviando:", len(faltam))
for h in faltam:
    req("POST", f"{url_up}/{h}", por_hash[h], headers={"Authorization": f"Bearer {token}", "x-goog-user-project": projeto, "Content-Type": "application/octet-stream"}, bruto=True)

# 4) finaliza e publica
req("PATCH", f"{API}/{versao}?update_mask=status", {"status": "FINALIZED"})
rel = req("POST", f"{API}/sites/{site}/releases?versionName={versao}", {})
print("PUBLICADO:", rel.get("name"))
