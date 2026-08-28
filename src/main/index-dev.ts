/**
 * This file is used specifically and only for development. It installs
 * `electron-debug` & `vue-devtools`. There shouldn't be any need to
 *  modify this file, but it can be used to extend your development
 *  environment.
 */

import { app, session } from 'electron'
import electronDebug from 'electron-debug'
import installExtension, { VUEJS_DEVTOOLS } from 'electron-devtools-installer'
import { openDevTools } from './utils'
// Install `electron-debug` with `devtron`
electronDebug({
  showDevTools: false,
  devToolsMode: 'undocked',
})

const installVueDevTools = (label: string, win: Electron.BrowserWindow) => {
  if (session.defaultSession.getAllExtensions().some(ext => ext.id == VUEJS_DEVTOOLS.id)) return
  installExtension(VUEJS_DEVTOOLS, { session: win.webContents.session })
    .then((name: string) => {
      console.log(`[${label}] Added Extension:  ${name}`)
    })
    .catch((err: Error) => {
      console.log(`[${label}] Failed to install Vue DevTools: ${err.message}`)
    })
}

// Install `vue-devtools`
app.on('ready', () => {
  global.lx.event_app.on('main_window_created', (win) => {
    openDevTools(win.webContents)
    installVueDevTools('main window', win)
  })
  global.lx.event_app.on('desktop_lyric_window_created', (win) => {
    openDevTools(win.webContents)
    installVueDevTools('lyric window', win)
  })
})

// Require `main` process to boot app
require('./index')

