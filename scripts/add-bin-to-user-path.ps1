$dir = 'C:\Users\Ncdevshiv\bin'
$userPath = [System.Environment]::GetEnvironmentVariable('Path','User')
$machinePath = [System.Environment]::GetEnvironmentVariable('Path','Machine')

if (($userPath -split ';') -contains $dir) {
  Write-Host "$dir is already on User PATH"
  exit 0
}

$newUserPath = ($dir + ';' + $userPath) -replace ';;+', ';'
[System.Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')

Write-Host '--- Updated User PATH (first 5 entries) ---'
($newUserPath -split ';') | Select-Object -First 5 | ForEach-Object { Write-Host $_ }

Write-Host '--- Contains target dir? ---'
(($newUserPath -split ';') -contains $dir)