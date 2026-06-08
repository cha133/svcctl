# Run svcctl CLI in dev mode
Set-Location $PSScriptRoot\..
bun run src/index.ts @args
