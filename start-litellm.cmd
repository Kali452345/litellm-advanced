@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-litellm.ps1" %*
