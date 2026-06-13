@echo off
rem Launches your real Google Chrome with a debugging port so geminibatch can
rem attach to it. Log into Gemini (and the contribute site) in THIS window, then
rem leave it open and run the geminibatch binary / npm start.

setlocal
set PORT=%1
if "%PORT%"=="" set PORT=9222
set PROFILE=%~dp0.gemini-chrome

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

echo Starting Chrome on debug port %PORT% with profile %PROFILE%
echo Log into Gemini in the window that opens, then leave it open.

%CHROME% --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "https://gemini.google.com/app"

endlocal
