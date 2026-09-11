Set sh = CreateObject("Wscript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = dir
sh.Run """C:\Program Files\nodejs\node.exe"" """ & dir & "server.js"" >> """ & dir & "worker.log"" 2>&1", 0, False
