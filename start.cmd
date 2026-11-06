@echo off
rem Plain start: runs the server in this window and opens the console. Close the window to stop it.
cd /d "%~dp0"
start "" http://localhost:8787
node server.js %*
