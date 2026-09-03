@echo off
taskkill /F /IM node.exe 2>nul
del /Q "C:\Users\HP\Documents\pairdrop-clone\server.pid" 2>nul
echo stopped
