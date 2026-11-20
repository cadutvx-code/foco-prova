# Publica o Foco Prova nos dois endereços: focoprova.web.app (Firebase) e o GitHub Pages
$site = Split-Path $PSScriptRoot -Parent
$g = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$tok = (& $g auth print-access-token 2>$null).Trim()
python "$PSScriptRoot\publicar_firebase.py" $site focoprova foco-prova-b2c5c $tok
Set-Location $site; git add -A; git commit -q -m "Atualização"; git push -q origin main
