"""Transforma um site do Firebase Hosting num redirecionamento para outro endereço (sem arquivos).
Uso: python redirecionar_firebase.py <site_id> <projeto> <token> <destino>
Ex.: python redirecionar_firebase.py focoprova foco-prova-b2c5c TOKEN https://hipocampo.web.app"""
import sys, json, urllib.request

site, projeto, token, destino = sys.argv[1:5]
API = "https://firebasehosting.googleapis.com/v1beta1"
H = {"Authorization": f"Bearer {token}", "x-goog-user-project": projeto, "Content-Type": "application/json"}

def req(metodo, url, corpo=None):
    r = urllib.request.Request(url, data=json.dumps(corpo).encode() if corpo is not None else None, method=metodo, headers=H)
    with urllib.request.urlopen(r) as resp:
        t = resp.read()
        return json.loads(t) if t else {}

# qualquer caminho vai para o mesmo caminho no destino (302: dá para desfazer publicando o app de novo)
versao = req("POST", f"{API}/sites/{site}/versions", {"config": {"redirects": [
    {"regex": "^/(.*)$", "statusCode": 302, "location": destino.rstrip("/") + "/:1"}]}})["name"]
print("versão:", versao)
req("PATCH", f"{API}/{versao}?update_mask=status", {"status": "FINALIZED"})
rel = req("POST", f"{API}/sites/{site}/releases?versionName={versao}", {})
print("REDIRECIONADO:", rel.get("name"))
