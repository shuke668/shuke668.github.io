param(
  [string]$Message = "update: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
)

$ErrorActionPreference = "Stop"
$hugo = Join-Path $env:USERPROFILE ".local\opt\hugo\hugo.exe"

if (-not (Test-Path $hugo)) {
  Write-Host "未找到 Hugo：$hugo" -ForegroundColor Red
  Write-Host "请先把 hugo.exe 放到该目录，或修改本脚本中的路径。" -ForegroundColor Yellow
  exit 1
}

Push-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
try {
  Write-Host "构建中..." -ForegroundColor DarkGray
  & $hugo --gc --minify --quiet
  if ($LASTEXITCODE -ne 0) { throw "Hugo 构建失败" }

  $changes = git status --porcelain
  if (-not $changes) {
    Write-Host "没有需要提交的改动。" -ForegroundColor Yellow
    exit 0
  }

  git add -A
  git commit -m $Message
  git push
  Write-Host "已发布：$Message" -ForegroundColor Green
}
catch {
  Write-Host "发布中止：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
finally {
  Pop-Location
}
