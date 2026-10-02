param([string]$TestReport,[string]$UiTestReport,[switch]$Startup)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms,System.Drawing
. (Join-Path $PSScriptRoot 'tunnel-common.ps1')
. (Join-Path $PSScriptRoot 'preferences-common.ps1')
. (Join-Path $PSScriptRoot 'preferences-ui.ps1')
. (Join-Path $PSScriptRoot 'skills-ui.ps1')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DwbWindowIdentity {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string id);
 [DllImport("shell32.dll")] public static extern int GetCurrentProcessExplicitAppUserModelID(out IntPtr id);
}
'@
$null=[DwbWindowIdentity]::SetCurrentProcessExplicitAppUserModelID('DevWithBebz.DwbMcpStudio')
$hash=[Security.Cryptography.SHA256]::Create()
try{$identity=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($PSScriptRoot+'|'+(Get-DwbDataDirectory)).ToLowerInvariant())))).Replace('-','').Substring(0,24)}finally{$hash.Dispose()}
$wake=New-Object Threading.EventWaitHandle($false,[Threading.EventResetMode]::AutoReset,('Local\DWB-Studio-Wake-'+$identity))
$mutex=New-Object Threading.Mutex($false,('Local\DWB-Studio-UI-'+$identity))
$owned=$false
try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
if(-not $owned){if(-not $Startup){$null=$wake.Set()};$wake.Dispose();$mutex.Dispose();return}
$global:DwbShell=@{Window=$null;AllowClose=$false;Next='setup';Exiting=$false;Frame=$null;Preferences=(Get-DwbPreferences);StartupPending=[bool]$Startup;Quitting=$false;AutoConnectDeadline=$null;AutoConnectProbe=[DateTime]::MinValue}
$tray=New-Object Windows.Forms.NotifyIcon
$tray.Icon=New-Object Drawing.Icon((Join-Path $PSScriptRoot '..\assets\dwb.ico'),32,32)
$tray.Text='DWB MCP Studio';$tray.Visible=$true
function global:Restore-DwbWindow {
  $current=$global:DwbShell.Window
  if($current){$current.ShowInTaskbar=$true;$current.Show();$current.WindowState='Normal';$null=$current.Activate()}
}
function global:Set-DwbPage([string]$Page){
  $global:DwbShell.Next=$Page;$global:DwbShell.AllowClose=$true
  if($global:DwbShell.Window){$global:DwbShell.Window.Close()}
}
function global:Hide-DwbWindow {
  $current=$global:DwbShell.Window
  if($current){$current.Hide();$current.ShowInTaskbar=$false}
}
function global:Exit-DwbApp {
  if($global:DwbShell.Quitting){return $false}
  $global:DwbShell.Quitting=$true
  try{
    Stop-DwbTunnel
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\dist\broker-protocol.js')){
      . (Join-Path $PSScriptRoot 'runtime-upgrade.ps1')
      Stop-DwbRuntimeForSetup (Get-DwbNode)
    }
    $global:DwbShell.Exiting=$true
    Set-DwbPage ''
    return $true
  }catch{
    Restore-DwbWindow
    [Windows.MessageBox]::Show(('ยังปิด MCP ไม่ได้ งานในเครื่องยังคงอยู่ กรุณาจบงานก่อนแล้วลองอีกครั้ง'+[Environment]::NewLine+$_.Exception.Message),'DWB MCP Studio')|Out-Null
    return $false
  }finally{$global:DwbShell.Quitting=$false}
}
function global:Register-DwbWindow($Window){
  $global:DwbShell.Window=$Window;$global:DwbShell.AllowClose=$false
  $Window.Add_Closing({param($sender,$eventArgs)
    if(-not $global:DwbShell.AllowClose){
      $eventArgs.Cancel=$true
      if($global:DwbShell.Preferences.closeAction -eq 'exit'){$null=$sender.Dispatcher.BeginInvoke([Action]{$null=Exit-DwbApp})}else{Hide-DwbWindow}
    }
  })
  $Window.Add_StateChanged({if($global:DwbShell.Preferences.minimizeToTray -and $global:DwbShell.Window.WindowState -eq 'Minimized'){Hide-DwbWindow}})
}
function global:Show-DwbWindow($Window){
  $frame=New-Object Windows.Threading.DispatcherFrame
  $global:DwbShell.Frame=$frame
  $Window.Add_Closed({$global:DwbShell.Frame.Continue=$false})
  $Window.Show()
  if($global:DwbShell.StartupPending){
    $global:DwbShell.StartupPending=$false
    if($Window.FindName('StartMcp')){
      Hide-DwbWindow
      if($global:DwbShell.Preferences.connectOnStartup){
        try{
          $settings=Read-DwbTunnelJson 'settings.json'
          if(-not $settings){throw 'กรุณาตั้งค่า Tunnel ID และบันทึก key ก่อน'}
          if(-not(Get-DwbTunnelProcess)){$null=Start-DwbTunnel $settings.tunnelId $null $true (Find-DwbTunnelClient)}
          $global:DwbShell.AutoConnectDeadline=[DateTime]::UtcNow.AddSeconds(45)
        }catch{Restore-DwbWindow;[Windows.MessageBox]::Show($_.Exception.Message,'DWB · Start MCP อัตโนมัติ')|Out-Null}
      }
    }
  }
  [Windows.Threading.Dispatcher]::PushFrame($frame)
}
$menu=New-Object Windows.Forms.ContextMenuStrip
$open=$menu.Items.Add('เปิด DWB MCP Studio');$open.Add_Click({Restore-DwbWindow})
$settingsItem=$menu.Items.Add('การเปิดและปิดแอป…');$settingsItem.Add_Click({Restore-DwbWindow;Show-DwbPreferences})
$hideItem=$menu.Items.Add('ซ่อนไป tray');$hideItem.Add_Click({Hide-DwbWindow})
$exitItem=$menu.Items.Add('ปิดแอปและหยุด MCP');$exitItem.Add_Click({$null=Exit-DwbApp})
$null=$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$quit=$menu.Items.Add('ออกจากหน้าควบคุม (MCP ยังทำงาน)')
$quit.Add_Click({$global:DwbShell.Exiting=$true;Set-DwbPage ''})
$tray.ContextMenuStrip=$menu
$tray.Add_MouseClick({param($sender,$eventArgs) if($eventArgs.Button -eq [Windows.Forms.MouseButtons]::Left){Restore-DwbWindow}})
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromMilliseconds(250)
$timer.Add_Tick({
  if($wake.WaitOne(0)){Restore-DwbWindow}
  if($global:DwbShell.AutoConnectDeadline -and [DateTime]::UtcNow -ge $global:DwbShell.AutoConnectProbe){
    $global:DwbShell.AutoConnectProbe=[DateTime]::UtcNow.AddSeconds(3)
    try{$state=Get-DwbTunnelStatus}catch{$state=[pscustomobject]@{state='stopped';ready=$false}}
    if($state.ready){$global:DwbShell.AutoConnectDeadline=$null}
    elseif($state.state -eq 'stopped' -or [DateTime]::UtcNow -ge $global:DwbShell.AutoConnectDeadline){
      $global:DwbShell.AutoConnectDeadline=$null
      Restore-DwbWindow
      [Windows.MessageBox]::Show('MCP ยังเชื่อมต่อไม่สำเร็จ กรุณาดูสถานะใน Dashboard หรือตรวจ Tunnel / API key','DWB · Start MCP อัตโนมัติ')|Out-Null
    }
  }
})
$uiTimer=$null
if($UiTestReport){
  $global:DwbShell.Next='dashboard'
  $global:DwbShell.UiStep=0
  $global:DwbShell.UiFailure=$null
  $uiTimer=New-Object Windows.Threading.DispatcherTimer
  $uiTimer.Interval=[TimeSpan]::FromSeconds(1)
  $uiTimer.Add_Tick({
    try {
      $current=$global:DwbShell.Window
      if(-not $current){return}
      [IO.File]::AppendAllText($UiTestReport+'.progress',[string]$global:DwbShell.UiStep+' '+$current.Title+[Environment]::NewLine)
      switch($global:DwbShell.UiStep){
        0 {if($Startup -and $current.IsVisible){throw 'Startup did not hide dashboard to tray'};if(-not $current.FindName('Connection')){throw 'Dashboard missing'};$global:DwbShell.UiStep++;$current.FindName('Connection').RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))}
        1 {if(-not $current.FindName('ApiKey')){throw 'Connection page missing'};$current.Close();if($current.IsVisible){throw 'Connection close did not hide'};Restore-DwbWindow;$global:DwbShell.UiStep++;$current.FindName('Dashboard').RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))}
        2 {$global:DwbShell.UiStep++;$current.FindName('MachineSetup').RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))}
        3 {if(-not $current.FindName('WorkspaceInput')){throw 'Setup page missing'};$current.WindowState='Minimized';if($current.IsVisible){throw 'Setup minimize did not hide'};Restore-DwbWindow;$global:DwbShell.UiStep++;$current.FindName('DashboardHome').RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))}
        4 {if(-not $current.FindName('Connection')){throw 'Return to dashboard failed'};$current.Close();if($current.IsVisible){throw 'Dashboard close did not hide'};Restore-DwbWindow;$global:DwbShell.UiStep++;$global:DwbShell.Exiting=$true;Set-DwbPage ''}
      }
    }catch{$global:DwbShell.UiFailure=$_.Exception.ToString();$global:DwbShell.Exiting=$true;Set-DwbPage ''}
  })
  $uiTimer.Start()
}
try {
  $timer.Start()
  if($TestReport){
    $testWindow=New-Object Windows.Window
    $testWindow.Width=300;$testWindow.Height=160;$testWindow.Title='DWB shell test'
    $testWindow.Left=-20000;$testWindow.Top=-20000;$testWindow.WindowStartupLocation='Manual'
    Register-DwbWindow $testWindow
    $testWindow.Show()
    $testWindow.Close()
    if($testWindow.IsVisible -or -not $tray.Visible){throw 'Close did not hide to tray.'}
    Restore-DwbWindow
    if(-not $testWindow.IsVisible){throw 'Tray restore failed.'}
    $testWindow.WindowState='Minimized'
    if($testWindow.IsVisible){throw 'Minimize did not hide to tray.'}
    $second=Start-Process -FilePath (Join-Path $PSScriptRoot '..\DWB MCP Studio.exe') -WindowStyle Hidden -PassThru
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    while((-not $second.HasExited -or -not $testWindow.IsVisible) -and [DateTime]::UtcNow -lt $deadline){$testWindow.Dispatcher.Invoke([Action]{},[Windows.Threading.DispatcherPriority]::Background);Start-Sleep -Milliseconds 50}
    if(-not $second.HasExited -or -not $testWindow.IsVisible){throw 'Second launch did not restore the existing window.'}
    $pointer=[IntPtr]::Zero;$null=[DwbWindowIdentity]::GetCurrentProcessExplicitAppUserModelID([ref]$pointer)
    try{if([Runtime.InteropServices.Marshal]::PtrToStringUni($pointer) -ne 'DevWithBebz.DwbMcpStudio'){throw 'Taskbar identity was not set.'}}finally{[Runtime.InteropServices.Marshal]::FreeCoTaskMem($pointer)}
    $global:DwbShell.Preferences.minimizeToTray=$false
    $testWindow.WindowState='Minimized'
    if(-not $testWindow.IsVisible -or -not $testWindow.ShowInTaskbar){throw 'Normal taskbar minimize failed'}
    Restore-DwbWindow
    Set-DwbPage 'dashboard'
    if($testWindow.IsVisible -or $global:DwbShell.Next -ne 'dashboard'){throw 'Page transition failed.'}
    $exitWindow=New-Object Windows.Window
    $exitWindow.Width=200;$exitWindow.Height=100;$exitWindow.Left=-20000;$exitWindow.Top=-20000;$exitWindow.WindowStartupLocation='Manual'
    Register-DwbWindow $exitWindow
    $global:DwbShell.Preferences.closeAction='exit'
    $exitWindow.Show();$exitWindow.Close()
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    while(-not $global:DwbShell.Exiting -and [DateTime]::UtcNow -lt $deadline){$exitWindow.Dispatcher.Invoke([Action]{},[Windows.Threading.DispatcherPriority]::Background);Start-Sleep -Milliseconds 50}
    if(-not $global:DwbShell.Exiting -or $exitWindow.IsVisible){throw 'Close-to-exit failed'}
    [IO.File]::WriteAllText($TestReport,'PASS: close/minimize to tray, restore, second launch, taskbar identity, page transition.')
  }else{
    while(-not $global:DwbShell.Exiting -and $global:DwbShell.Next){
      $page=$global:DwbShell.Next;$global:DwbShell.Next=$null
      switch($page){
        'setup'{& (Join-Path $PSScriptRoot 'setup.ps1')}
        'setup-config'{& (Join-Path $PSScriptRoot 'setup.ps1') -ConfigureOnly}
        'dashboard'{& (Join-Path $PSScriptRoot 'dashboard.ps1')}
        'connection'{& (Join-Path $PSScriptRoot 'tunnel-setup.ps1')}
      }
    }
  }
  if($UiTestReport){if($global:DwbShell.UiFailure){throw $global:DwbShell.UiFailure};[IO.File]::WriteAllText($UiTestReport,'PASS: real Dashboard / Connection / Setup navigation, hide and restore, one shell process.')}
}catch{if($TestReport -or $UiTestReport){throw};[Windows.MessageBox]::Show($_.Exception.Message,'DWB MCP Studio')|Out-Null}
finally{
  if($uiTimer){$uiTimer.Stop()};$timer.Stop();$tray.Visible=$false;$tray.Icon.Dispose();$tray.Dispose();$menu.Dispose()
  $global:DwbShell=$null;$wake.Dispose();$mutex.ReleaseMutex();$mutex.Dispose()
}
