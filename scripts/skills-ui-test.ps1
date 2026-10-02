$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'setup-common.ps1')
$savedEnvironment=@{}
foreach($key in @('DWB_DATA_DIR','DWB_RUNTIME_DIR','DWB_WORKSPACE_DB')){$savedEnvironment[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
$env:DWB_DATA_DIR=Join-Path ([IO.Path]::GetTempPath()) ('dwb-skills-ui-'+[Guid]::NewGuid().ToString('N'))
$testRoot=[IO.Path]::GetFullPath($env:DWB_DATA_DIR)
$env:DWB_RUNTIME_DIR=Join-Path $testRoot 'runtime'
$env:DWB_WORKSPACE_DB=Join-Path $env:DWB_RUNTIME_DIR 'workspaces.db'
try{
  $node=Get-DwbNode
  if(-not $node){throw 'Node.js not found'}
  $source=Join-Path $env:DWB_DATA_DIR 'fixture-skill'
  $null=New-Item -ItemType Directory -Path $source -Force
  $skillText=@'
---
name: ui-skill
description: UI smoke fixture.
---

# UI Skill
Follow the UI test.
'@
  [IO.File]::WriteAllText((Join-Path $source 'SKILL.md'),$skillText)
  $admin=Join-Path $PSScriptRoot 'skills-admin.mjs'
  $fixture=Join-Path $PSScriptRoot 'skills-ui-fixture.mjs'
  $null=Invoke-DwbNode $node @($fixture,'seed') $PSScriptRoot
  function Snapshot {
    $reply=(Invoke-DwbNode $node @($admin,'snapshot') $PSScriptRoot) | ConvertFrom-Json
    if(-not $reply.ok){throw 'Snapshot failed'}
    return $reply.result
  }
  function Click($window,[string]$name) {
    $button=$window.FindName($name)
    if(-not $button.IsEnabled){throw ('Disabled button: '+$name)}
    $button.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
    if($window.FindName('Error').Text){throw $window.FindName('Error').Text}
  }
  Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms
  . (Join-Path $PSScriptRoot 'skills-ui.ps1')
  $global:DwbShell=@{Window=$null}
  $report=Join-Path $env:DWB_DATA_DIR 'skills-ui.txt'
  $script:confirmRemoval=$false
  $actions={param($window)
    if($window.FindName('SkillList').Items.Count -ne 0){throw 'Expected empty library'}
    if(-not $window.FindName('InstallRecommended') -or -not $window.FindName('InstallBrag') -or -not $window.FindName('InstallGithub')){throw 'Remote install controls missing'}
    if(-not $window.FindName('InstallRecommended').IsEnabled){throw 'Recommended GoLive should be installable in empty library'}
    if(-not $window.FindName('InstallBrag').IsEnabled){throw 'Recommended BRAG Slim should be installable in empty library'}
    Click $window 'Install'
    $snapshot=Snapshot
    if($snapshot.skills.Count -ne 1 -or $snapshot.skills[0].id -ne 'ui-skill'){throw 'Install did not persist'}
    $script:installedPath=$snapshot.skills[0].installPath
    if($window.FindName('SkillSource').Text -notlike 'Local*'){throw 'Local source metadata did not render'}
    $window.FindName('DefaultPolicy').SelectedValue='manual'
    Click $window 'SaveDefault'
    if((Snapshot).skills[0].defaultPolicy -ne 'manual'){throw 'Default did not persist'}
    $workspace=$window.FindName('Workspace').Items | Where-Object Name -eq 'workspace-one'
    $window.FindName('Workspace').SelectedItem=$window.FindName('Workspace').Items | Where-Object Name -eq 'workspace-one'
    $window.FindName('WorkspacePolicy').SelectedValue='auto'
    Click $window 'SaveWorkspace'
    $snapshot=Snapshot
    if($snapshot.workspacePolicies.PSObject.Properties[$workspace.Id].Value.'ui-skill' -ne 'auto'){throw 'Override did not persist'}
    $other=$window.FindName('Workspace').Items | Where-Object Name -eq 'workspace-two'
    $window.FindName('Workspace').SelectedItem=$other
    if($window.FindName('WorkspacePolicy').SelectedValue -ne 'manual'){throw 'Override leaked into another workspace'}
    $window.FindName('Workspace').SelectedItem=$window.FindName('Workspace').Items | Where-Object Name -eq 'workspace-one'
    Click $window 'UseDefault'
    if($window.FindName('WorkspacePolicy').SelectedValue -ne 'manual'){throw 'Default inheritance not restored'}
    $window.FindName('DefaultPolicy').SelectedValue='ask'
    Click $window 'SaveDefault'
    $null=Invoke-DwbNode $node @($fixture,'pending') $PSScriptRoot
    Click $window 'Refresh'
    if($window.FindName('Pending').Items.Count -ne 2){throw 'Pending requests missing'}
    $requests=Get-Content (Join-Path $env:DWB_DATA_DIR 'requests.json') -Raw | ConvertFrom-Json
    $window.FindName('Pending').SelectedItem=$window.FindName('Pending').Items | Where-Object Id -eq $requests[0].approvalId
    Click $window 'Approve'
    $window.FindName('Pending').SelectedIndex=0
    Click $window 'Reject'
    $null=Invoke-DwbNode $node @($fixture,'verify-decisions') $PSScriptRoot
    Click $window 'Uninstall'
    if((Snapshot).skills.Count -ne 1){throw 'Cancel uninstall removed the skill'}
  }
  Show-DwbSkills $report $actions { $source } { $script:confirmRemoval }
  if([IO.File]::ReadAllText($report) -ne 'PASS'){throw ('Skills UI failed: '+[IO.File]::ReadAllText($report))}
  $reopen={param($window)
    if($window.FindName('SkillList').Items.Count -ne 1){throw 'Reopened library lost the skill'}
    if($window.FindName('DefaultPolicy').SelectedValue -ne 'ask'){throw 'Reopened library lost policy'}
    $script:confirmRemoval=$true
    Click $window 'Uninstall'
    if($window.FindName('SkillList').Items.Count -ne 0){throw 'Uninstalled skill still rendered'}
    if(Test-Path -LiteralPath $script:installedPath){throw 'Uninstalled package still exists'}
    $null=Invoke-DwbNode $node @($fixture,'verify-uninstalled') $PSScriptRoot
  }
  Show-DwbSkills $report $reopen { $source } { $script:confirmRemoval }
  if([IO.File]::ReadAllText($report) -ne 'PASS'){throw ('Reopened Skills UI failed: '+[IO.File]::ReadAllText($report))}
  Write-Output 'SKILLS_UI_PASS: install, default/override/isolation, approve/reject, cancel removal, reopen and uninstall persisted correctly.'
}finally{
  $global:DwbShell=$null
  $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
  if(-not $testRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($testRoot) -notlike 'dwb-skills-ui-*'){throw 'Refusing cleanup outside the test directory'}
  try{if(Test-Path -LiteralPath $testRoot){Remove-Item -LiteralPath $testRoot -Recurse -Force}}
  finally{foreach($key in $savedEnvironment.Keys){[Environment]::SetEnvironmentVariable($key,$savedEnvironment[$key],'Process')}}
}
