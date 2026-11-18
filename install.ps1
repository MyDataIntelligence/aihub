# aihub installer for Windows. Re-running it updates.
#   irm https://raw.githubusercontent.com/MyDataIntelligence/aihub/main/install.ps1 | iex
#   .\install.ps1 [-Next] [-Uninstall] [-WhatIf]
# Without a parameter block on purpose: that keeps `irm ... | iex` working. Through iex use the environment variables
# AIHUB_NEXT=1, AIHUB_UNINSTALL=1, AIHUB_WHATIF=1 and AIHUB_PACKAGE=<name> (for example @org/aihub from your own feed).
$flags = @($args | ForEach-Object { "$_".ToLowerInvariant() })
$Next = ($flags -contains '-next') -or ($env:AIHUB_NEXT -eq '1')
$Uninstall = ($flags -contains '-uninstall') -or ($env:AIHUB_UNINSTALL -eq '1')
$WhatIf = ($flags -contains '-whatif') -or ($env:AIHUB_WHATIF -eq '1')
$Package = if ($env:AIHUB_PACKAGE) { $env:AIHUB_PACKAGE } else { '@ferronhooi/aihub' }
$Tag = if ($Next) { 'next' } else { 'latest' }

function Step($text, [scriptblock]$action) {
    if ($WhatIf) { Write-Host "PLAN: $text"; return }
    Write-Host "==> $text"
    & $action
}

if ($Uninstall) {
    Step 'aihub skills uninstall' { & aihub skills uninstall }
    Step "npm rm -g $Package" { & npm rm -g $Package }
    if (-not $WhatIf) { Write-Host 'aihub is removed. Your team repositories are untouched.' }
    return
}

# 1. Node 18 or newer. Never installed silently.
if ($WhatIf) {
    Write-Host 'PLAN: check that Node 18 or newer is installed'
} else {
    $nodeOk = $false
    try {
        $v = (& node -v) -replace '^v', ''
        $nodeOk = [int]($v.Split('.')[0]) -ge 18
    } catch { }
    if (-not $nodeOk) {
        Write-Host 'Node 18 or newer is needed and was not found.'
        Write-Host 'Install it yourself, then run this installer again:'
        Write-Host '    winget install OpenJS.NodeJS.LTS'
        Write-Host '(or download it from https://nodejs.org). Nothing was installed.'
        exit 1
    }
}

# 2. The CLI (npm uses the registry from your .npmrc, so a team feed works too).
Step "npm i -g $Package@$Tag" { & npm i -g "$Package@$Tag"; if ($LASTEXITCODE -ne 0) { throw 'npm install failed; check your .npmrc (registry and sign-in)' } }

# 3. Skills and slash commands for opencode, Codex and Copilot.
Step 'aihub skills install --global --client all' { & aihub skills install --global --client all }

# 4. Check.
$doctor = ''
Step 'aihub doctor' { $script:doctor = (& aihub doctor | Out-String); Write-Host $script:doctor }

if (-not $WhatIf) {
    Write-Host ''
    Write-Host 'Next steps:'
    $n = 1
    if ($doctor -match '(?m)^FIX\s+auth') { Write-Host "  $n. Sign in: az login   (or set AIHUB_ADO_PAT)"; $n++ }
    Write-Host "  $n. In your team repository run: aihub init"; $n++
    Write-Host "  $n. Try it in your coding agent: /pr"
}