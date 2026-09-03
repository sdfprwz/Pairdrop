@echo off
:loop
echo [%date% %time%] Starting PairDrop >> "C:\Users\HP\Documents\pairdrop-clone\server.log"
node "C:\Users\HP\Documents\pairdrop-clone\server.js" >> "C:\Users\HP\Documents\pairdrop-clone\server.log" 2>> "C:\Users\HP\Documents\pairdrop-clone\server.err.log"
echo [%date% %time%] Server exited with code %errorlevel%, restarting in 2s >> "C:\Users\HP\Documents\pairdrop-clone\server.err.log"
timeout /t 2 /nobreak >nul
goto loop
