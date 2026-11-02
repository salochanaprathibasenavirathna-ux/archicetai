const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

app.setAppUserModelId('com.blazey.architectai'); // Windows taskbar icon grouping

async function createWindow() {
  // Chat history is saved here (survives app restarts)
  process.env.ARCHITECTAI_DATA = path.join(app.getPath('userData'), 'data');
  const { startServer } = require('./server');
  const port = await startServer(0);
  const win = new BrowserWindow({
    width: 1400, height: 850, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117', autoHideMenuBar: true, title: 'ArchitectAI',
    icon: path.join(__dirname, 'build', 'icon.png')
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
