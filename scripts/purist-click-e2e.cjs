// Windows integration regression. Build first; native mouse input requires an interactive desktop.
﻿const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const {spawn,execFileSync} = require('node:child_process')
const {connectRenderer, waitFor, stopRun} = require('./performance-suite.cjs')
const root = path.resolve(__dirname, '..')
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vast-purist-click-'))
async function main() {
  assert.equal(process.platform, 'win32', 'This test exercises Windows native drag-region hit testing')
  const server = http.createServer((_req,res)=>res.end('<!doctype html><title>Purist click fixture</title><p>Page content</p>'))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const data = structuredClone((await import(require('node:url').pathToFileURL(path.join(root,'src/shared/constants.ts')).href)).DEFAULT_DATA)
  data.settings.layoutMode = 'purist'
  data.settings.advanced.experimentalFeatures = true
  data.settings.advanced.confirmBeforeClosingManyTabs = false
  data.settings.openingAnimation = false
  const workspace = data.workspaces[0]
  data.activeWorkspaceId = workspace.id
  workspace.activeTabId = 'purist-click'
  data.tabs = [{id:'purist-click',workspaceId:workspace.id,title:'Fixture',url:origin,pinned:false,status:'idle',lifecycle:'active',progress:0,canGoBack:false,canGoForward:false,zoom:1,createdAt:1,lastAccessedAt:1}]
  fs.writeFileSync(path.join(profile,'vast-data.json'),JSON.stringify(data))
  const port = 9600 + Math.floor(Math.random()*200)
  const env = {...process.env,VAST_TEST_USER_DATA_DIR:profile,VAST_UPDATE_ENABLED:'0'}
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [path.join(root,'out/main/main.js'),`--remote-debugging-port=${port}`], {env,stdio:'ignore',windowsHide:true})
  let cdp
  const island = '[data-testid="purist-topbar-island"]'
  const input = 'input[placeholder="Search or enter address"]'
  async function click(selector) {
    await new Promise(resolve=>setTimeout(resolve,260))
    const point = await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing click target'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    const width = await cdp.evaluate('innerWidth')
    // Exercise Windows hit testing, including Electron's native drag regions.
    execFileSync('powershell', ['-NoProfile','-Command', `
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class PuristMouse { public delegate bool EnumProc(IntPtr h,IntPtr p); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr p); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n); public static IntPtr Find(uint pid) { IntPtr found=IntPtr.Zero; EnumWindows((h,p)=>{uint owner; GetWindowThreadProcessId(h,out owner); R r; GetClientRect(h,out r); var title=new System.Text.StringBuilder(512); GetWindowText(h,title,512); if(owner==pid && title.ToString()=="Vast" && r.r>500 && r.b>300) found=h; return true;},IntPtr.Zero); return found;} [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [StructLayout(LayoutKind.Sequential)] public struct P {public int x,y;} [StructLayout(LayoutKind.Sequential)] public struct R {public int l,t,r,b;} [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref P p); [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out R r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }';
      [PuristMouse]::SetProcessDPIAware() | Out-Null;
      $handle=[PuristMouse]::Find(${child.pid}); if ($handle -eq [IntPtr]::Zero) { throw "No Electron window for PID ${child.pid}" }; [PuristMouse]::ShowWindow($handle,5) | Out-Null;
      $origin=New-Object PuristMouse+P; $rect=New-Object PuristMouse+R;
      [PuristMouse]::ClientToScreen($handle,[ref]$origin) | Out-Null;
      [PuristMouse]::GetClientRect($handle,[ref]$rect) | Out-Null;
      $scale=($rect.r-$rect.l)/${width};
      [PuristMouse]::SetForegroundWindow($handle) | Out-Null;
      [PuristMouse]::SetCursorPos([int]($origin.x+${point.x}*$scale),[int]($origin.y+${point.y}*$scale)) | Out-Null;
      [PuristMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);
      Start-Sleep -Milliseconds 60;
      [PuristMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero);
    `], {encoding:'utf8'})
  }
  try {
    cdp = await connectRenderer(port)
    await cdp.evaluate(`window.__puristClicks=[]; for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>window.__puristClicks.push({type,x:e.clientX,y:e.clientY,target:e.target?.outerHTML?.slice(0,140)}),true)`)
    await waitFor(cdp, `[...document.querySelectorAll('webview')].some(v=>v.getURL().startsWith('${origin}') && !v.isLoading())`,30000)
    await waitFor(cdp, `document.querySelector('button[aria-label="Dismiss Vast message"]')`,15000)
    await cdp.evaluate(`document.querySelector('button[aria-label="Dismiss Vast message"]').click()`)
    await waitFor(cdp, `document.querySelector('${island}')?.dataset.state==='collapsed'`,30000)
    assert.equal(await cdp.evaluate(`getComputedStyle(document.querySelector('.purist-titlebar-row')).getPropertyValue('-webkit-app-region')`),'no-drag')
    assert.equal(await cdp.evaluate(`getComputedStyle(document.querySelector('.topbar-island-expanded')).visibility`),'hidden')
    for(let attempt=0;attempt<3;attempt++) {
      await click('.topbar-island-compact')
      await waitFor(cdp, `document.querySelector('${island}')?.dataset.state==='expanded' && document.activeElement===document.querySelector('${input}')`,3000)
      await click('button[title="More browser tools"]')
      await waitFor(cdp, `document.body.innerText.includes('Settings')`)
      await click('button[title="More browser tools"]')
      await waitFor(cdp, `!document.body.innerText.includes('Settings')`)
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'})
      await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'})
      await waitFor(cdp, `document.querySelector('${island}')?.dataset.state==='collapsed'`)
    }
    await click('.topbar-island-compact')
    await waitFor(cdp, `document.activeElement===document.querySelector('${input}')`,3000)
    await new Promise(resolve=>setTimeout(resolve,300))
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65})
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65})
    await cdp.send('Input.insertText',{text:origin+'/navigated'})
    assert.equal(await cdp.evaluate(`document.querySelector('${input}').value`),origin+'/navigated')
    await new Promise(resolve=>setTimeout(resolve,150))
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13})
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
    await waitFor(cdp, `[...document.querySelectorAll('webview')].some(v=>v.getURL().endsWith('/navigated'))`)
    console.log('PASS Purist coordinate clicks: compact -> address focus, toolbar menu, Escape/reopen x3, typed navigation; collapsed native drag regions disabled.')
  } catch(error) {
    if (!cdp) throw error
    fs.mkdirSync(path.join(root,'performance-results'),{recursive:true})
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'performance-results/purist-click-failure.png'),Buffer.from(shot.data,'base64'));
    console.log(await cdp.evaluate(`({urls:[...document.querySelectorAll('webview')].map(v=>v.getURL()),state:document.querySelector('${island}')?.dataset.state,focus:document.activeElement?.outerHTML.slice(0,250),events:window.__puristClicks,text:document.body.innerText.slice(-1000)})`));throw error
  } finally {
    if(cdp) await stopRun(child,cdp)
    else child.kill()
    server.closeAllConnections();server.close()
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
