# 안전보건 입찰 평가표 - 인터넷 공개 실행 (Cloudflare 터널)
#
# ngrok 과 달리 접속자에게 경고 페이지가 뜨지 않습니다.
# 주소는 실행할 때마다 새로 바뀝니다.
#
# 사용법: PowerShell에서  .\start-public-cloudflare.ps1
#
# 비밀번호: 환경변수 SAFETY_PASSWORD 가 있으면 사용하고, 없으면 실행 시 입력받습니다.
$PASSWORD = $env:SAFETY_PASSWORD
if (-not $PASSWORD) { $PASSWORD = Read-Host "  접속 비밀번호를 입력하세요" }
if (-not $PASSWORD) { Write-Host "비밀번호가 비어 있어 종료합니다." -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------
Set-Location $PSScriptRoot

$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cf)) { $cf = "C:\Program Files\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cf)) {
  Write-Host "cloudflared 가 설치되어 있지 않습니다. 아래 명령으로 설치하세요:" -ForegroundColor Red
  Write-Host "  winget install --id Cloudflare.cloudflared"
  exit 1
}

# 이미 8080 포트를 쓰고 있으면 먼저 정리
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300

$env:SAFETY_PASSWORD = $PASSWORD
$server = Start-Process node -ArgumentList "server.js" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "   안전보건 입찰 평가표 - 인터넷 공개 중" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "   비밀번호 : $PASSWORD" -ForegroundColor Yellow
Write-Host ""
Write-Host "   잠시 후 표시되는 https://....trycloudflare.com 주소를 공유하세요."
Write-Host "   종료하려면 이 창에서 Ctrl+C 를 누르세요."
Write-Host ""

try {
  & $cf tunnel --url http://localhost:8080 --no-autoupdate
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "  서버를 종료했습니다. 이제 외부에서 접속할 수 없습니다." -ForegroundColor Green
}
