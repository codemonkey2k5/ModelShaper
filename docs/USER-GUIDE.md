# ModelShaper - simple guide

ModelShaper helps you teach a model you already have on your computer using your own notes and documents. When it finishes, you can use the result in apps like LM Studio or Ollama.

## What you need

ModelShaper.exe is the app. It does **not** include Python or the full GPU training stack (those are large).

Required on the PC:

- Windows 10 or 11 (WebView2; usually present with Edge / Windows 11)
- **Python 3.10+** from [python.org](https://www.python.org/downloads/) with **Add python.exe to PATH** checked
- An **NVIDIA** graphics card with a current driver (`nvidia-smi` works in a terminal)
- Internet for first-time setup (missing libraries only) and for downloading model packages
- Free disk space for models and exports

ModelShaper will **not** install a second Python. Setup reuses one already on this PC and only adds packages that are still missing.

## Standalone EXE vs installer

| Build | Where data lives by default |
|--------|-----------------------------|
| **ModelShaper.exe** (standalone) | Next to the EXE: `models`, `presets`, `engine`, `settings.json` |
| **Setup / MSI** | `%LocalAppData%\ModelShaper\` |

Settings can override those folders. Standalone does not use the installer’s model folder unless you point it there yourself.

## First time

1. Install Python and NVIDIA drivers if needed.
2. Open ModelShaper.
3. Click **Set up ModelShaper** and wait until it says you are ready.
4. Click **Continue**.

## Improving a model

1. Check that this computer looks OK.
2. Choose or download a full model package.
3. Describe what you want the model to get better at.
4. Add notes or documents (strip website ads and menus if you paste from the web).
5. Review the plan (Gentle / Balanced / Faster).
6. Start and wait. You can pause or cancel if you confirm.
7. Open the export folder and load the `.gguf` in LM Studio, Ollama, or similar.

## Privacy

Your documents and models stay on your computer. They are not uploaded by ModelShaper.
