# Fetch ElevenLabs Agent Config
# Usage: .\fetch-agent-config.ps1
#
# Set these environment variables before running:
#   $env:ELEVENLABS_API_KEY = "your-api-key"
#   $env:ELEVENLABS_AGENT_ID = "your-agent-id"
#
# Or pass them as parameters:
#   .\fetch-agent-config.ps1 -ApiKey "key" -AgentId "id"

param(
    [string]$ApiKey = $env:ELEVENLABS_API_KEY,
    [string]$AgentId = $env:ELEVENLABS_AGENT_ID
)

if (-not $ApiKey) {
    Write-Error "No API key provided. Set `$env:ELEVENLABS_API_KEY or pass -ApiKey"
    exit 1
}

if (-not $AgentId) {
    $AgentId = "agent_01jysz8r0bejrvx2d9wv8gckca"
    Write-Host "Using default Agent ID: $AgentId"
}

$url = "https://api.elevenlabs.io/v1/convai/agents/$AgentId"
$outFile = Join-Path $PSScriptRoot "agent-config.json"

Write-Host "Fetching agent config from ElevenLabs..."

try {
    $response = Invoke-RestMethod -Uri $url -Headers @{ "xi-api-key" = $ApiKey } -Method Get
    $response | ConvertTo-Json -Depth 20 | Set-Content -Path $outFile -Encoding UTF8
    Write-Host "Saved to $outFile"
} catch {
    Write-Error "Failed to fetch agent config: $_"
    exit 1
}
