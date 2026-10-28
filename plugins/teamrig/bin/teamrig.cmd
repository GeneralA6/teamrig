@echo off
rem The teamrig CLI for cmd and PowerShell. cmd ends %* at a line break, so the shim also hands the CLI its whole
rem command line, read with delayed expansion, which keeps the line breaks; the CLI rebuilds the arguments from it.
setlocal EnableDelayedExpansion
set "TEAMRIG_CMD_LINE=!CMDCMDLINE!"
setlocal DisableDelayedExpansion
node "%~dp0..\dist\cli\main.js" %*
