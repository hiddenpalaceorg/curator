# Build Prism for Windows (WinUI 3): Rust core -> C# bindings -> dotnet build.
#
#   pwsh windows/build.ps1 [-Configuration Release] [-Run]
#
# Prerequisites: Rust toolchain, .NET 8 SDK, and uniffi-bindgen-cs
# (installed automatically below when missing).
param(
    [string]$Configuration = "Release",
    [switch]$Run
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# v0.11.0+v0.31.0; keep in sync with the uniffi dependency.
$bindgenRevision = "e10ce410eb3a10cc19c7928b93ea8d84e038c034"
$bindgenRoot = Join-Path $root "target\tools\uniffi-$bindgenRevision"
$bindgenExe = Join-Path $bindgenRoot "bin\uniffi-bindgen-cs.exe"

Push-Location $root
try {
    cargo build -p prism-ffi --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

    cargo install uniffi-bindgen-cs --git https://github.com/NordSecurity/uniffi-bindgen-cs --rev $bindgenRevision --locked --root $bindgenRoot --force
    if ($LASTEXITCODE -ne 0) { throw "installing uniffi-bindgen-cs failed" }
    & $bindgenExe --library target/release/prism_ffi.dll --out-dir windows/PrismWin/Generated
    if ($LASTEXITCODE -ne 0) { throw "binding generation failed" }

    dotnet build windows/PrismWin/PrismWin.csproj -c $Configuration -p:Platform=x64
    if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }

    if ($Run) {
        $exe = Get-ChildItem -Recurse "windows/PrismWin/bin" -Filter PrismWin.exe | Select-Object -First 1
        & $exe.FullName
    }
}
finally {
    Pop-Location
}
