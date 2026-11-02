# ArchitectAI

ArchitectAI is a Windows desktop app that turns an app or website idea into a flowchart, code guidance, security insights, and an optional generated starter project.

## Download and use the desktop app

1. Open this repository's **Releases** page and download `ArchitectAI.exe` from the latest release.
2. Run the downloaded file on Windows. No Node.js installation is needed to use the release.
3. The first time you open it, create an account with a name and a password of at least 12 characters.
4. Add your own Gemini API key in the app when prompted. Get a key from [Google AI Studio](https://aistudio.google.com/apikey).
5. Describe your project idea or attach a requirements document. An internet connection is required for Gemini and the Mermaid diagram library.

The release executable is not code-signed. Windows SmartScreen may show an unknown-publisher warning; only download and run releases from this repository.

The app stores account and chat data locally on the computer. The API key is encrypted using a key derived from the account password. Do not forget your password: it is needed to decrypt saved data. Do not share your API key.

Existing accounts can keep using their current password, or change it from **Menu → Password**. Changing the password re-encrypts saved chats and the API key; use a strong password of at least 12 characters.

## Run from source

Requirements: [Node.js 22.12 or newer](https://nodejs.org/) and npm.

```powershell
npm ci
npm start
```

Run the automated server/authentication tests with `npm test`.

The app does not require a `.env` file or a shared API key. Enter each user's own Gemini API key inside the app. To optionally change the Gemini model, copy `.env.example` to `.env` and set `GEMINI_MODEL`.

To run the local web interface instead of the Electron desktop window:

```powershell
npm run web
```

Then open http://127.0.0.1:3000. The local web server binds to the loopback interface and is not intended to be exposed to the public internet.

## Build the Windows desktop app

Requirements: Windows, Node.js 22.12 or newer, and npm.

```powershell
npm ci
npm run build
```

The portable executable is created at `dist\ArchitectAI.exe`. You can also double-click `build-exe.bat`; it installs dependencies if needed and runs the same build.

## Publish a GitHub release

Releases are built and published automatically by GitHub Actions when a version tag is pushed:

1. Push the project to a GitHub repository. Do not upload `.env`, `node_modules`, `data`, or `dist`; `.gitignore` excludes these.
2. In `package.json` and `package-lock.json`, set the same new version number (for example, `1.3.1`).
3. Commit and push those changes to the default branch.
4. Create and push a matching version tag:

   ```powershell
   git tag v1.3.1
   git push origin v1.3.1
   ```

GitHub Actions builds the portable Windows executable and attaches `ArchitectAI.exe` to a GitHub Release with generated release notes. The workflow needs the repository's standard `GITHUB_TOKEN` with **Contents: read and write** permission; that permission is declared in `.github/workflows/release.yml`.

## Features

- Generate project flowcharts, implementation guidance, and security insights.
- Save and reopen chats locally; upload supported documents and wireframes.
- Generate a project code bundle and download it as a ZIP file.
- Export flowcharts as PNG or SVG.

User data for the desktop app is stored in Electron's per-user application data folder. In web mode, data is stored in the project's `data` folder. Do not commit or share either folder.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).
