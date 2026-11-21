# Publica o Hipocampo Study em hipocampo.web.app (Firebase) e o GitHub Pages.
# focoprova.web.app só redireciona para o hipocampo (ferramentas/redirecionar_firebase.py) e não recebe mais o app.
$site = Split-Path $PSScriptRoot -Parent
$g = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
# carimba a versão (as abas abertas no celular percebem e se atualizam sozinhas)
$idx = Join-Path $site "index.html"; $v = Get-Date -Format "yyyy-MM-dd-HHmm"
[IO.File]::WriteAllText($idx, ([IO.File]::ReadAllText($idx) -replace '(?m)^const VERSAO_APP = "[\w-]*";', "const VERSAO_APP = `"$v`";"), (New-Object Text.UTF8Encoding $false))
$tok = (& $g auth print-access-token 2>$null).Trim()
python "$PSScriptRoot\publicar_firebase.py" $site hipocampo foco-prova-b2c5c $tok
Set-Location $site; git add -A; git commit -q -m "Atualização"; git push -q origin main
