#define MyAppName "DiskerIA"
#define MyAppVersion "1.0.0"
#define MyAppExeName "DiskerIA.exe"

[Setup]
AppId={{A3F2B1C4-7E8D-4F9A-B2C3-D4E5F6A7B8C9}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppName}
DefaultDirName={commonpf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=DiskerIA-Setup
SetupIconFile=assets\logo.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UsedUserAreasWarning=no
UninstallDisplayIcon={app}\logo.ico

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Messages]
WelcomeLabel1=Bienvenido al instalador de [name]
WelcomeLabel2=Esto instalará [name/ver] en tu computadora.%n%nSe recomienda cerrar otras aplicaciones antes de continuar.
FinishedHeadingLabel=Instalación completada
FinishedLabel=[name] fue instalado correctamente.%n%nPodés abrirlo desde el acceso directo en el escritorio.

[Tasks]
Name: "desktopicon"; Description: "Crear acceso directo en el escritorio"; GroupDescription: "Opciones adicionales:"

[Files]
Source: "dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "launcher.vbs";          DestDir: "{app}"; Flags: ignoreversion
Source: "assets\logo.ico";       DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: "//b //nologo ""{app}\launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\logo.ico"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: "//b //nologo ""{app}\launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\logo.ico"; Tasks: desktopicon

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\DiskerIA"

[Run]
Filename: "{sys}\wscript.exe"; Parameters: "//b //nologo ""{app}\launcher.vbs"""; WorkingDir: "{app}"; Description: "Abrir DiskerIA ahora"; Flags: nowait postinstall skipifsilent

[Code]
var
  MusicFolderPage: TInputDirWizardPage;
  DownloadPage: TDownloadWizardPage;

function EscapeForJson(const S: String): String;
var
  I: Integer;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    if S[I] = '\' then
      Result := Result + '\\'
    else
      Result := Result + S[I];
  end;
end;

procedure InitializeWizard;
begin
  MusicFolderPage := CreateInputDirPage(
    wpSelectDir,
    'Carpeta de música',
    'Elegí dónde querés guardar tu música descargada',
    'DiskerIA creará una subcarpeta por cada playlist dentro de la carpeta que elijas:',
    False,
    'Examinar'
  );
  MusicFolderPage.Add('');
  MusicFolderPage.Values[0] := ExpandConstant('{userdocs}\DiskerIA');

  DownloadPage := CreateDownloadPage(
    'Descargando herramientas',
    'Descargando yt-dlp, deno y ffmpeg. Esto puede tardar unos minutos según tu conexión...',
    nil
  );
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;

  if CurPageID = MusicFolderPage.ID then
  begin
    if MusicFolderPage.Values[0] = '' then
    begin
      MsgBox('Por favor seleccioná una carpeta para guardar la música.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if CurPageID = wpReady then
  begin
    DownloadPage.Clear;
    DownloadPage.Add(
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
      'yt-dlp.exe',
      ''
    );
    DownloadPage.Add(
      'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
      'deno.zip',
      ''
    );
    DownloadPage.Add(
      'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
      'ffmpeg.zip',
      ''
    );
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
      except
        MsgBox(
          'Error al descargar herramientas:' + #13#10 + GetExceptionMessage + #13#10#13#10 +
          'Verificá tu conexión a internet e intentá de nuevo.',
          mbCriticalError,
          MB_OK
        );
        Result := False;
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  TmpDir, AppDir, Script, ConfigPath, MusicPath, ConfigContent: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    TmpDir := ExpandConstant('{tmp}');
    AppDir := ExpandConstant('{userappdata}\DiskerIA');
    ForceDirectories(AppDir);

    Script :=
      '$tmp = "' + TmpDir + '"' + #13#10 +
      '$app = "' + AppDir + '"' + #13#10 +
      'New-Item -ItemType Directory -Force -Path $app | Out-Null' + #13#10 +
      'Copy-Item "$tmp\yt-dlp.exe" "$app\yt-dlp.exe" -Force' + #13#10 +
      'Expand-Archive "$tmp\deno.zip" "$tmp\deno_ext" -Force' + #13#10 +
      'Get-ChildItem "$tmp\deno_ext" -Recurse -Filter deno.exe | Select-Object -First 1 | Copy-Item -Destination "$app\deno.exe" -Force' + #13#10 +
      'Expand-Archive "$tmp\ffmpeg.zip" "$tmp\ffmpeg_ext" -Force' + #13#10 +
      'Get-ChildItem "$tmp\ffmpeg_ext" -Recurse -Filter ffmpeg.exe | Select-Object -First 1 | Copy-Item -Destination "$app\ffmpeg.exe" -Force';

    SaveStringToFile(TmpDir + '\install_tools.ps1', Script, False);
    Exec(
      'powershell.exe',
      '-NonInteractive -ExecutionPolicy Bypass -File "' + TmpDir + '\install_tools.ps1"',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    );

    MusicPath := MusicFolderPage.Values[0];
    ForceDirectories(MusicPath);
    ConfigPath    := AppDir + '\config.json';
    ConfigContent := '{"outDir":"' + EscapeForJson(MusicPath) + '"}';
    SaveStringToFile(ConfigPath, ConfigContent, False);
  end;
end;
