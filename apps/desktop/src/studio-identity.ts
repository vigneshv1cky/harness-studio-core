/**
 * Harness Studio's own name and data locations for packaged builds. Imported first by the main entry so
 * they are in place before any module reads them; the Host inherits DSH_HOME. Neither location is shared
 * with an upstream DeepSeek Harness installation: Electron data goes to `<appData>/Harness Studio` and the
 * Harness home to `~/.harness-studio`. An explicit DSH_HOME wins.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

if (app.isPackaged) {
  app.setName('Harness Studio')
  const userData = join(app.getPath('appData'), 'Harness Studio')
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (process.env.DSH_HOME === undefined) process.env.DSH_HOME = join(homedir(), '.harness-studio')
}
