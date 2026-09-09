Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
python = root & "\desktop-pet\.venv\Scripts\pythonw.exe"
If Not fs.FileExists(python) Then
    MsgBox "Please run desktop-pet\setup.ps1 first.", 48, "PPA"
Else
    shell.CurrentDirectory = root
    shell.Run Chr(34) & python & Chr(34) & " " & Chr(34) & root & "\desktop-pet\run.py" & Chr(34), 0, False
End If
