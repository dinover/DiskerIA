Dim fso, wsh, dir, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set wsh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = Chr(34) & fso.BuildPath(dir, "DiskerIA.exe") & Chr(34)
wsh.Run exe, 0, False
