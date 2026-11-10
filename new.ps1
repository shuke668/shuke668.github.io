param(
  [Parameter(Mandatory = $true)][string]$Title,
  [ValidateSet("tech", "world", "biz", "defense")][string]$Category = "tech",
  [ValidateSet("post", "pick")][string]$Kind = "post",
  [string]$Summary = "",
  [string]$Angle = "",
  [switch]$Ai
)

$now = Get-Date
$slug = "p-" + $now.ToString("yyyyMMdd-HHmmss")
$dir = Join-Path "content\zh\posts" (Join-Path $now.ToString("yyyy") (Join-Path $now.ToString("MM") $slug))
New-Item -ItemType Directory -Path $dir -Force | Out-Null

$writer = if ($Ai) { "ai" } else { "human" }
$date = $now.ToString("yyyy-MM-ddTHH:mm:sszzz")

$front = @(
  "---",
  "title: `"$Title`"",
  "date: $date",
  "kind: $Kind",
  "categories: [`"$Category`"]",
  "tags: []",
  "summary: `"$Summary`"",
  "featured: false",
  "draft: true",
  "writer: $writer"
)
if ($Angle) { $front += "angle: `"$Angle`"" }
$front += @("---", "", "")

Set-Content -Path (Join-Path $dir "index.md") -Value ($front -join "`n") -Encoding UTF8

Write-Host "已创建：$dir\index.md" -ForegroundColor Green
if ($Ai) { Write-Host "已标记 writer: ai，推送后由 AI 自动补全正文。" -ForegroundColor DarkGray }
