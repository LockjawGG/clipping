' Silent Jarvis launcher: runs the port-probing opener with no console window.
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\Gf788\clipping\scripts\open-brain.ps1""", 0, False
