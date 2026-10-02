param([string]$PreviewPath,[string]$SnapshotFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
. (Join-Path $PSScriptRoot 'tunnel-common.ps1')
$reader=[Xml.XmlReader]::Create([IO.StringReader]::new([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'dashboard.xaml'))))
try{$window=[Windows.Markup.XamlReader]::Load($reader)}finally{$reader.Dispose()}
if($global:DwbShell){Register-DwbWindow $window}
function Find([string]$Name){return $window.FindName($Name)}
$logo=[Windows.Media.Imaging.BitmapImage]::new([Uri][IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets\dwb-logo.png')))
(Find 'Logo').Source=$logo; $window.Icon=$logo
try{(Find 'Version').Text=(Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version}catch{}
$script:Probe=$null; $script:Output=$null; $script:Errors=$null
$script:LastProbe=[DateTime]::MinValue
$script:Node=Get-DwbNode
function Open-DwbScreen([string]$Name,[string]$Extra=''){
  if($global:DwbShell){Set-DwbPage $(if($Name -eq 'tunnel-setup.ps1'){'connection'}else{'setup-config'});return}
  $args='-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File '+(ConvertTo-DwbArgument (Join-Path $PSScriptRoot $Name))+' '+$Extra
  Start-Process -FilePath powershell.exe -ArgumentList $args -WindowStyle Hidden | Out-Null
}
function Local-Time($Value){try{return ([DateTime]$Value).ToLocalTime().ToString('HH:mm:ss')}catch{return '—'}}
function Apply-Snapshot($Data){
  $running=$Data.state -eq 'running'
  (Find 'BrokerStatus').Text=switch($Data.state){'running'{'ทำงานอยู่'} 'stopped'{'ยังไม่เปิด'} 'setup-required'{'รอตั้งค่า'} 'upgrade-required'{'รุ่นเดิม'} default{'ไม่ตอบสนอง'}}
  (Find 'BrokerStatus').Foreground=if($running){'#81D7B5'}else{'#EDB77D'}
  (Find 'BrokerDetail').Text=if($running){'PID '+$Data.broker.brokerPid+' · '+$(if($Data.broker.runtime.version){$Data.broker.runtime.version}else{'legacy'})}elseif($Data.state -eq 'upgrade-required'){'เริ่ม broker ใหม่หลังจบงานเพื่อดูรายละเอียด'}else{'เปิดอัตโนมัติเมื่อแชทเชื่อมต่อ'}
  if($Data.runtimeMismatch -or $Data.state -eq 'upgrade-required'){
    (Find 'BrokerStatus').Text='รออัปเดต broker'
    (Find 'BrokerStatus').Foreground='#EDB77D'
    (Find 'ActionStatus').Text='จบงานเดิม → Stop MCP → ตั้งค่าเครื่อง เพื่อเปลี่ยนเป็นรุ่นนี้ ข้อมูลเดิมยังอยู่'
  }elseif($Data.broker.persistence.healthy -eq $false){
    (Find 'BrokerStatus').Text='บันทึก session ไม่สำเร็จ'
    (Find 'BrokerStatus').Foreground='#EDB77D'
    (Find 'ActionStatus').Text='ตรวจพื้นที่ว่างและสิทธิ์โฟลเดอร์ข้อมูล · ผลงานที่ทำแล้วไม่ต้องสั่งซ้ำ'
  }
  (Find 'Workers').Text=if($running){[string]$Data.broker.activeWorkers+' / '+$Data.broker.workerCap}else{'—'}
  (Find 'WorkerDetail').Text=if($running){'กำลังเปิด '+$Data.broker.startingWorkers+' · กำลังปิด '+$Data.broker.stoppingWorkers}else{'จำนวนที่เปิด / สูงสุด'}
  (Find 'Queue').Text=if($running){[string]$Data.broker.queueDepth}else{'—'}
  (Find 'QueueDetail').Text=if($running){'กำลังเรียก '+$Data.broker.inFlightCalls+' คำขอ'}else{'คำขอที่รอ worker'}
  (Find 'SessionCount').Text=if($running){'เชื่อมต่อ '+$Data.broker.attachedSessions+' · พักไว้ '+$Data.broker.detachedSessions}else{'ไม่มีข้อมูลสด'}
  $rows=@(foreach($session in $Data.sessions){
    $label=if($session.workspaceName){$session.workspaceName}else{Split-Path -Leaf $session.workingDirectory}
    $state=if($session.queued){'รอ worker'}elseif($session.inFlight -gt 0){'กำลังทำงาน'}elseif($session.state -eq 'detached'){'พัก session'}elseif($session.ready){'พร้อมรับงาน'}else{'รอเรียกใช้'}
    [pscustomobject]@{Workspace=$label;Session=([string]$session.sessionId).Substring(0,[Math]::Min(10,([string]$session.sessionId).Length));State=$state;Pid=$(if($session.workerPid){$session.workerPid}else{'—'});InFlight=$session.inFlight;Queue=$(if($session.queuePosition){$session.queuePosition}else{'—'});LastActive=(Local-Time $session.lastActivityAt);FullDetail=($session.sessionId+"`n"+$session.workingDirectory+' · worker restarts: '+$session.restartCount)}
  })
  $selected=(Find 'Sessions').SelectedItem
  (Find 'Sessions').ItemsSource=$rows
  if($selected){(Find 'Sessions').SelectedItem=$rows | Where-Object FullDetail -eq $selected.FullDetail | Select-Object -First 1}
  (Find 'Empty').Visibility=if($rows.Count){'Collapsed'}else{'Visible'}
  (Find 'Empty').Text=if($running){'ยังไม่มี session · เรียกเครื่องมือจากแชทเพื่อเริ่มงาน'}elseif($Data.state -eq 'stopped'){'Broker ยังไม่เปิด · Dashboard จะไม่เปิด worker ให้เอง'}else{'ยังอ่านรายการ session ไม่ได้'}
  (Find 'Events').ItemsSource=@(foreach($event in $Data.events){[pscustomobject]@{Time=(Local-Time $event.time);Status=$(if($event.status -eq 'error'){'ผิดพลาด'}elseif($event.status -eq 'warn'){'เตือน'}else{'ข้อมูล'});Event=($event.event+' '+$event.tool).Trim();Detail=$event.detail}})
  (Find 'Updated').Text='อัปเดต '+(Local-Time $Data.updatedAt)+' · ทุก 3 วินาที'+$(if($Data.totalSessions -gt 200){' · แสดง 200 session แรก'}else{''})
}
function Update-TunnelCard{
  try{
    $state=Get-DwbTunnelStatus
    (Find 'TunnelStatus').Text=switch($state.state){'ready'{'พร้อม'} 'starting'{'กำลังเชื่อมต่อ'} default{'หยุดอยู่'}}
    (Find 'TunnelStatus').Foreground=if($state.ready){'#81D7B5'}else{'#EDB77D'}
    (Find 'TunnelDetail').Text=if($state.pid){'PID '+$state.pid+' · สถานะจาก tunnel-client'}else{'กด Start เพื่อเชื่อมต่อ'}
    (Find 'StartMcp').IsEnabled=$state.state -eq 'stopped'
    (Find 'StopMcp').IsEnabled=$state.state -ne 'stopped'
    (Find 'MachineSetup').IsEnabled=$state.state -eq 'stopped'
  }catch{(Find 'TunnelStatus').Text='อ่านไม่ได้';(Find 'TunnelDetail').Text='ตรวจหน้า ตั้งค่า Tunnel';(Find 'StartMcp').IsEnabled=$false;(Find 'StopMcp').IsEnabled=$false}
}
function Begin-Probe{
  if($script:Probe){return}
  $script:LastProbe=[DateTime]::UtcNow
  Update-TunnelCard
  if(-not $script:Node){Apply-Snapshot ([pscustomobject]@{state='setup-required';sessions=@();events=@();updatedAt=[DateTime]::UtcNow});return}
  try{
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$script:Node
    $info.Arguments=ConvertTo-DwbArgument (Join-Path $PSScriptRoot 'dashboard-probe.mjs')
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.StandardOutputEncoding=[Text.Encoding]::UTF8;$info.StandardErrorEncoding=[Text.Encoding]::UTF8
    $script:Probe=[Diagnostics.Process]::Start($info)
    $script:Output=$script:Probe.StandardOutput.ReadToEndAsync()
    $script:Errors=$script:Probe.StandardError.ReadToEndAsync()
  }catch{(Find 'ActionStatus').Text='เริ่มอ่านสถานะไม่ได้ · เปิดตั้งค่าเครื่องเพื่อตรวจ Node.js'}
}
function Finish-Probe{
  if(-not $script:Probe){return}
  if(-not $script:Probe.HasExited){
    if(([DateTime]::UtcNow-$script:LastProbe).TotalSeconds -gt 6){$script:Probe.Kill()}else{return}
  }
  try{
    $json=$script:Output.GetAwaiter().GetResult()
    $null=$script:Errors.GetAwaiter().GetResult()
    if(-not $json){throw 'No probe data'}
    Apply-Snapshot ($json | ConvertFrom-Json)
  }catch{Apply-Snapshot ([pscustomobject]@{state='unresponsive';sessions=@();events=@();updatedAt=[DateTime]::UtcNow})}
  finally{$script:Probe.Dispose();$script:Probe=$null}
}
(Find 'AppPreferences').Add_Click({if(Get-Command Show-DwbPreferences -ErrorAction SilentlyContinue){Show-DwbPreferences}})
(Find 'AppPreferences').IsEnabled=[bool]$global:DwbShell
(Find 'Skills').Add_Click({if(Get-Command Show-DwbSkills -ErrorAction SilentlyContinue){Show-DwbSkills}})
(Find 'Skills').IsEnabled=[bool]$global:DwbShell
(Find 'Connection').Add_Click({Open-DwbScreen 'tunnel-setup.ps1'})
(Find 'MachineSetup').Add_Click({Open-DwbScreen 'setup.ps1' '-ConfigureOnly'})
(Find 'WorkspaceHelp').Add_Click({$info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\docs\workspaces.html'));$info.UseShellExecute=$true;[Diagnostics.Process]::Start($info)|Out-Null})
(Find 'Refresh').Add_Click({Begin-Probe})
(Find 'StartMcp').Add_Click({
  try{
    $settings=Read-DwbTunnelJson 'settings.json'
    if(-not $settings -or -not(Test-Path -LiteralPath (Join-Path (Get-DwbTunnelDirectory) 'key.dpapi'))){Open-DwbScreen 'tunnel-setup.ps1';return}
    $null=Start-DwbTunnel $settings.tunnelId $null ([bool]$settings.rememberKey) (Find-DwbTunnelClient)
    (Find 'ActionStatus').Text='เริ่ม tunnel แล้ว · กำลังรอสถานะพร้อม';Begin-Probe
  }catch{(Find 'ActionStatus').Text=$_.Exception.Message}
})
(Find 'StopMcp').Add_Click({try{Stop-DwbTunnel;(Find 'ActionStatus').Text='หยุด tunnel แล้ว · Broker และงานที่เริ่มไว้ในเครื่องอาจยังทำงานต่อ';Begin-Probe}catch{(Find 'ActionStatus').Text=$_.Exception.Message}})
(Find 'Sessions').Add_SelectionChanged({$selected=(Find 'Sessions').SelectedItem;if($selected){(Find 'Detail').Text=$selected.FullDetail}})
(Find 'Events').Add_SelectionChanged({$selected=(Find 'Events').SelectedItem;if($selected){(Find 'Detail').Text=$selected.Time+' · '+$selected.Event+"`n"+$selected.Detail}})
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({Finish-Probe;if(([DateTime]::UtcNow-$script:LastProbe).TotalSeconds -ge 3){Begin-Probe}})
$window.Add_Closed({$timer.Stop();if($script:Probe){if(-not $script:Probe.HasExited){$script:Probe.Kill()};$script:Probe.Dispose();$script:Probe=$null}})
if($PreviewPath){
  $window.ShowInTaskbar=$false;$window.WindowStartupLocation='Manual';$window.Left=-20000;$window.Top=-20000
  $window.Show()
  if($SnapshotFile){Apply-Snapshot (Get-Content -LiteralPath $SnapshotFile -Raw -Encoding UTF8 | ConvertFrom-Json);Update-TunnelCard}else{
    Begin-Probe
    while($script:Probe){$window.Dispatcher.Invoke([Action]{},[Windows.Threading.DispatcherPriority]::Background);Finish-Probe;Start-Sleep -Milliseconds 100}
  }
  $window.UpdateLayout();$window.Dispatcher.Invoke([Action]{},[Windows.Threading.DispatcherPriority]::Background)
  $render=New-Object Windows.Media.Imaging.RenderTargetBitmap([int]$window.ActualWidth,[int]$window.ActualHeight,96,96,[Windows.Media.PixelFormats]::Pbgra32)
  $render.Render($window);$encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($render));$stream=[IO.File]::Create([IO.Path]::GetFullPath($PreviewPath))
  try{$encoder.Save($stream)}finally{$stream.Dispose()};$window.Close()
}else{Begin-Probe;$timer.Start();if($global:DwbShell){Show-DwbWindow $window}else{$null=$window.ShowDialog()}}
