Set sh = CreateObject("Wscript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "%COMSPEC% /c """ & dir & "stop-worker.cmd""", 0, False