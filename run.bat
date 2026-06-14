@echo off
rem Run geminibatch with your installed Node.js, passing arguments through.
rem
rem Examples:
rem   run.bat                         (local mode: process ./images)
rem   run.bat --system dos            (system mode)
rem   run.bat --system dos --limit 10
rem
rem Requires Node.js installed (https://nodejs.org) and `npm install` run once.
rem Launch Chrome first with start-chrome.bat, then run this.

node "%~dp0index.js" %*
