@echo off
rem Launches your real Google Chrome with a debugging port so geminibatch can
rem attach to it. Log into Gemini (and the contribute site) in THIS window, then
rem leave it open and run the geminibatch binary / npm start.
rem
rem Stopping this window (Ctrl+C, or closing it) also shuts the launched Chrome
rem down. Only the Chrome instance using this profile is closed.

setlocal
set PORT=%1
if "%PORT%"=="" set PORT=9222
set PROFILE=%~dp0.gemini-chrome

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

echo Starting Chrome on debug port %PORT% with profile %PROFILE%
echo Log into Gemini in the window that opens, then leave it open.
echo Press Ctrl+C here (or close this window) to close Chrome.

rem Launch via PowerShell so we can wait on Chrome and kill it when this script
rem stops: the finally block runs on Ctrl+C / window close.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$p = Start-Process -FilePath %CHROME% -PassThru -ArgumentList '--remote-debugging-port=%PORT%','--remote-allow-origins=*','--user-data-dir=\"%PROFILE%\"','--no-first-run','--no-default-browser-check','https://gemini.google.com/app';" ^
 "try { Wait-Process -Id $p.Id } finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }"

endlocal
