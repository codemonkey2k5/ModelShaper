# ModelShaper

Teach a local AI model using your own notes and documents, on your own Windows PC. When training finishes, you get a chat file (`.gguf`) you can open in LM Studio, Ollama, KoboldCpp, Jan, and similar apps.

Your materials stay on your computer. ModelShaper does not upload them.

**License:** Free for **non-commercial** use when this project is made public. Commercial use needs permission from the author. See [LICENSE](LICENSE).

This GitHub repository is **private** until the owner publishes it.

## Screenshots

Add PNGs under `docs/screenshots/` using these filenames (full-window captures, nothing cut off):

| File | Page |
|------|------|
| `docs/screenshots/00-welcome-setup.png` | Welcome / first-time setup |
| `docs/screenshots/01-system-check.png` | System check |
| `docs/screenshots/02-choose-model.png` | Choose model |
| `docs/screenshots/03-describe-skill.png` | Describe skill |
| `docs/screenshots/04-add-materials.png` | Add materials |
| `docs/screenshots/05-review-plan.png` | Review plan |
| `docs/screenshots/06-train.png` | Train |
| `docs/screenshots/07-export.png` | Export |
| `docs/screenshots/08-help.png` | Help |
| `docs/screenshots/09-settings.png` | Settings |

After you drop the PNGs in place, uncomment these lines (or leave them as-is once the files exist):

```markdown
![Welcome / setup](docs/screenshots/00-welcome-setup.png)
![System check](docs/screenshots/01-system-check.png)
![Choose model](docs/screenshots/02-choose-model.png)
![Describe skill](docs/screenshots/03-describe-skill.png)
![Add materials](docs/screenshots/04-add-materials.png)
![Review plan](docs/screenshots/05-review-plan.png)
![Train](docs/screenshots/06-train.png)
![Export](docs/screenshots/07-export.png)
![Help](docs/screenshots/08-help.png)
![Settings](docs/screenshots/09-settings.png)
```

## Downloads (v0.2.11)

Pick **one** from [Releases](../../releases):

| File | Use this if |
|------|-------------|
| **ModelShaper-Setup.exe** | You want a normal Windows install (Start menu; data under your user profile) |
| **ModelShaper.msi** | Your IT prefers MSI installers |
| **ModelShaper.exe** | You want a portable app (put the EXE in any folder; data stays next to it) |

## What you need before you start

ModelShaper is the app window and workflow. Training uses tools that are too large to hide inside a small EXE, so a few things must already be on the PC.

### 1. Windows 10 or 11

Most PCs already have **WebView2** (it comes with Microsoft Edge). If the window will not open, install the Evergreen runtime:

- [WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/?form=MA13LH#download)

### 2. Python 3.10 or newer

1. Open [python.org/downloads](https://www.python.org/downloads/).
2. Download the latest **Windows installer (64-bit)**.
3. Run it.
4. On the first screen, check **Add python.exe to PATH**.
5. Click **Install Now** and finish.
6. Close and reopen any open terminals or apps.

To check it worked: open **Command Prompt**, type `python --version`, and press Enter. You should see something like `Python 3.12.x` or `3.13.x`.

### 3. NVIDIA graphics driver

Training needs an **NVIDIA** GPU.

1. Go to [NVIDIA Driver Downloads](https://www.nvidia.com/Download/index.aspx).
2. Choose your GPU (or use automatic detection).
3. Download and install the **Game Ready** or **Studio** driver.
4. Restart if Windows asks you to.

Optional check: open Command Prompt and run `nvidia-smi`. If you see a table with your GPU name, you are set.

### 4. Disk space and internet

- Several GB free for models and exports (an 8B model package is large).
- Internet for first-time setup (to add only missing training libraries) and for downloading models.

ModelShaper **will not** install a second copy of Python. It reuses the Python you installed and only adds packages that are still missing, after you approve setup.

## Install

### Option A: Setup installer

1. Download `ModelShaper-Setup.exe` from Releases.
2. Run it and follow the prompts.
3. Open **ModelShaper** from the Start menu.

Data (models, settings, engine pointer) defaults to:

`C:\Users\<you>\AppData\Local\ModelShaper\`

### Option B: MSI

1. Download `ModelShaper.msi`.
2. Double-click and finish the installer.
3. Open ModelShaper from the Start menu.

Same default data folder as the Setup installer.

### Option C: Portable EXE

1. Create a folder, for example `D:\ModelShaper\`.
2. Put `ModelShaper.exe` in that folder.
3. Double-click `ModelShaper.exe`.

Data defaults to folders **next to the EXE**: `models`, `presets`, `engine`, and `settings.json`. The portable app does not use the installer data folder unless you change paths in Settings.

## First setup (what you will see)

1. Open ModelShaper.
2. If this PC still needs linking, you get a **Welcome / setup** screen.
3. Click **Set up ModelShaper**.
4. Wait. You may see a download of a few GB if training libraries are not already installed. Keep the PC awake and online.
5. When it says you are ready, click **Continue**.

If setup says Python was not found, install Python with PATH checked (see above), then open ModelShaper again.

## Teaching a model (short path)

1. **System check** – confirm GPU memory looks sane.
2. **Choose model** – download a full package from the list, or pick a folder you already have. You need the full model package, not only a single `.gguf`.
3. **Describe the skill** – what should improve.
4. **Add materials** – paste text and/or attach files. If you paste from a website, delete ads, menus, and cookie banners first.
5. **Review** – power mode, train length, export folder, accept the terms.
6. **Train** – watch the log. You can pause or cancel. The PC stays usable (reduced priority).
7. **Export** – open the folder and load the `.gguf` in LM Studio or another chat app. Suggested chat settings are on that page (temperature about 0.65 is a good start).

Help inside the app includes a full **golf coach** example you can copy as a template for your own topic.

## Privacy

Documents, models, and training stay on your PC. ModelShaper does not send your materials to a cloud service.

## Version

Current release: **0.2.11**
