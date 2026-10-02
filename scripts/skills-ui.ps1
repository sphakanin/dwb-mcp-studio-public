function global:Show-DwbSkills([string]$TestReport, [scriptblock]$TestActions, [scriptblock]$ChooseFolder, [scriptblock]$ConfirmUninstall, [scriptblock]$InstallRecommended, [scriptblock]$ChooseGitHubUrl) {
  Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms,Microsoft.VisualBasic
  if(-not(Get-Command Get-DwbNode -ErrorAction SilentlyContinue)){. (Join-Path $PSScriptRoot 'setup-common.ps1')}
  [xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
 Title="DWB · Agent Skills" Width="1040" Height="760" MinWidth="900" MinHeight="650"
 WindowStartupLocation="CenterOwner" Background="#0D151F" Foreground="#E9F0F7"
 FontFamily="Leelawadee UI, Segoe UI" FontSize="13">
 <Window.Resources>
  <Style TargetType="Button">
   <Setter Property="Background" Value="#1B3041"/><Setter Property="Foreground" Value="#E9F0F7"/>
   <Setter Property="BorderBrush" Value="#345064"/><Setter Property="Padding" Value="15,8"/>
   <Setter Property="Margin" Value="4"/><Setter Property="Cursor" Value="Hand"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" CornerRadius="7" Padding="{TemplateBinding Padding}">
     <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
    </Border>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType="TextBlock"><Setter Property="TextWrapping" Value="Wrap"/></Style>
  <Style TargetType="ComboBox"><Setter Property="MinHeight" Value="34"/><Setter Property="Padding" Value="8,3"/></Style>
  <Style TargetType="DataGridColumnHeader"><Setter Property="Background" Value="#173040"/><Setter Property="Foreground" Value="#E9F0F7"/><Setter Property="Padding" Value="8,6"/><Setter Property="BorderBrush" Value="#274353"/></Style>
 </Window.Resources> <Grid Margin="24">
  <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
  <Grid Grid.Row="0" Margin="0,0,0,16">
   <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
   <StackPanel>
    <TextBlock Text="Agent Skills" FontSize="26" FontWeight="SemiBold"/>
    <TextBlock Text="ติดตั้ง Skill ครั้งเดียว แล้วกำหนดพฤติกรรมแยกตาม Workspace" Foreground="#89AABE" Margin="0,4,0,14"/>
    <Grid MaxWidth="690" HorizontalAlignment="Left">
     <Grid.ColumnDefinitions><ColumnDefinition Width="95"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
     <TextBlock Text="Workspace" Foreground="#08B8D2" VerticalAlignment="Center"/>
     <StackPanel Grid.Column="1">
      <ComboBox x:Name="Workspace" DisplayMemberPath="Name" SelectedValuePath="Id"/>
      <TextBlock x:Name="WorkspacePath" Foreground="#708A9A" FontSize="11" Margin="2,4,0,0"/>
     </StackPanel>
    </Grid>
   </StackPanel>
   <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Bottom">
    <Button x:Name="Refresh" Content="รีเฟรช"/>
    <Button x:Name="InstallRecommended" Content="★ GoLive" Background="#173F46" BorderBrush="#2D7278"/>
    <Button x:Name="InstallBrag" Content="★ BRAG Slim" Background="#173F46" BorderBrush="#2D7278"/>
    <Button x:Name="InstallGithub" Content="+ GitHub"/>
    <Button x:Name="Install" Content="+ โฟลเดอร์" Background="#08B8D2" Foreground="#06252E" BorderBrush="#08B8D2"/>
   </StackPanel>
  </Grid>
  <Grid Grid.Row="1">
   <Grid.ColumnDefinitions><ColumnDefinition Width="320"/><ColumnDefinition Width="16"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
   <Border Background="#122330" CornerRadius="12" Padding="12">
    <DockPanel>
     <Grid DockPanel.Dock="Top" Margin="4,2,4,10">
      <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
      <TextBlock Text="Skills ที่ติดตั้ง" FontWeight="SemiBold"/>
      <TextBlock Grid.Column="1" x:Name="SkillCount" Foreground="#08B8D2"/>
     </Grid>     <ListBox x:Name="SkillList" Background="#0D151F" Foreground="#E9F0F7" BorderBrush="#345064" Padding="4">
      <ListBox.ItemTemplate>
       <DataTemplate>
        <StackPanel Margin="4,6">
         <TextBlock Text="{Binding Name}" FontWeight="SemiBold"/>
         <TextBlock Text="{Binding Description}" Foreground="#89AABE" FontSize="11" MaxHeight="34"/>
        </StackPanel>
       </DataTemplate>
      </ListBox.ItemTemplate>
     </ListBox>
    </DockPanel>
   </Border>
   <Border Grid.Column="2" Background="#122330" CornerRadius="12" Padding="20">
    <ScrollViewer VerticalScrollBarVisibility="Auto">
     <StackPanel>
      <TextBlock x:Name="SkillName" Text="เลือก Skill" FontSize="21" FontWeight="SemiBold"/>
      <TextBlock x:Name="SkillDescription" Foreground="#89AABE" Margin="0,4,0,6"/>
      <TextBlock x:Name="SkillSource" Foreground="#708A9A" FontSize="11" Margin="0,0,0,18"/>
      <TextBlock Text="พฤติกรรมการใช้ Skill" Foreground="#08B8D2" FontWeight="SemiBold"/>
      <TextBlock Text="Default ใช้กับทุก Workspace ที่ยังไม่ได้ override ส่วน Workspace policy มีผลเฉพาะ Workspace ที่เลือกอยู่" Foreground="#89AABE" Margin="0,4,0,12"/>
      <Border Background="#0D1C27" CornerRadius="9" Padding="14" Margin="0,0,0,12">
       <StackPanel>
        <TextBlock Text="ค่าเริ่มต้นของ Skill" FontWeight="SemiBold"/>
        <TextBlock Text="ใช้เมื่อ Workspace ไม่มีการตั้งค่าเฉพาะ" Foreground="#708A9A" FontSize="11" Margin="0,2,0,8"/>
        <Grid>
         <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
         <ComboBox x:Name="DefaultPolicy" DisplayMemberPath="Label" SelectedValuePath="Value"/>
         <Button Grid.Column="1" x:Name="SaveDefault" Content="บันทึกค่าเริ่มต้น" Margin="10,0,0,0"/>
        </Grid>
       </StackPanel>
      </Border>      <Border Background="#0D1C27" CornerRadius="9" Padding="14" Margin="0,0,0,12">
       <StackPanel>
        <TextBlock Text="Workspace ที่เลือก" FontWeight="SemiBold"/>
        <TextBlock x:Name="WorkspacePolicyNote" Foreground="#89AABE" FontSize="11" Margin="0,2,0,8"/>
        <Grid>
         <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
         <ComboBox x:Name="WorkspacePolicy" DisplayMemberPath="Label" SelectedValuePath="Value"/>
         <StackPanel Grid.Column="1" Orientation="Horizontal" Margin="10,0,0,0">
          <Button x:Name="SaveWorkspace" Content="บันทึก Workspace" Margin="0"/>
          <Button x:Name="UseDefault" Content="ใช้ Default" Margin="8,0,0,0"/>
         </StackPanel>
        </Grid>
        <TextBlock x:Name="SkillStatus" Foreground="#EDB77D" Margin="0,10,0,0" FontWeight="SemiBold"/>
       </StackPanel>
      </Border>
      <Border Background="#0F202C" BorderBrush="#274353" BorderThickness="1" CornerRadius="9" Padding="14">
       <StackPanel>
        <TextBlock Text="AUTO · ใช้อัตโนมัติเมื่อ Agent เห็นว่าเหมาะ" Margin="0,0,0,5"/>
        <TextBlock Text="ASK · ถามคุณก่อนใช้ แล้วรอการอนุมัติ" Margin="0,0,0,5"/>
        <TextBlock Text="MANUAL · ใช้เมื่อคุณเรียก Skill นี้โดยตรง"/>
       </StackPanel>
      </Border>
      <Button x:Name="Uninstall" Content="ถอนการติดตั้ง Skill" HorizontalAlignment="Left" Foreground="#F2A6A6" BorderBrush="#6E3E45" Background="#211820" Margin="0,16,0,0"/>
     </StackPanel>
    </ScrollViewer>
   </Border>
  </Grid>  <Border Grid.Row="2" x:Name="PendingSection" Background="#122330" CornerRadius="12" Padding="12" Margin="0,16,0,0" Visibility="Collapsed">
   <DockPanel>
    <Grid DockPanel.Dock="Top" Margin="4,0,4,8">
     <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
     <StackPanel>
      <TextBlock x:Name="PendingTitle" Text="รอการอนุมัติ" FontWeight="SemiBold"/>
      <TextBlock Text="คำขอจาก Skill ที่ตั้งเป็น ASK" Foreground="#89AABE" FontSize="11"/>
     </StackPanel>
     <StackPanel Grid.Column="1" Orientation="Horizontal">
      <Button x:Name="Reject" Content="ปฏิเสธ"/>
      <Button x:Name="Approve" Content="อนุมัติ" Background="#08B8D2" Foreground="#06252E" BorderBrush="#08B8D2"/>
     </StackPanel>
    </Grid>
    <DataGrid x:Name="Pending" Height="135" AutoGenerateColumns="False" IsReadOnly="True" SelectionMode="Single"
     Background="#0D151F" Foreground="#E9F0F7" BorderBrush="#345064" GridLinesVisibility="None" HeadersVisibility="Column"
     RowBackground="#0D151F" AlternatingRowBackground="#10202B">
     <DataGrid.Columns>
      <DataGridTextColumn Header="Skill" Binding="{Binding Skill}" Width="180"/>
      <DataGridTextColumn Header="Workspace" Binding="{Binding Workspace}" Width="220"/>
      <DataGridTextColumn Header="Request" Binding="{Binding Request}" Width="*"/>
     </DataGrid.Columns>
    </DataGrid>
   </DockPanel>
  </Border>
  <TextBlock Grid.Row="3" x:Name="Error" Foreground="#EDB77D" Margin="4,10,0,0"/>
 </Grid>
</Window>
'@
  $reader=New-Object Xml.XmlNodeReader $xaml
  try{$dialog=[Windows.Markup.XamlReader]::Load($reader)}finally{$reader.Dispose()}
  if($global:DwbShell.Window){$dialog.Owner=$global:DwbShell.Window}
  $node=Get-DwbNode
  $admin=Join-Path $PSScriptRoot 'skills-admin.mjs'
  $policyOptions=@(
    [pscustomobject]@{Label='AUTO · ใช้อัตโนมัติ';Value='auto'},
    [pscustomobject]@{Label='ASK · ถามก่อนใช้';Value='ask'},
    [pscustomobject]@{Label='MANUAL · เรียกใช้เอง';Value='manual'}
  )
  $dialog.FindName('DefaultPolicy').ItemsSource=$policyOptions
  $dialog.FindName('WorkspacePolicy').ItemsSource=$policyOptions
  $script:DwbSkillsState=@{Snapshot=$null;Catalog=@()}

  function Invoke-SkillsAdmin([string[]]$Arguments){
    if(-not $node){throw 'ยังไม่พบ Node.js สำหรับจัดการ Skills'}
    $raw=Invoke-DwbNode $node (@($admin)+$Arguments) $PSScriptRoot
    $reply=$raw | ConvertFrom-Json
    if(-not $reply.ok){throw [string]$reply.error}
    return $reply.result
  }
  function Map-Value($Object,[string]$Name){
    if(-not $Object){return $null}
    $property=$Object.PSObject.Properties[$Name]
    if($property){return $property.Value}
    return $null
  }
  function Current-Workspace{return $dialog.FindName('Workspace').SelectedItem}
  function Current-Skill{return $dialog.FindName('SkillList').SelectedItem}
  function Policy-Name([string]$Value){if(-not $Value){return ''};return $Value.ToUpperInvariant()}

  function Update-SkillDetail{
    $skill=Current-Skill;$workspace=Current-Workspace
    $dialog.FindName('WorkspacePath').Text=$(if($workspace){$workspace.Root}else{''})
    if(-not $skill){
      $dialog.FindName('SkillName').Text='เลือก Skill'
      $dialog.FindName('SkillDescription').Text='เลือก Skill ทางซ้ายเพื่อดูและตั้งค่า policy'
      $dialog.FindName('SkillSource').Text=''
      $dialog.FindName('WorkspacePolicyNote').Text=''
      $dialog.FindName('SkillStatus').Text=''
      foreach($name in @('SaveDefault','SaveWorkspace','UseDefault','Uninstall')){$dialog.FindName($name).IsEnabled=$false}
      return
    }
    $dialog.FindName('SkillName').Text=$skill.Name
    $dialog.FindName('SkillDescription').Text=$skill.Description
    $dialog.FindName('SkillSource').Text=$(if($skill.SourceType -eq 'github'){'GitHub · '+$skill.SourceRef}else{'Local · '+$skill.SourceRef})
    $dialog.FindName('DefaultPolicy').SelectedValue=$skill.DefaultPolicy
    $effective=$skill.DefaultPolicy;$override=$null
    if($workspace){
      $map=Map-Value $script:DwbSkillsState.Snapshot.workspacePolicies $workspace.Id
      $override=Map-Value $map $skill.Id
      if($override){$effective=$override}
    }
    $dialog.FindName('WorkspacePolicy').SelectedValue=$effective
    $dialog.FindName('SaveDefault').IsEnabled=$true
    $dialog.FindName('SaveWorkspace').IsEnabled=[bool]$workspace
    $dialog.FindName('UseDefault').IsEnabled=[bool]($workspace -and $override)
    $dialog.FindName('Uninstall').IsEnabled=$true
    if(-not $workspace){
      $dialog.FindName('WorkspacePolicyNote').Text='ยังไม่มี Workspace ให้ตั้งค่าเฉพาะ'
      $dialog.FindName('SkillStatus').Text='ค่า Default: '+(Policy-Name $effective)
    }elseif($override){
      $dialog.FindName('WorkspacePolicyNote').Text='มี override เฉพาะ Workspace นี้'
      $dialog.FindName('SkillStatus').Text='ใช้งานจริง: '+(Policy-Name $effective)+' · Workspace override'
    }else{
      $dialog.FindName('WorkspacePolicyNote').Text='กำลังสืบทอดค่า Default ของ Skill'
      $dialog.FindName('SkillStatus').Text='ใช้งานจริง: '+(Policy-Name $effective)+' · inherited from Default'
    }
  }

  function Refresh-Skills{
    try{
      $selectedWorkspace=if(Current-Workspace){(Current-Workspace).Id}else{$null}
      $selectedSkill=if(Current-Skill){(Current-Skill).Id}else{$null}
      $snapshot=Invoke-SkillsAdmin @('snapshot');$script:DwbSkillsState.Snapshot=$snapshot
      $catalog=@(Invoke-SkillsAdmin @('catalog'));$script:DwbSkillsState.Catalog=$catalog
      $workspaces=@($snapshot.workspaces | ForEach-Object {[pscustomobject]@{Id=$_.id;Name=$_.name;Root=$_.root}})
      $dialog.FindName('Workspace').ItemsSource=$workspaces
      $dialog.FindName('Workspace').SelectedItem=$workspaces | Where-Object Id -eq $selectedWorkspace | Select-Object -First 1
      if(-not $dialog.FindName('Workspace').SelectedItem -and $workspaces.Count){$dialog.FindName('Workspace').SelectedIndex=0}
      $items=@($snapshot.skills | ForEach-Object {[pscustomobject]@{Id=$_.id;Name=$_.name;Description=$_.description;DefaultPolicy=$_.defaultPolicy;SourceType=$_.sourceType;SourceRef=$_.sourceRef}})
      $dialog.FindName('SkillList').ItemsSource=$items
      $dialog.FindName('SkillCount').Text=[string]$items.Count
      $installedGoLive=$items | Where-Object Id -eq 'golive' | Select-Object -First 1
      $goliveCatalog=$catalog | Where-Object id -eq 'golive' | Select-Object -First 1
      $goliveCurrent=[bool]($installedGoLive -and $goliveCatalog -and $installedGoLive.SourceType -eq 'github' -and $installedGoLive.SourceRef -like ('*/tree/'+$goliveCatalog.ref+'/*'))
      $dialog.FindName('InstallRecommended').IsEnabled=-not $goliveCurrent
      $dialog.FindName('InstallRecommended').Content=$(if(-not $installedGoLive){'★ GoLive'}elseif($goliveCurrent){'✓ GoLive'}else{'↻ GoLive'})
      $dialog.FindName('InstallRecommended').ToolTip=$(if($goliveCatalog){'GoLive '+$goliveCatalog.version+' · '+$goliveCatalog.description}else{'Recommended Skill'})
      $installedBrag=$items | Where-Object Id -eq 'brag-slim' | Select-Object -First 1
      $bragCatalog=$catalog | Where-Object id -eq 'brag-slim' | Select-Object -First 1
      $bragCurrent=[bool]($installedBrag -and $bragCatalog -and $installedBrag.SourceType -eq 'github' -and $installedBrag.SourceRef -like ('*/tree/'+$bragCatalog.ref+'/*'))
      $dialog.FindName('InstallBrag').IsEnabled=-not $bragCurrent
      $dialog.FindName('InstallBrag').Content=$(if(-not $installedBrag){'★ BRAG Slim'}elseif($bragCurrent){'✓ BRAG Slim'}else{'↻ BRAG Slim'})
      $dialog.FindName('InstallBrag').ToolTip=$(if($bragCatalog){'BRAG Slim '+$bragCatalog.version+' · '+$bragCatalog.description}else{'Recommended Skill'})
      $dialog.FindName('SkillList').SelectedItem=$items | Where-Object Id -eq $selectedSkill | Select-Object -First 1
      if(-not $dialog.FindName('SkillList').SelectedItem -and $items.Count){$dialog.FindName('SkillList').SelectedIndex=0}
      $workspaceNames=@{};foreach($w in $snapshot.workspaces){$workspaceNames[$w.id]=$w.name}
      $pending=@($snapshot.pendingApprovals | ForEach-Object {[pscustomobject]@{Id=$_.id;Skill=$_.name;Workspace=$(if($workspaceNames[$_.workspace_id]){$workspaceNames[$_.workspace_id]}else{$_.workspace_id});Request=$_.id}})
      $dialog.FindName('Pending').ItemsSource=$pending
      $dialog.FindName('PendingTitle').Text='รอการอนุมัติ ('+$pending.Count+')'
      $dialog.FindName('PendingSection').Visibility=$(if($pending.Count){'Visible'}else{'Collapsed'})
      $dialog.FindName('Error').Text=''
      Update-SkillDetail
    }catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  }

  $dialog.FindName('Refresh').Add_Click({Refresh-Skills})
  $dialog.FindName('Workspace').Add_SelectionChanged({Update-SkillDetail})
  $dialog.FindName('SkillList').Add_SelectionChanged({Update-SkillDetail})
  $dialog.FindName('InstallRecommended').Add_Click({
    try{
      if($InstallRecommended){& $InstallRecommended 'golive';Refresh-Skills;return}
      $null=Invoke-SkillsAdmin @('install-recommended','golive')
      Refresh-Skills
    }catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('InstallBrag').Add_Click({
    try{
      if($InstallRecommended){& $InstallRecommended 'brag-slim';Refresh-Skills;return}
      $null=Invoke-SkillsAdmin @('install-recommended','brag-slim')
      Refresh-Skills
    }catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('InstallGithub').Add_Click({
    try{
      $url=if($ChooseGitHubUrl){& $ChooseGitHubUrl}else{[Microsoft.VisualBasic.Interaction]::InputBox(
        'วาง GitHub repository URL หรือ /tree/<ref>/<skill-path> URL',
        'DWB · ติดตั้ง Agent Skill จาก GitHub',
        'https://github.com/owner/repository'
      )}
      if([string]::IsNullOrWhiteSpace([string]$url)){return}
      $null=Invoke-SkillsAdmin @('install-github',[string]$url)
      Refresh-Skills
    }catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('Install').Add_Click({
    try{
      if($ChooseFolder){
        $selectedPath=& $ChooseFolder
        if($selectedPath){$null=Invoke-SkillsAdmin @('install-local',$selectedPath);Refresh-Skills}
        return
      }
      $picker=New-Object Windows.Forms.FolderBrowserDialog
      $picker.Description='เลือกโฟลเดอร์ Skill ที่มี SKILL.md'
      if($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK){
        $null=Invoke-SkillsAdmin @('install-local',$picker.SelectedPath);Refresh-Skills
      }
    }catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('SaveDefault').Add_Click({
    try{$skill=Current-Skill;if(-not $skill){return};$null=Invoke-SkillsAdmin @('set-default',$skill.Id,[string]$dialog.FindName('DefaultPolicy').SelectedValue);Refresh-Skills}catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('SaveWorkspace').Add_Click({
    try{$skill=Current-Skill;$workspace=Current-Workspace;if(-not $skill -or -not $workspace){return};$null=Invoke-SkillsAdmin @('set-workspace',$workspace.Id,$skill.Id,[string]$dialog.FindName('WorkspacePolicy').SelectedValue);Refresh-Skills}catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('UseDefault').Add_Click({
    try{$skill=Current-Skill;$workspace=Current-Workspace;if(-not $skill -or -not $workspace){return};$null=Invoke-SkillsAdmin @('clear-workspace',$workspace.Id,$skill.Id);Refresh-Skills}catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('Uninstall').Add_Click({
    try{$skill=Current-Skill;if(-not $skill){return};$confirmed=if($ConfirmUninstall){& $ConfirmUninstall}else{[Windows.MessageBox]::Show(('ถอน Skill '+$skill.Name+' ?'),'DWB · Agent Skills','YesNo','Question') -eq 'Yes'};if($confirmed){$null=Invoke-SkillsAdmin @('uninstall',$skill.Id);Refresh-Skills}}catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('Approve').Add_Click({
    try{$row=$dialog.FindName('Pending').SelectedItem;if($row){$null=Invoke-SkillsAdmin @('approve',$row.Id);Refresh-Skills}}catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.FindName('Reject').Add_Click({
    try{$row=$dialog.FindName('Pending').SelectedItem;if($row){$null=Invoke-SkillsAdmin @('reject',$row.Id);Refresh-Skills}}catch{$dialog.FindName('Error').Text=$_.Exception.Message}
  })
  $dialog.Add_Closed({$script:DwbSkillsState=$null})
  Refresh-Skills
  if($TestReport){
    $dialog.WindowStartupLocation='Manual';$dialog.Left=-20000;$dialog.Top=-20000
    $dialog.Add_ContentRendered({
      try{
        if($TestActions){& $TestActions $dialog}
        else{
        if($dialog.FindName('SkillList').Items.Count -ne 1){throw 'Installed Skill did not render'}
        if($dialog.FindName('DefaultPolicy').Items.Count -ne 3){throw 'Policy choices did not render'}
        if(-not $dialog.FindName('Approve') -or -not $dialog.FindName('Reject')){throw 'ASK controls missing'}
        if($dialog.FindName('SkillCount').Text -ne '1'){throw 'Skill count did not render'}
        if($dialog.FindName('PendingSection').Visibility -ne 'Collapsed'){throw 'Empty ASK section should be hidden'}
        }
        $dialog.UpdateLayout()
        $render=New-Object Windows.Media.Imaging.RenderTargetBitmap([int]$dialog.ActualWidth,[int]$dialog.ActualHeight,96,96,[Windows.Media.PixelFormats]::Pbgra32)
        $render.Render($dialog)
        $encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder
        $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($render))
        $stream=[IO.File]::Create($TestReport+'.png')
        try{$encoder.Save($stream)}finally{$stream.Dispose()}
        [IO.File]::WriteAllText($TestReport,'PASS')
      }catch{[IO.File]::WriteAllText($TestReport,$_.Exception.Message)}
      finally{$dialog.Close()}
    })
  }
  $null=$dialog.ShowDialog()
}
