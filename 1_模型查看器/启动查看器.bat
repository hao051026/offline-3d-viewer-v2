@echo off
setlocal
chcp 936 >nul
title 西镇高速 - 离线三维模型查看器
cd /d "%~dp0"

rem 无论走哪条分支、成不成功，都往系统临时目录记一笔，方便回看
set "BATLOG=%TEMP%\西镇查看器_启动日志.txt"
>>"%BATLOG%" echo ============================================================
>>"%BATLOG%" echo [%date% %time%] 双击启动
>>"%BATLOG%" echo   目录 = %~dp0
>>"%BATLOG%" echo   电脑 = %COMPUTERNAME%   用户 = %USERNAME%

call :findpython
if defined PYCMD (
  >>"%BATLOG%" echo   Python = %PYCMD%
  goto :usepython
)
>>"%BATLOG%" echo   Python = 未找到可用 Python（不装也能用，下面走 Windows 内置组件）
goto :usepowershell

:usepython
echo   正在用 Python 启动本地服务，马上会自动打开浏览器...
echo.
chcp 65001 >nul
%PYCMD% serve.py
set "RC=%ERRORLEVEL%"
chcp 936 >nul
>>"%BATLOG%" echo [%date% %time%] Python 退出码 = %RC%
if "%RC%"=="0" goto :end
>>"%BATLOG%" echo   Python 启动失败，自动改用 Windows 内置组件
echo   Python 启动失败（退出码 %RC%），改用 Windows 内置组件...
echo.

:usepowershell
echo   现在改用 Windows 内置组件启动服务（不用装 Python，一样能开）。
echo   离线、补瓦片 MIME、自动打开浏览器。
echo.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
>>"%BATLOG%" echo   PowerShell = %PS%
if exist "serve.ps1" >>"%BATLOG%" echo   serve.ps1 = 存在
if not exist "serve.ps1" >>"%BATLOG%" echo   serve.ps1 = 缺失（拷贝不完整）
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "serve.ps1"
set "RC=%ERRORLEVEL%"
>>"%BATLOG%" echo [%date% %time%] PowerShell 退出码 = %RC%
if "%RC%"=="0" goto :end
call :failed
goto :end

rem 找一个真的能跑的 Python：商店假壳（WindowsApps\python.exe）会返 9009，必须跳过
:findpython
set "PYCMD="
py -3 -c "import sys" >nul 2>nul
if errorlevel 1 goto :fp_python
set "PYCMD=py -3"
goto :eof
:fp_python
for /f "delims=" %%A in ('where python 2^>nul') do (
  echo %%A | find /i "\WindowsApps\" >nul
  if errorlevel 1 (
    if not defined PYCMD (
      "%%A" -c "import sys" >nul 2>nul
      if not errorlevel 1 set "PYCMD=%%~A"
    )
  )
)
goto :eof

:failed
echo.
echo   [启动失败] 退出码 = %RC%
echo   启动日志：%BATLOG%
echo   若上面红字里有“禁止运行脚本”，是这台电脑的脚本策略挡住了；
echo   请右键本文件选“以管理员身份运行”再试一次。
goto :eof

:end
echo.
echo   服务已退出。
echo   启动日志：%BATLOG%
pause >nul
