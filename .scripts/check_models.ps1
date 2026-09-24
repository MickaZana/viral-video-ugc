try {
  $r = Invoke-RestMethod -Uri 'http://localhost:20128/v1/models' -Method Get -ErrorAction Stop
  $json = $r | ConvertTo-Json -Depth 2
  if ($json.Length -gt 1000) { $json.Substring(0,1000) } else { $json }
} catch {
  Write-Host 'Request failed:' $_.Exception.Message
}
