@echo off
title Procar - Marketplace Bot
cd /d "C:\Users\Gusta\OneDrive\Documentos\Procar Bot"
echo ========================================
echo   PROCAR - Marketplace Bot
echo ========================================
echo.
echo Arrancando el scraper de Marketplace...
echo NO cierres esta ventana mientras el bot trabaja.
echo Para detenerlo: cerra esta ventana.
echo.
node marketplace-scraper.js
pause
