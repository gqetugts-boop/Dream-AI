@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   幻梦圆环 · Windows 构建
echo   ================================
echo.

where dotnet >nul 2>nul
if errorlevel 1 (
    echo   [X] 没有找到 .NET SDK
    echo.
    echo   请先安装 .NET 8 SDK：
    echo     https://dotnet.microsoft.com/download/dotnet/8.0
    echo.
    echo   装的时候选左边的 "SDK x64"，不要选 "Runtime"。
    echo   装完把本窗口关掉，重新双击一次这个文件。
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('dotnet --version') do set DOTNETVER=%%i
echo   .NET SDK 版本：%DOTNETVER%
echo.
echo   正在编译（第一次会下载依赖，慢一点）...
echo.

dotnet publish -c Release -o "%~dp0publish"
if errorlevel 1 (
    echo.
    echo   [X] 编译失败。
    echo.
    echo   请把上面从 "error" 开头的那几行完整复制给我，
    echo   我来修。这份代码从来没编译过，有报错是正常的。
    echo.
    pause
    exit /b 1
)

echo.
echo   [OK] 编译通过
echo.
echo   程序在： %~dp0publish\HuanmengRing.exe
echo.
echo   双击它就能启动，托盘（右下角）会出现一个圆环图标。
echo   出问题点托盘图标 →「自检…」，它会告诉你哪儿不对。
echo.
pause
