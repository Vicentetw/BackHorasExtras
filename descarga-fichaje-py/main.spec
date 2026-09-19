# -*- mode: python ; coding: utf-8 -*-

# sv_ttk (tema Sun Valley) es Tcl + assets: hay que copiar su carpeta de
# datos dentro del .exe o el tema no carga. collect_data_files la resuelve
# sola. Si el paquete no estuviera instalado, se sigue sin el (main.py
# tiene fallback a 'clam'), por eso el try/except -- que la falta de
# sv_ttk nunca rompa el build.
try:
    from PyInstaller.utils.hooks import collect_data_files
    _sv_ttk_datas = collect_data_files('sv_ttk')
except Exception:
    _sv_ttk_datas = []


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=_sv_ttk_datas,
    hiddenimports=['sv_ttk'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='main',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
